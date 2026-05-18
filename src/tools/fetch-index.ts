import { z } from "zod";
import * as https from "https";
import * as http from "http";
import * as dns from "dns/promises";
import * as net from "net";
import { URL } from "url";
import { indexContent } from "../lib/db";
import { redactSecrets } from "../lib/redact";
import { autoChunk } from "../lib/chunker";

// We'll try to load turndown, fall back to basic HTML stripping
let TurndownService: any;
try {
  TurndownService = require("turndown");
} catch {
  TurndownService = null;
}

export const fetchIndexSchema = z.object({
  url: z.string().describe("The URL to fetch and index"),
  source: z
    .string()
    .optional()
    .describe("Label for the indexed content (e.g., 'React docs', 'API reference')"),
});

export type FetchIndexInput = z.infer<typeof fetchIndexSchema>;

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const FETCH_TIMEOUT_MS = 15_000;

/**
 * SSRF guard: reject IPs that point at the host's own network rather than
 * the public internet. Covers loopback, private RFC1918, link-local
 * (incl. the AWS/cloud metadata 169.254.169.254), multicast, reserved, and
 * the corresponding IPv6 ranges. Operators who *need* to fetch internal
 * URLs should run a separate, scoped tool — this MCP is for public docs.
 */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map((p) => parseInt(p, 10));
    if (Number.isNaN(a)) return true;
    if (a === 0) return true;            // 0.0.0.0/8
    if (a === 10) return true;           // 10.0.0.0/8 — RFC1918
    if (a === 127) return true;          // 127.0.0.0/8 — loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC1918
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918
    if (a === 192 && b === 0) return true;   // 192.0.0.0/24 — IETF reserved
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmark
    if (a >= 224) return true;           // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;        // loopback
    if (lower === "::") return true;         // unspecified
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA (fc00::/7)
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4
    const v4m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
    if (v4m) return isPrivateIp(v4m[1]);
    return false;
  }
  // Not an IP literal — assume safe (hostname; we resolve it before deciding)
  return false;
}

async function assertPublicHost(url: string): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`refused: only http(s) URLs are allowed (got ${u.protocol})`);
  }
  const host = u.hostname;
  // Hostname literal that's already an IP — check directly
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`refused: ${host} is in a private/loopback/reserved range (SSRF guard)`);
    }
    return;
  }
  // DNS resolution — any A or AAAA hitting a private range blocks the fetch
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateIp(r.address)) {
      throw new Error(`refused: ${host} resolves to ${r.address} (private/loopback/reserved — SSRF guard)`);
    }
  }
}

async function fetchOnce(url: string): Promise<{
  body?: string;
  contentType?: string;
  redirectTo?: string;
  status: number;
}> {
  await assertPublicHost(url);

  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Resolve relative redirects against the current URL
        const target = new URL(res.headers.location, url).toString();
        res.resume(); // drain
        return resolve({ status, redirectTo: target });
      }
      if (status >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const contentType = res.headers["content-type"] || "text/plain";
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        if (body.length < MAX_BODY_BYTES) body += chunk;
      });
      res.on("end", () => resolve({ status, body, contentType }));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

async function fetchUrl(url: string): Promise<{ body: string; contentType: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await fetchOnce(current);
    if (r.redirectTo) {
      current = r.redirectTo;
      continue;
    }
    return { body: r.body ?? "", contentType: r.contentType ?? "text/plain" };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
}

function htmlToMarkdown(html: string): string {
  if (TurndownService) {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
    });
    return td.turndown(html);
  }

  // Basic HTML stripping fallback
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function handleFetchIndex(args: FetchIndexInput) {
  try {
    const { body, contentType } = await fetchUrl(args.url);
    const source = args.source || args.url;

    let text: string;
    if (contentType.includes("html")) {
      text = htmlToMarkdown(body);
    } else {
      text = body;
    }

    const redacted = redactSecrets(text);
    const chunks = autoChunk(redacted, source, contentType);

    let indexed = 0;
    for (const chunk of chunks) {
      indexContent(source, chunk.label, chunk.content);
      indexed++;
    }

    // Return a preview (first 3KB)
    const preview = text.slice(0, 3000);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            url: args.url,
            source,
            content_type: contentType,
            total_bytes: Buffer.byteLength(text, "utf-8"),
            chunks_indexed: indexed,
            preview: preview + (text.length > 3000 ? "\n\n[...truncated — use ctx_search for full content]" : ""),
          }),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            url: args.url,
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      ],
    };
  }
}
