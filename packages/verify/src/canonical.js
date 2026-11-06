// RFC 8785 (JCS) canonical JSON. Sorting keys by UTF-16 code units and serialising with
// JSON.stringify matches JCS for every value JSON can represent; anything else is rejected
// so two implementations can never disagree silently.

const isPlainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const normalise = (value, path) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonical: non-finite number at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => normalise(item, `${path}[${i}]`));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`canonical: undefined at ${path}.${key}`);
      out[key] = normalise(value[key], `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`canonical: unsupported ${typeof value} at ${path}`);
};

export const canonicalString = value => JSON.stringify(normalise(value, '$'));

export const canonicalBytes = value => new TextEncoder().encode(canonicalString(value));
