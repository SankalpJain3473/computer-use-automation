const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|ssn|ss_number|creditcard|cvv|cvc)/i;
const PARTIAL_MASK_KEY_PATTERN = /(memberid|member_id|accountnumber|account_number)/i;
const SSN_LIKE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/g;
// Account-number-like runs in free text; amounts and timestamps never reach 6 digits in a row.
const ACCOUNT_LIKE = /\b\d{6,12}\b/g;

export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(name) || PARTIAL_MASK_KEY_PATTERN.test(name);
}

export function sensitiveValues(
  inputParams: { name: string; sensitive?: boolean }[],
  params: Record<string, unknown>
): string[] {
  return inputParams
    .filter((p) => p.sensitive ?? isSensitiveKey(p.name))
    .map((p) => params[p.name])
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String);
}

function maskKeepLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 4) return digits;
  return "*".repeat(digits.length - 4) + digits.slice(-4);
}

export function redactString(input: string): string {
  return input
    .replace(SSN_LIKE, "***-**-****")
    .replace(CARD_LIKE, (m) => maskKeepLast4(m))
    .replace(ACCOUNT_LIKE, (m) => maskKeepLast4(m));
}

export function redactValue(key: string, value: unknown): unknown {
  if (typeof value === "number" && (SENSITIVE_KEY_PATTERN.test(key) || PARTIAL_MASK_KEY_PATTERN.test(key))) {
    return redactValue(key, String(value));
  }
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
    if (PARTIAL_MASK_KEY_PATTERN.test(key)) return maskKeepLast4(value);
    return redactString(value);
  }
  return value;
}

// Catches known sensitive values inside free text, where key-based rules can't see them.
export function maskKnownValues<T>(obj: T, values: string[]): T {
  const targets = values.filter((v) => v && v.replace(/\D/g, "").length >= 4);
  if (!targets.length) return obj;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return targets.reduce((s, t) => s.split(t).join(maskKeepLast4(t)), v);
    if (typeof v === "number" && targets.includes(String(v))) return maskKeepLast4(String(v));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj) as T;
}

export function redactDeep<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v)) as unknown as T;
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        out[k] = redactDeep(v);
      } else {
        out[k] = redactValue(k, v);
      }
    }
    return out as T;
  }
  return obj;
}
