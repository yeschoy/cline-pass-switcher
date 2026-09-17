import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { finished, Transform } from 'node:stream';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const detailContext = new AsyncLocalStorage();
const REDACTED = '[REDACTED]';
const normalizeCredentialName = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[_. ]/g, '-');
const credentialName = (name) => {
  const normalized = normalizeCredentialName(name);
  return normalized === 'key' || /(?:^|-)(?:authorization|authentication|cookies?|password|passwd|secrets?|credentials?|token|(?:api|admin|access|refresh|private|secret)-?key)$/.test(normalized);
};
const encodedSecret = (value) => { try { return encodeURIComponent(value); } catch { return encodeURIComponent(Buffer.from(value).toString('utf8')); } };
const ESCAPED_CODE_UNIT = /\\(?:u[0-9a-f]{4}|x[0-9a-f]{2})/i;
// One decoded view matches the complete JSON/header representation boundary.
// Nested escape layers are ambiguous and retain the existing group-wide fence.
const MAX_ESCAPE_DECODE_PASSES = 1;
const escapedVariants = (value) => {
  const variants = [String(value)];
  for (let i = 0; i < MAX_ESCAPE_DECODE_PASSES && ESCAPED_CODE_UNIT.test(variants.at(-1)); i++) {
    const decoded = variants.at(-1).replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2}))/gi, (_, unicode, hex) => String.fromCharCode(Number.parseInt(unicode || hex, 16)));
    if (decoded === variants.at(-1)) break;
    variants.push(decoded);
  }
  return { variants, complete: !ESCAPED_CODE_UNIT.test(variants.at(-1)) };
};

// This budget bounds retained payload bytes, not total V8 RSS. Reserve raw plus
// encoded publication space before copying, including while a slow writer runs.
export class CaptureBudget {
  constructor(limit = MAX_PAYLOAD_BYTES) { this.limit = limit; this.used = 0; this.dropped = 0; }
  reserve(bytes) { if (this.used + bytes > this.limit) { this.dropped++; return false; } this.used += bytes; return true; }
  release(bytes) { this.used -= bytes; }
}
export const captureBudget = new CaptureBudget();

