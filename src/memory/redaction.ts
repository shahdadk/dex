const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|key|token|private[_-]?key|credential|cookie|session[_-]?token)(?:$|[_-])/i;
const SAFE_SECRET_PLACEHOLDER = /^\[(?:REDACTED|REDACTED_[A-Z_]+)\]$/;

interface SecretPattern {
  name: string;
  expression: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private-key",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  { name: "bearer-token", expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { name: "github-token", expression: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g },
  { name: "aws-access-key", expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack-token", expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", expression: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "provider-api-key", expression: /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}\b/g },
  {
    name: "secret-assignment",
    expression: /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIALS?)\s*=\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/g,
  },
  {
    name: "url-credentials",
    expression: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  },
];

export interface SecretFinding {
  path: string;
  kind: string;
}

function redactStringInternal(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern.expression, (match) => {
      if (pattern.name === "bearer-token") return "Bearer [REDACTED]";
      if (pattern.name === "url-credentials") {
        return match.replace(/\/\/[^/]+@/, "//[REDACTED]@");
      }
      return REDACTED;
    });
  }
  return redacted;
}

export function redactMemoryString(value: string): string {
  return redactStringInternal(value);
}

export function redactMemoryValue<T>(value: T): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactStringInternal(current);
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key) ? REDACTED : visit(item),
        ]),
      );
    }
    return current;
  };
  return visit(value) as T;
}

export function scanForSecrets(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const visit = (current: unknown, currentPath: string): void => {
    if (typeof current === "string") {
      if (SAFE_SECRET_PLACEHOLDER.test(current)) return;
      for (const pattern of SECRET_PATTERNS) {
        pattern.expression.lastIndex = 0;
        if (pattern.expression.test(current)) {
          findings.push({ path: currentPath, kind: pattern.name });
        }
        pattern.expression.lastIndex = 0;
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        const itemPath = currentPath ? `${currentPath}.${key}` : key;
        if (
          SENSITIVE_KEY.test(key) &&
          typeof item === "string" &&
          item.length > 0 &&
          !SAFE_SECRET_PLACEHOLDER.test(item)
        ) {
          findings.push({ path: itemPath, kind: "sensitive-field" });
          continue;
        }
        visit(item, itemPath);
      }
    }
  };

  visit(value, "$");
  return findings;
}

export function assertNoSecrets(value: unknown): void {
  const findings = scanForSecrets(value);
  if (findings.length === 0) return;
  const locations = findings.map((finding) => `${finding.kind} at ${finding.path}`).join(", ");
  throw new Error(`Secret scan rejected handoff content: ${locations}`);
}

export function redactAndScan<T>(value: T): T {
  const redacted = redactMemoryValue(value);
  assertNoSecrets(redacted);
  return redacted;
}

export const redactSecrets = redactMemoryValue;
