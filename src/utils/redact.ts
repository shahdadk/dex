const SENSITIVE_KEY = /(?:token|key|secret|password|auth|cookie|credential)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENV_SECRET = /\b[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE)\s*=\s*[^\s]+/g;

export function redactString(value: string): string {
  return value.replace(BEARER, "Bearer [REDACTED]").replace(ENV_SECRET, "[REDACTED_ENV]");
}

export function redact<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item),
      ]),
    ) as T;
  }
  return value;
}
