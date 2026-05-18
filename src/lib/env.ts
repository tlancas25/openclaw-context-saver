import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Path resolution for Context Cooler's on-disk data (sqlite DBs, FTS index,
// optional .env file, optional skills dir).
//
// Precedence:
//   1. CONTEXT_COOLER_HOME env var          (new, preferred)
//   2. OPENCLAW_HOME env var                (back-compat — historical name)
//   3. ~/.context-cooler if it exists       (new default location)
//   4. ~/.openclaw      if it exists        (legacy default — keep working
//                                            for existing installs)
//   5. ~/.context-cooler                    (created on first use)
//
// Resolution is cached for the life of the process.

let _dataHome: string | null = null;
let _envLoaded = false;

export function getDataHome(): string {
  if (_dataHome) return _dataHome;
  const fromEnv = process.env.CONTEXT_COOLER_HOME || process.env.OPENCLAW_HOME;
  if (fromEnv) {
    _dataHome = fromEnv;
    return _dataHome;
  }
  const newDefault = path.join(os.homedir(), ".context-cooler");
  const legacyDefault = path.join(os.homedir(), ".openclaw");
  if (!fs.existsSync(newDefault) && fs.existsSync(legacyDefault)) {
    _dataHome = legacyDefault;
    return _dataHome;
  }
  _dataHome = newDefault;
  return _dataHome;
}

// Legacy export retained so older imports still type-check during migration.
// New code should call getDataHome.
export const getOpenClawHome = getDataHome;

export function getContextDir(): string {
  const dir = path.join(getDataHome(), "context");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSkillsDir(): string {
  return path.join(getDataHome(), "workspace", "skills");
}

export function loadEnv(): Record<string, string> {
  if (_envLoaded) return process.env as Record<string, string>;

  const envPath = path.join(getDataHome(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
  _envLoaded = true;
  return process.env as Record<string, string>;
}

export function getSnapshotBudget(): number {
  const budget = parseInt(process.env.CTX_SNAPSHOT_BUDGET || "2048", 10);
  return Math.min(Math.max(budget, 256), 65536);
}

export function isFtsEnabled(): boolean {
  return process.env.CTX_FTS_ENABLED !== "0";
}
