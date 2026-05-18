import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SupportedLanguage } from "../types";

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT = 100 * 1024 * 1024; // 100MB cap

// Dangerous env vars to strip from subprocess
const ENV_DENYLIST = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_FUNC_",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "PERL5LIB",
  "GOFLAGS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  duration: number;
}

function sanitizeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    let denied = false;
    for (const deny of ENV_DENYLIST) {
      if (key === deny || key.startsWith(deny)) {
        denied = true;
        break;
      }
    }
    if (!denied) {
      env[key] = value;
    }
  }
  return env;
}

export async function executeCode(
  language: SupportedLanguage,
  code: string,
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string
): Promise<SandboxResult> {
  const start = Date.now();
  const env = sanitizeEnv();

  const { cmd, args, cleanup } = buildCommand(language, code);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn(cmd, args, {
      cwd: cwd || os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      timeout: undefined, // We handle timeout ourselves
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) {
        try {
          // Kill process group on Unix
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }
      }
    }, timeout);

    proc.stdout.on("data", (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += data.toString();
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
      }
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cleanup) cleanup();
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        duration: Date.now() - start,
      });
    };

    proc.on("close", (code) => finish(code));
    proc.on("error", (err) => {
      stderr += `\nSpawn error: ${err.message}`;
      finish(1);
    });
  });
}

export async function executeShellCommand(
  command: string,
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string
): Promise<SandboxResult> {
  return executeCode("shell", command, timeout, cwd);
}

/**
 * Run an explicit argv vector — no shell, no interpolation, no metachar
 * interpretation. Use this whenever the command line contains values that
 * came from outside the server (skill names, agent-supplied args, etc.) so
 * that prompt injection cannot escalate to command injection on the host.
 */
export async function executeArgv(
  cmd: string,
  args: string[],
  timeout: number = DEFAULT_TIMEOUT,
  cwd?: string
): Promise<SandboxResult> {
  const start = Date.now();
  const env = sanitizeEnv();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn(cmd, args, {
      cwd: cwd || os.tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        }
      }
    }, timeout);

    proc.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        duration: Date.now() - start,
      });
    };

    proc.on("close", (code) => finish(code));
    proc.on("error", (err) => {
      stderr += `\nSpawn error: ${err.message}`;
      finish(1);
    });
  });
}

/**
 * Split a CLI-style command string into argv tokens. Handles single and
 * double-quoted segments and backslash escapes. Returns [] if the input is
 * empty/whitespace. NOT a full POSIX parser — no variable expansion, no
 * command substitution, no globbing. That's intentional: this is fed into
 * spawn() with shell=false so metachars are never interpreted.
 */
export function parseArgvString(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { cur += ch; escape = false; continue; }
    if (ch === "\\" && quote !== "'") { escape = true; continue; }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch as '"' | "'"; continue; }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

interface CommandSpec {
  cmd: string;
  args: string[];
  cleanup?: () => void;
}

function buildCommand(language: SupportedLanguage, code: string): CommandSpec {
  switch (language) {
    case "javascript":
      return { cmd: "node", args: ["-e", code] };
    case "typescript":
      return { cmd: "npx", args: ["tsx", "-e", code] };
    case "python":
      return { cmd: "python3", args: ["-c", code] };
    case "shell":
      return { cmd: "bash", args: ["-c", code] };
    case "ruby":
      return { cmd: "ruby", args: ["-e", code] };
    case "php":
      return { cmd: "php", args: ["-r", code] };
    case "perl":
      return { cmd: "perl", args: ["-e", code] };
    case "r":
      return { cmd: "Rscript", args: ["-e", code] };
    case "elixir":
      return { cmd: "elixir", args: ["-e", code] };
    case "go": {
      // Go requires writing to a temp file. Use a per-call mkdtemp dir so two
      // parallel ctx_execute calls can't clobber each other and so the file
      // name isn't predictable from wall-clock time.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-go-"));
      const tmpFile = path.join(dir, "main.go");
      fs.writeFileSync(tmpFile, code);
      return {
        cmd: "go",
        args: ["run", tmpFile],
        cleanup: () => {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
      };
    }
    case "rust": {
      // Rust needs compile-then-run. Use a per-call mkdtemp dir; the bin and
      // source paths come from mkdtempSync (random suffix, no user-controlled
      // chars) so the bash -c interpolation here is bounded to safe values.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-rs-"));
      const srcFile = path.join(dir, "main.rs");
      const binFile = path.join(dir, "main");
      fs.writeFileSync(srcFile, code);
      return {
        cmd: "bash",
        args: [
          "-c",
          `rustc --edition 2021 -o "${binFile}" "${srcFile}" && "${binFile}"`,
        ],
        cleanup: () => {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
      };
    }
    default:
      return { cmd: "bash", args: ["-c", code] };
  }
}

export function findSkillScript(skillName: string): string | null {
  // Validate skill name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(skillName)) {
    return null;
  }

  const skillsDir = path.join(
    process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw"),
    "workspace",
    "skills",
    skillName,
    "scripts"
  );

  if (!fs.existsSync(skillsDir)) return null;

  // Priority order for script discovery
  const candidates = [
    `${skillName.replace(/-/g, "_")}_cli.py`,
    "cli.py",
    "main.py",
    `${skillName.replace(/-/g, "_")}.py`,
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(skillsDir, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }

  // Fallback: first .py file alphabetically
  try {
    const files = fs
      .readdirSync(skillsDir)
      .filter((f) => f.endsWith(".py"))
      .sort();
    if (files.length > 0) {
      return path.join(skillsDir, files[0]);
    }
  } catch {
    /* ignore */
  }

  return null;
}