export class DetailRedactor {
  constructor(secrets = []) { this.secrets = new Set(); this.secretBytes = 0; this.limited = false; this.unsafe = false; this.visited = 0; for (const secret of secrets) { this.add(secret); this.url(secret); } }
  escaped(value) {
    const decoded = escapedVariants(value);
    if (!decoded.complete) this.unsafe = true;
    return decoded;
  }
  isCredentialName(value) {
    const decoded = this.escaped(value);
    return !decoded.complete || decoded.variants.some((name) => credentialName(name));
  }
  add(value) {
    if (typeof value !== 'string' || !value) return;
    const seeds = [value]; try { seeds.push(decodeURIComponent(value)); } catch {}
    const forms = new Set();
    for (const seed of seeds) {
      const decoded = this.escaped(seed);
      for (const form of decoded.variants) forms.add(form);
    }
    for (const form of forms) if (!this.secrets.has(form)) {
      const bytes = Buffer.byteLength(form);
      if (this.secrets.size >= 256 || this.secretBytes + bytes > 64 * 1024) { this.limited = true; return; }
      this.secrets.add(form); this.secretBytes += bytes; this.pattern = null;
    }
  }
  url(value, partial = false) {
    try {
      const u = new URL(value);
      if (u.username) { this.unsafe ||= partial; this.add(u.username); u.username = REDACTED; }
      if (u.password) { this.unsafe ||= partial; this.add(u.password); u.password = REDACTED; }
      for (const [key, v] of [...u.searchParams]) if (this.isCredentialName(key)) { this.unsafe ||= partial; this.add(v); u.searchParams.set(key, REDACTED); }
      return u.toString();
    } catch {
      if (!/^(?:https?|socks5h?):\/\//i.test(String(value))) return value;
      this.unsafe ||= partial;
      const credentials = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(value)?.[1];
      if (credentials) { this.add(credentials); for (const part of credentials.split(':')) this.add(part); }
      for (const [key, secret] of new URLSearchParams(String(value).split('?')[1]?.split('#')[0] || '')) if (this.isCredentialName(key)) this.add(secret);
      return '[OMITTED: malformed URL]';
    }
  }
  learnHeaders(headers, discoverWrapped = true) {
    for (const [key, value] of Object.entries(headers || {})) if (this.isCredentialName(key)) {
      const normalizedKey = normalizeCredentialName(this.escaped(key).variants.at(-1));
      for (const v of Array.isArray(value) ? value : [String(value)]) {
        const credential = v.replace(/^(Bearer|Basic)\s+/i, '');
        this.add(v); this.url(v); this.add(credential);
        if (credential !== v) { this.url(credential); if (discoverWrapped) this.text(credential); }
        if (/^Basic\s+/i.test(v)) { const decoded = Buffer.from(v.replace(/^Basic\s+/i, ''), 'base64').toString(); this.add(decoded); for (const part of decoded.split(':')) this.add(part); }
        if (/cookie/.test(normalizedKey)) for (const part of (/(?:^|-)set-cookies?$/.test(normalizedKey) ? v.split(';').slice(0, 1) : v.split(';'))) if (part.includes('=')) {
          const secret = part.slice(part.indexOf('=') + 1).trim(); this.add(secret);
          // RFC 6265 quoted cookie-octets: retain raw learning and also scrub
          // bare component echoes, without treating Set-Cookie attributes as keys.
          const quoted = /^"([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)"$/.exec(secret);
          if (quoted) this.add(quoted[1]);
        }
      }
    }
    // Ordinary headers can carry credential URLs or prose assignments too. Learn
    // all of them before projecting any earlier header or cross-body echo.
    for (const [key, value] of Object.entries(headers || {})) if (!this.isCredentialName(key)) {
      for (const v of Array.isArray(value) ? value : [String(value)]) this.text(v);
    }
  }
  learn(value, depth = 0) {
    if (!value || typeof value !== 'object' || this.limited) return;
    if (depth > 64) { this.limited = true; return; }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++this.visited > 16384) { this.limited = true; return; }
      const v = value[key];
      if (this.isCredentialName(key)) {
        // Discover the same Bearer/Basic/Cookie components as headers before
        // replacing the structured field, so earlier and cross-body echoes scrub.
        const learnSecret = (secret, level = 0) => { if (this.limited) return; if (level > 64 || ++this.visited > 16384) { this.limited = true; return; } if (secret !== null && typeof secret !== 'object') this.learnHeaders({ [key]: String(secret) }); else if (secret && typeof secret === 'object') for (const key in secret) if (Object.hasOwn(secret, key)) learnSecret(secret[key], level + 1); };
        learnSecret(v);
      }
      if (typeof v === 'string') this.url(v);
      else this.learn(v, depth + 1);
    }
  }
  text(value, partial = false, discoverEscapes = true) {
    const text = String(value);
    if (this.unsafe) return '[OMITTED: incomplete credential discovery]';
    if (this.limited || text.length > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
    // A partial literal escape may be only a credential prefix, so it keeps the
    // existing group-wide fence. Complete text is handled after raw discovery:
    // ordinary code escapes stay readable, while decoded credentials are learned.
    if (partial && ESCAPED_CODE_UNIT.test(text)) { this.unsafe = true; return '[OMITTED: ambiguous escaped text]'; }
    // Discover original syntax before known-value substitution can destroy a
    // URL scheme, query key or Bearer marker. URLs own their query assignments.
    const tokens = /(?<url>(?:https?|socks5h?):\/\/[^\s<>"']+)|\b(?<scheme>Bearer|Basic)\s+(?<credential>[^\s"',;<>]+)|(?<![\w.-])(?<quote>["']?)(?<name>[\w.-]+)\k<quote>\s*[:=]\s*/gi;
    const assignmentValue = /(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\n,;]*)/y;
    const parts = []; let end = 0, size = 0, count = 0, valueWork = 0, token;
    while ((token = tokens.exec(text))) {
      if (++count > 16384) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
      const { url, scheme, credential, name } = token.groups;
      let start = token.index, stop = tokens.lastIndex, replacement;
      if (url) replacement = this.url(url, partial && tokens.lastIndex === text.length);
      else if (scheme) {
        if (partial && tokens.lastIndex === text.length) this.unsafe = true;
        // The outer loop resumes at the original credential and owns its one
        // bounded inner scan; do not recursively scan the same Bearer token here.
        if (credential !== REDACTED) this.learnHeaders({ Authorization: token[0] }, false);
        replacement = `${scheme} ${REDACTED}`;
        // Keep the outer output span, but discover inner original syntax too.
        // This starts after the scheme, so match starts still strictly advance.
        tokens.lastIndex = stop - credential.length;
      } else {
        if (!this.isCredentialName(name)) continue;
        start = tokens.lastIndex; assignmentValue.lastIndex = start;
        const value = assignmentValue.exec(text)[0]; stop = assignmentValue.lastIndex;
        valueWork += value.length;
        if (valueWork > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
        if (partial && stop === text.length && !/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.test(value)) this.unsafe = true;
        let secret = value.replace(/^["']|["']$/g, ''); try { if (value.startsWith('"')) secret = JSON.parse(value); } catch {}
        this.learnHeaders({ [name]: secret });
        if (!/["']/.test(value[0] || '')) this.add(secret.split(/\s/, 1)[0]);
        replacement = REDACTED;
      }
      if (this.limited) return '[OMITTED: redaction resource limit]';
      // Still discover tokens inside a credential value, but merge overlapping
      // redaction spans. Bound their total scan work instead of rebuilding text.
      if (start < end) { end = Math.max(end, stop); continue; }
      const nextSize = size + start - end + replacement.length;
      if (nextSize > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
      parts.push(text.slice(end, start), replacement); size = nextSize; end = stop;
    }
    if (size + text.length - end > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
    parts.push(text.slice(end));
    if (this.unsafe) return '[OMITTED: incomplete credential discovery]';
    const candidate = parts.join('');
    if (discoverEscapes && ESCAPED_CODE_UNIT.test(candidate)) {
      const decoded = this.escaped(candidate);
      if (!decoded.complete) return '[OMITTED: incomplete credential discovery]';
      for (const variant of decoded.variants.slice(1)) {
        const projected = this.text(variant, partial, false);
        if (this.unsafe) return '[OMITTED: incomplete credential discovery]';
        if (this.limited) return '[OMITTED: redaction resource limit]';
        if (projected !== variant) return '[OMITTED: ambiguous escaped credential]';
      }
    }
    return this.known(candidate);
  }
  known(text) {
    if (this.limited || text.length > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
    if (!this.secrets.size) return text;
    if (!this.pattern) {
      const forms = new Set([REDACTED]);
      for (const secret of this.secrets) for (const form of [secret, encodedSecret(secret), JSON.stringify(secret).slice(1, -1)]) forms.add(form);
      try { this.pattern = new RegExp([...forms].sort((a, b) => b.length - a.length).map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'); }
      catch { this.limited = true; return '[OMITTED: redaction resource limit]'; }
    }
    // Match only original input. Whole markers also match, protecting them on
    // later passes without feeding newly generated text back into replacement.
    this.pattern.lastIndex = 0;
    const parts = []; let end = 0, size = 0, count = 0, match;
    while ((match = this.pattern.exec(text))) {
      const nextSize = size + match.index - end + REDACTED.length;
      // Check before retaining slices: neither matches nor output can build an
      // unbounded split/replace array, even for one-character credentials.
      if (++count > 16384 || nextSize > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
      parts.push(text.slice(end, match.index), REDACTED); size = nextSize; end = this.pattern.lastIndex;
    }
    if (size + text.length - end > MAX_BODY_BYTES) { this.limited = true; return '[OMITTED: redaction resource limit]'; }
    parts.push(text.slice(end)); return parts.join('');
  }
  headers(headers) {
    this.learnHeaders(headers);
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [this.text(key), this.isCredentialName(key) ? REDACTED : this.text(Array.isArray(value) ? value.join('\n') : value)]));
  }
  json(value) {
    if (this.unsafe) return '[OMITTED: incomplete credential discovery]';
    if (typeof value === 'string') return this.text(value);
    if (!value || typeof value !== 'object') return this.secrets.has(String(value)) ? REDACTED : value;
    if (Array.isArray(value)) return value.map((v) => this.json(v));
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [this.text(key), this.isCredentialName(key) ? REDACTED : this.json(v)]));
  }
  partialText(text) {
    // A cap may split a known credential. Remove even a one-character suffix
    // matching a secret prefix; diagnostic fidelity never outranks redaction.
    for (const secret of this.secrets) for (const form of [secret, encodedSecret(secret)]) {
      const size = Math.min(form.length - 1, text.length);
      if (size <= 0) continue;
      // KMP finds a suffix/prefix overlap in linear time, including repetitive
      // attacker-controlled strings. Avoid quadratic suffix probing.
      const prefix = new Uint32Array(size);
      for (let i = 1, matched = 0; i < size; i++) { while (matched && form[i] !== form[matched]) matched = prefix[matched - 1]; if (form[i] === form[matched]) matched++; prefix[i] = matched; }
      let matched = 0;
      for (let i = text.length - size; i < text.length; i++) { while (matched && text[i] !== form[matched]) matched = prefix[matched - 1]; if (text[i] === form[matched]) matched++; }
      if (matched) text = text.slice(0, -matched) + REDACTED;
    }
    text = text.replace(/(?:https?|socks5h?):\/\/[^\s<>"']*$/i, '[OMITTED: partial URL]');
    return this.text(text);
  }
  prefix(text) {
    if (this.unsafe) throw new Error('incomplete credential discovery');
    if (/^(?:data:|event:|id:|retry:|:)/m.test(text)) {
      const boundaries = [...text.matchAll(/\r?\n\r?\n/g)];
      const last = boundaries.at(-1), end = last ? last.index + last[0].length : 0;
      // Even an unpublished tail can introduce a partial credential whose echo
      // appeared in earlier events, other bodies or headers. Inspect it first.
      const lines = text.slice(end).split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') this.prefix(data);
      for (const line of lines.filter((line) => !line.startsWith('data:'))) this.text(line, true);
      if (!end) throw new Error('no complete SSE event');
      return { text: this.body(text.slice(0, end)), omittedTailBytes: Buffer.byteLength(text.slice(end)) };
    }
    if (/^[\[{]/.test(text.trimStart())) {
      // Reconstruct only a syntactically valid JSON prefix. It is labelled as a
      // partial diagnostic, not replayable input. Invalid interior syntax fails
      // closed. An unfinished value string can retain its safe text prefix.
      let quoted = false, escaped = false, quoteStart = -1, quoteEnd = -1; const scopes = [];
      for (let i = 0; i < text.length; i++) {
        const char = text[i], scope = scopes.at(-1);
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') { quoted = false; quoteEnd = i; } }
        else if (char === '"') { quoted = true; quoteStart = i; }
        else if (char === '{' || char === '[') {
          if (scopes.length >= 64) { this.limited = true; throw new Error('redaction resource limit'); }
          scopes.push({ close: char === '{' ? '}' : ']', credential: scope?.credential || scope?.fieldCredential, fieldCredential: false });
        }
        else if (char === ':') { if (!scope) throw new Error('invalid JSON prefix'); scope.fieldCredential = this.isCredentialName(JSON.parse(text.slice(quoteStart, quoteEnd + 1))); }
        else if (char === ',') { if (scope) scope.fieldCredential = false; }
        else if (char === '}' || char === ']') { if (scopes.pop()?.close !== char) throw new Error('invalid JSON prefix'); }
      }
      // Never promote an unfinished credential value to a complete known secret:
      // replacing its observed prefix can leave a reconstructable suffix elsewhere.
      const scope = scopes.at(-1);
      if (scope?.credential || scope?.fieldCredential) { this.unsafe = true; throw new Error('incomplete credential discovery'); }
      let candidate = text, omittedTailBytes = 0;
      if (quoted) {
        let value = text.slice(quoteStart + 1);
        // Remove only an incomplete escape, never decode invalid interior bytes.
        if (escaped) value = value.slice(0, -1);
        value = value.replace(/\\u[0-9a-f]{0,3}$/i, '');
        const decoded = JSON.parse('"' + value + '"');
        const before = text.slice(0, quoteStart);
        const isKey = /[{,]\s*$/.test(before);
        if (isKey) { candidate = before.replace(/,\s*$/, ''); omittedTailBytes = Buffer.byteLength(text.slice(quoteStart)); }
        else { this.text(decoded, true); candidate = before + JSON.stringify(this.partialText(decoded)); }
      }
      candidate = candidate.replace(/,\s*$/, '').replace(/:\s*$/, ':null') + scopes.reverse().map((scope) => scope.close).join('');
      const value = JSON.parse(candidate); this.learn(value);
      return { text: JSON.stringify(this.json(value)), omittedTailBytes };
    }
    if (/[{}\[\]\\]|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('ambiguous text prefix');
    this.text(text, true);
    return { text: this.partialText(text), omittedTailBytes: 0 };
  }
  body(text) {
    if (this.unsafe) throw new Error('incomplete credential discovery');
    if (this.limited) throw new Error('redaction resource limit');
    const trimmed = text.trimStart();
    if (/^[\[{"\d-]|^(true|false|null)\b/.test(trimmed)) {
      const value = JSON.parse(text); this.learn(value); return JSON.stringify(this.json(value), null, 2);
    }
    if (/^(?:data:|event:|id:|retry:|:)/m.test(text)) {
      if (text && !/\r?\n\r?\n$/.test(text)) throw new Error('partial SSE');
      const events = text.split(/\r?\n\r?\n/).filter(Boolean).map((event) => {
        const lines = event.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        const value = !data || data === '[DONE]' ? null : JSON.parse(data);
        if (value) this.learn(value);
        return { lines, data, value };
      });
      return events.map(({ lines, data, value }) => {
        const other = lines.filter((line) => !line.startsWith('data:')).map((line) => this.text(line));
        if (data) other.push('data: ' + (data === '[DONE]' ? data : JSON.stringify(this.json(value))));
        return other.join('\n') + '\n\n';
      }).join('');
    }
    // Embedded/escaped JSON and binary-looking controls are ambiguous, not prose.
    if (/[{}\[\]\\]|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('ambiguous text');
    return this.text(text);
  }
}

export class BodyCapture {
  constructor({ budget = captureBudget, limit = MAX_BODY_BYTES } = {}) {
    this.budget = budget; this.limit = limit; this.chunks = []; this.bytes = 0;
    this.observedBytes = 0; this.complete = false; this.started = false; this.limited = false; this.released = false;
    this.bodyId = randomUUID();
  }
  add(chunk, encoding) {
    if (this.released) return;
    this.started = true;
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    this.observedBytes += length;
    if (this.limited || this.capped) return;
    const size = Math.min(length, this.limit - this.bytes);
    if (!this.budget.reserve(size * 2)) { this.limited = true; this.discard(); return; }
    let copied = size;
    if (size) {
      if (typeof chunk === 'string') { const data = Buffer.alloc(size); copied = data.write(chunk, 0, size, encoding); this.chunks.push(data.subarray(0, copied)); }
      else { const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength); this.chunks.push(Buffer.from(data.subarray(0, size))); }
    }
    this.budget.release((size - copied) * 2); this.bytes += copied;
    this.capped = length > size || copied < size;
  }
  end() { this.started = true; this.complete = true; }
  discard() { this.budget.release(this.bytes * 2); this.bytes = 0; this.chunks = []; }
  release() { if (!this.released) { this.discard(); this.released = true; } }
  decode() {
    const partial = this.observedBytes > this.limit || !this.complete;
    const bytes = Buffer.concat(this.chunks, this.bytes);
    for (let trim = 0; trim <= (partial ? 3 : 0); trim++) {
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - trim)), omittedTailBytes: trim }; } catch {}
    }
    throw new Error('invalid UTF-8');
  }
  learn(redactor) {
    if (!this.bytes || this.limited) return;
    // Failed discovery cannot establish which earlier/cross-body values are
    // credential echoes. Fence the whole group rather than publishing fragments.
    try { const decoded = this.decode().text; if (this.observedBytes > this.limit || !this.complete) redactor.prefix(decoded); else redactor.body(decoded); } catch { redactor.unsafe = true; }
  }
  materialize(redactor) {
    let text = '', state = this.limited ? 'resource-limited' : !this.started ? 'unread' : !this.complete ? 'interrupted' : 'complete';
    let truncated = this.observedBytes > this.limit, omittedTailBytes = this.capped ? Math.min(this.observedBytes, this.limit) - this.bytes : 0;
    if (this.bytes && !this.limited) {
      try {
        const partial = truncated || !this.complete;
        const decoded = this.decode(); omittedTailBytes += decoded.omittedTailBytes;
        if (partial) { const safe = redactor.prefix(decoded.text); text = safe.text; omittedTailBytes += safe.omittedTailBytes; }
        else text = redactor.body(decoded.text);
        let encoded = Buffer.from(text);
        if (encoded.length > this.limit) {
          truncated = true;
          encoded = encoded.subarray(0, this.limit);
          while (encoded.length) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(encoded); break; } catch { encoded = encoded.subarray(0, encoded.length - 1); } }
        }
        // Space for expanded sanitized output beyond the raw reservation.
        if (Buffer.byteLength(text) > this.bytes && !this.budget.reserve((Buffer.byteLength(text) - this.bytes) * 2)) { text = ''; state = 'resource-limited'; }
        else if (Buffer.byteLength(text) > this.bytes) this.bytes = Buffer.byteLength(text);
        if (redactor.unsafe) { text = ''; state = 'omitted-for-safety'; }
        if (redactor.limited) { text = ''; state = 'resource-limited'; }
      } catch { state = redactor.limited ? 'resource-limited' : 'omitted-for-safety'; text = ''; }
    }
    if (truncated && state === 'complete') state = 'truncated';
    return { descriptor: { bodyId: this.bodyId, observedBytes: this.observedBytes, capturedBytes: Buffer.byteLength(text), truncated, complete: this.complete, state, omittedTailBytes, redacted: true }, text };
  }
}

export function observeStream(source, capture) {
  const tap = new Transform({ transform(chunk, encoding, callback) { capture.add(chunk); callback(null, chunk); } });
  // A tap is a single backpressured consumer; destruction propagates both ways.
  // Wait for the native error after `aborted`, rather than racing it with a
  // diagnostic error. finished() also supplies Node's standard premature-close
  // error for a source that closes silently, so consumers cannot hang.
  finished(source, { readable: true, writable: false }, (error) => { if (error) tap.destroy(error); else capture.end(); });
  tap.once('close', () => { if (!source.readableEnded) source.destroy(); });
  tap.on('error', () => {}); // May fail before the asynchronous consumer attaches.
  source.pipe(tap);
  return tap;
}

export const detailRoute = (method, pathname) => method === 'POST'
  ? ['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions', '/api/test', '/api/probe', '/api/validate-upstreams', '/api/accounts/test', '/api/accounts/proxy-test', '/v1/responses'].includes(pathname)
  : method === 'GET' && ['/models', '/v1/models', '/api/v1/models'].includes(pathname);

// Open roots persist only safe identity metadata. Full sanitized publication is
// deferred and never awaited by model traffic; startup marks open roots interrupted.
export class DetailRoot {
  static active = 0;
  constructor(req, res, store, secrets = []) {
    DetailRoot.active++;
    this.store = store; this.generation = store.generation; this.requestId = randomUUID(); this.ts = Date.now();
    this.method = req.method; this.pathname = new URL(req.url, 'http://local').pathname;
    this.redactor = new DetailRedactor(secrets); this.redactor.learnHeaders(req.headers);
    this.headers = req.headers; this.input = new BodyCapture(); this.output = new BodyCapture();
    this.attempts = []; this.closed = false; this.model = ''; this.responseHeaders = {}; this.status = null; this.omittedAttempts = 0;
    void store.open({ generation: this.generation, ts: this.ts, requestId: this.requestId, method: this.method, pathname: this.pathname }).catch(() => store.failure());
    const write = res.write, end = res.end, writeHead = res.writeHead;
    let ending = false;
    const add = (chunk, encoding) => { try { if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') this.output.add(chunk, typeof encoding === 'string' ? encoding : undefined); } catch { this.output.limited = true; } };
    res.write = function(chunk, encoding, callback) { if (!ending) add(chunk, encoding); return write.apply(this, arguments); };
    res.end = function(chunk, encoding, callback) { add(chunk, encoding); ending = true; try { return end.apply(this, arguments); } finally { ending = false; } };
    const root = this;
    res.writeHead = function(status, message, headers) {
      const result = writeHead.apply(this, arguments);
      const supplied = typeof message === 'string' ? headers : message;
      root.responseHeaders = Object.create(null);
      for (const [key, value] of Object.entries(this.getHeaders())) root.responseHeaders[key.toLowerCase()] = value;
      if (Array.isArray(supplied)) {
        const explicit = Object.create(null);
        for (let i = 0; i < supplied.length; i += 2) { const key = String(supplied[i]).toLowerCase(); explicit[key] = Object.hasOwn(explicit, key) ? [explicit[key], supplied[i + 1]].flat() : supplied[i + 1]; }
        Object.assign(root.responseHeaders, explicit);
      } else for (const [key, value] of Object.entries(supplied || {})) root.responseHeaders[key.toLowerCase()] = value;
      root.status = status; return result;
    };
    res.once('finish', () => { this.output.end(); this.finalize(); });
    res.once('close', () => this.finalize());
    req.once('aborted', () => { this.input.complete = false; });
    if (req.method === 'GET' && !req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0')) this.input.end();
  }
  active() { return !this.closed && this.generation === this.store.generation; }
  attempt({ headers = {}, body = '', account = null, proxyUrl = '', method = 'POST', url }) {
    if (!this.active()) return null;
    if (this.attempts.length >= 256) { this.omittedAttempts++; this.store.health.dropped++; return null; }
    this.redactor.learnHeaders(headers); this.redactor.add(account?.key); this.redactor.url(proxyUrl || account?.proxyUrl || '');
    const attempt = { callId: randomUUID(), ts: Date.now(), method, url: this.redactor.text(this.redactor.url(url)), accountId: account?.id || null, accountName: account?.name || null, headers, responseHeaders: {}, status: null, input: new BodyCapture(), output: new BodyCapture(), state: 'interrupted' };
    attempt.input.add(body); attempt.input.end();
    try { if (Buffer.byteLength(body) <= MAX_BODY_BYTES) { const parsed = JSON.parse(String(body)); this.redactor.learn(parsed); attempt.model = typeof parsed.model === 'string' ? parsed.model.slice(0, 300) : ''; const prefs = parsed.providerOptions?.gateway || parsed.provider || {}; const targets = prefs.only || prefs.order || []; attempt.provider = Array.isArray(targets) ? targets.filter((value) => typeof value === 'string').slice(0, 20).map((value) => value.slice(0, 300)) : []; if (!this.model) this.model = attempt.model; } } catch {}
    this.attempts.push(attempt); return attempt;
  }
  finalize() {
    if (this.closed) return; this.closed = true;
    const captures = [this.input, this.output, ...this.attempts.flatMap((a) => [a.input, a.output])];
    let released = false;
    const release = () => { if (released) return; released = true; captures.forEach((capture) => capture.release()); DetailRoot.active--; };
    void this.store.publish({ generation: this.generation, ts: this.ts, requestId: this.requestId, requireOpen: true, release, produce: () => {
      // Discover structured credentials across the group before sanitizing echoes.
      this.redactor.learnHeaders(this.headers);
      this.redactor.learnHeaders(this.responseHeaders);
      for (const attempt of this.attempts) { this.redactor.learnHeaders(attempt.headers); this.redactor.learnHeaders(attempt.responseHeaders); }
      for (const capture of captures) capture.learn(this.redactor);
      const bodies = captures.map((capture) => capture.materialize(this.redactor));
      const resourceLimited = bodies.some((body) => body.descriptor.state === 'resource-limited');
      if (resourceLimited) this.store.health.dropped++;
      const request = { requestId: this.requestId, ts: this.ts, method: this.method, pathname: this.pathname, model: this.redactor.text(this.model), accounts: this.attempts.map((a) => this.redactor.text(a.accountName || a.accountId || '')).filter(Boolean), status: this.status, result: this.result || null, complete: this.output.complete, state: this.omittedAttempts || resourceLimited ? 'resource-limited' : bodies.some((b) => b.descriptor.state !== 'complete') ? 'incomplete' : 'complete', attemptCount: this.attempts.length, omittedAttempts: this.omittedAttempts, headers: this.redactor.headers(this.headers), responseHeaders: this.redactor.headers(this.responseHeaders), requestBody: this.input.bodyId, responseBody: this.output.bodyId };
      const attempts = this.attempts.map((a) => ({ callId: a.callId, ts: a.ts, method: a.method, url: this.redactor.text(a.url), accountId: this.redactor.text(a.accountId || ''), accountName: this.redactor.text(a.accountName || ''), model: this.redactor.text(a.model || ''), provider: this.redactor.json(a.provider || null), redirected: a.redirected === true, headers: this.redactor.headers(a.headers), responseHeaders: this.redactor.headers(a.responseHeaders), status: a.status, state: a.output.complete ? 'complete' : a.state, requestBody: a.input.bodyId, responseBody: a.output.bodyId }));
      return { request, attempts, bodies };
    } }).catch(() => { this.store.failure(); release(); });
  }
}
