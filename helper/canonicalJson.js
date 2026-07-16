// Canonical JSON (RFC 8785-ish): sorted object keys, no insignificant
// whitespace. Used as the byte-level target for signing + hashing so the
// backend, frontend, and auditors produce identical bytes from the same
// logical object.

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return `{${parts.join(',')}}`;
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}
