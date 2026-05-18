/**
 * Best-effort secret redaction for output that's about to leave the
 * sandbox. Regex-based, so it WILL miss exotic formats and MAY false-positive
 * on long random-looking strings. Treat as defence-in-depth, not a guarantee:
 * callers that handle credentials should pass `redact: false` (or use a
 * dedicated secrets pipeline) and assume nothing they emit is safe.
 */

const SECRET_PATTERNS: RegExp[] = [
  // API keys, secrets, tokens, passwords in key=value or key: value form
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|bearer|password|passwd|pwd|auth[_-]?token)[\s:=]+["']?([A-Za-z0-9_\-/.+]{16,})["']?/gi,
  // Stripe keys
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
  // Alpaca keys
  /(?:PK|SK|AK)[A-Z0-9]{16,}/g,
  // Bearer tokens in headers
  /Bearer\s+[A-Za-z0-9_\-/.+=]{20,}/gi,
  // JWTs — header.payload.signature
  /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  // GitHub PATs / OAuth / server-to-server tokens (modern format)
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g,
  // GitHub fine-grained PATs
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  // Slack tokens
  /\bxox[abporst]-[A-Za-z0-9-]{10,}/g,
  // Discord bot tokens (3-part, dot-separated, b64-ish)
  /\b[MN][A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,38}\b/g,
  // AWS access key IDs
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
  // PEM-armored private keys (any flavour) — collapse the whole block
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP |PRIVATE )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP |PRIVATE )?PRIVATE KEY-----/g,
  // Connection strings with embedded credentials
  /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|amqps|mssql|oracle):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/g,
  // Generic hex secrets (64+ chars, like SHA256-as-secret)
  /(?:secret|token|key|password|api[_-]?key)\s*[:=]\s*[0-9a-f]{64,}/gi,
];

export interface RedactionResult {
  text: string;
  hits: number;
}

export function redactSecrets(text: string): string {
  return redactSecretsDetailed(text).text;
}

export function redactSecretsDetailed(text: string): RedactionResult {
  let result = text;
  let hits = 0;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      hits++;
      // Keep a short prefix so an operator scanning the output can see WHICH
      // credential leaked (helps revocation) without exposing the full value.
      if (match.length > 12) {
        return match.slice(0, 8) + "[REDACTED]";
      }
      return "[REDACTED]";
    });
  }
  return { text: result, hits };
}
