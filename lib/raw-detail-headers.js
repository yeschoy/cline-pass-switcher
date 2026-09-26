// Raw detail headers are deliberately NOT a generic sanitizer. Only these
// structural names and three fixed, recognizable credential names survive;
// custom, URL and proxy headers are omitted. Credential values are ALWAYS
// redacted, even if they resemble safe structural values. No body scan is involved.
const STRUCTURAL = new Set(['content-type', 'content-length', 'accept', 'content-encoding', 'transfer-encoding']);
const CREDENTIAL = new Set(['authorization', 'cookie', 'set-cookie']);
const NAMES = new Set([...STRUCTURAL, ...CREDENTIAL]);
const REDACTED = '[REDACTED]';
const MEDIA = new Set(['application/json', 'text/event-stream', 'text/plain']);
const ENCODING = new Set(['gzip', 'br', 'deflate', 'identity']);
const TRANSFER = new Set(['chunked', 'identity']);
const safeValue = (name, value) => {
  if (CREDENTIAL.has(name) || typeof value !== 'string' || value.length > 32) return REDACTED;
  if (name === 'content-length') return /^(?:0|[1-9][0-9]{0,8})$/.test(value) ? value : REDACTED;
  if (name === 'content-type' || name === 'accept') {
    if (MEDIA.has(value)) return value;
    if (name === 'content-type' && /^(?:application\/json|text\/event-stream|text\/plain); charset=utf-8$/i.test(value)) return value.slice(0, value.indexOf(';')).toLowerCase();
    return REDACTED;
  }
  if (name === 'content-encoding') return ENCODING.has(value) ? value : REDACTED;
  return TRANSFER.has(value) ? value : REDACTED;
};

// At most 64 source names/128 native pairs are examined. Ambiguous duplicate
// names or arrays lose their value, including duplicates hidden by Node's
// normalized IncomingMessage.headers. Do not stringify unknown values.
export function projectRawHeaders(headers, nativePairs) {
  const result = Object.create(null);
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return result;
  const keys = Object.keys(headers);
  if (keys.length > 64 || nativePairs && (!Array.isArray(nativePairs) || nativePairs.length > 256 || nativePairs.length % 2)) return result;
  const counts = new Map();
  if (nativePairs) for (let i = 0; i < nativePairs.length; i += 2) {
    const key = nativePairs[i];
    if (typeof key !== 'string' || key.length > 32) continue;
    const name = key.toLowerCase();
    if (NAMES.has(name)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const key of keys) {
    if (key.length > 32 || !/^[a-z-]+$/i.test(key)) continue;
    const name = key.toLowerCase();
    if (!NAMES.has(name)) continue;
    const value = CREDENTIAL.has(name) ? REDACTED : headers[key];
    result[name] = Object.hasOwn(result, name) || Array.isArray(value) || nativePairs && counts.get(name) !== 1
      ? REDACTED : safeValue(name, value);
  }
  return result;
}

// writeHead can supply additional/overriding headers as either an object or
// native pairs. Project each bounded source before merging: never retain an
// unprojected downstream Header map in a raw root.
export function projectRawResponseHeaders(implicit, explicit) {
  const implicitCount = implicit && typeof implicit === 'object' && !Array.isArray(implicit) ? Object.keys(implicit).length : 0;
  const explicitCount = Array.isArray(explicit) ? explicit.length / 2 : explicit && typeof explicit === 'object' ? Object.keys(explicit).length : 0;
  if (implicitCount + explicitCount > 64 || Array.isArray(explicit) && (explicit.length > 256 || explicit.length % 2)) return Object.create(null);
  const result = projectRawHeaders(implicit);
  if (explicit === undefined || explicit === null) return result;
  if (Array.isArray(explicit)) {
    const selected = Object.create(null);
    for (let i = 0; i < explicit.length; i += 2) {
      const key = explicit[i];
      if (typeof key !== 'string' || key.length > 32) continue;
      const name = key.toLowerCase();
      if (NAMES.has(name)) selected[name] = CREDENTIAL.has(name) || Object.hasOwn(selected, name) ? REDACTED : explicit[i + 1];
    }
    Object.assign(result, projectRawHeaders(selected, explicit));
  } else Object.assign(result, projectRawHeaders(explicit));
  return result;
}

// Also used by the store on publication AND reads. Old raw records may omit
// the map; present maps must be canonical and cannot smuggle extra fields.
export function validRawHeaders(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= NAMES.size &&
    Object.keys(value).every((name) => NAMES.has(name) && typeof value[name] === 'string' &&
      (CREDENTIAL.has(name) ? value[name] === REDACTED : value[name] === REDACTED || safeValue(name, value[name]) === value[name]));
}
