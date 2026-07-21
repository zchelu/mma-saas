// Shared input-validation helpers for Convex mutations. Convex's v.* arg
// validators already reject wrong types and unknown fields at the RPC layer
// (that's real, load-bearing sanitization) — these cover what v.string()/
// v.number() can't: value-level bounds (length, format, range) that stop a
// well-typed but oversized or malformed payload from a direct API call.

export function assertMaxLength(value: string | undefined, max: number, field: string): void {
  if (value !== undefined && value.length > max) {
    throw new Error(`${field} is too long (max ${max} characters).`);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmailFormat(value: string | undefined, field: string): void {
  if (value !== undefined && value.length > 0 && !EMAIL_RE.test(value)) {
    throw new Error(`${field} is not a valid email address.`);
  }
}

export function assertInRange(value: number, min: number, max: number, field: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
}

export function assertMaxArrayLength<T>(value: T[], max: number, field: string): void {
  if (value.length > max) {
    throw new Error(`${field} has too many items (max ${max}).`);
  }
}
