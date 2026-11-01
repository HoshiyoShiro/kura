// Notepad server: zero dependencies, encrypted at rest, authenticated.
//
// Threat model: someone gets a copy of data/ (backup, stolen disk, synced folder) -> unreadable.
// Someone else on the network / a malicious web page -> cannot read or write without auth.
// NOT covered: malware on this machine while the server is unlocked (key is in process memory),
// and note text you choose to show the AI (it goes to the AI provider). Mark those notes private.
//
// Env: PORT (4546), HOST (127.0.0.1), ALLOWED_HOSTS (comma list of extra hostnames, e.g. MagicDNS name),
//      NOTEPAD_PASSPHRASE (optional, avoids the prompt; visible in the process environment),
//      NOTEPAD_DATA (data folder, default ./data), LOCKOUT_BASE_MS (default 30000, mainly for tests).
// Limits (env overrides, mainly for tests): RATE_LIMIT_PER_MIN (300), RATE_LIMIT_AI_WRITES_PER_MIN (30),
//      NOTE_MAX_CHARS (200000), NOTE_MAX_COUNT (5000), AUDIT_MAX_BYTES (1000000),
//      FULL_PAGE_MAX_CHARS (5000000, body characters per full=1 page).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT === undefined ? 4546 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DATA_DIR = path.resolve(process.env.NOTEPAD_DATA || path.join(__dirname, 'data'));
const NOTES_DIR = path.join(DATA_DIR, 'notes');
const NOTES_NEW = NOTES_DIR + '.new', NOTES_OLD = NOTES_DIR + '.old';
const META_FILE = path.join(DATA_DIR, 'meta.json');
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');
const DEV_FILE = path.join(DATA_DIR, 'devices.enc');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SESSION_MS = 8 * 3600 * 1000;
const MAX_BODY = 1e6;
const LOCK_BASE = Number(process.env.LOCKOUT_BASE_MS) || 30000;
const RATE_GENERAL = Number(process.env.RATE_LIMIT_PER_MIN) || 300;
const RATE_AI_WRITES = Number(process.env.RATE_LIMIT_AI_WRITES_PER_MIN) || 30;
const MAX_NOTE_CHARS = Number(process.env.NOTE_MAX_CHARS) || 200000;
const MAX_NOTES = Number(process.env.NOTE_MAX_COUNT) || 5000;
const AUDIT_MAX = Number(process.env.AUDIT_MAX_BYTES) || 1e6;
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const FULL_PAGE_CHARS = Number(process.env.FULL_PAGE_MAX_CHARS) || 5e6;
const DEFAULT_LIMIT = 100, MAX_LIMIT = 500;

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

// A passphrase change that was interrupted: finish it (committed) or discard it (not committed).
// Commit point = notes/ renamed to notes.old/. Everything staged is fully written by then.
function finishSwap() {
  const mv = (a, b) => { if (fs.existsSync(a)) fs.renameSync(a, b); };
  mv(NOTES_NEW, NOTES_DIR); mv(DEV_FILE + '.new', DEV_FILE); mv(META_FILE + '.new', META_FILE);
  fs.rmSync(NOTES_OLD, { recursive: true, force: true });
}
const STAGED = [NOTES_NEW, DEV_FILE + '.new', META_FILE + '.new'];
if (fs.existsSync(NOTES_OLD)) { console.log('Finishing an interrupted passphrase change (use the NEW passphrase).'); finishSwap(); }
else for (const f of STAGED) fs.rmSync(f, { recursive: true, force: true });
fs.mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });

// ---------- audit log (one JSON line per event; never note text, tokens or passphrases) ----------
function audit(event, scope, req, extra = {}) {
  try {
    if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size >= AUDIT_MAX) fs.renameSync(AUDIT_FILE, AUDIT_FILE + '.1');
    const line = JSON.stringify({ ts: new Date().toISOString(), event, scope: scope || 'none', ip: req && req.socket ? req.socket.remoteAddress : null, ...extra }) + '\n';
    fs.appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
  } catch (e) { console.error('audit log write failed:', e.code || e.message); }
}

// A denied AI delete is logged at most once a minute (with a count of the rest), so a looping AI
// cannot push the real history out of the size-limited log.
let deniedAt = 0, deniedSkipped = 0;
function auditDenied(scope, req, id) {
  if (Date.now() - deniedAt < 60000) { deniedSkipped++; return; }
  deniedAt = Date.now();
  audit('ai_delete_denied', scope, req, deniedSkipped ? { id, suppressed: deniedSkipped } : { id }); deniedSkipped = 0;
}

// ---------- rate limiting (fixed one-minute windows, in memory, per identity) ----------
const rateHits = new Map(); // key -> { start, n }
function rateCheck(key, max) {
  const now = Date.now();
  if (rateHits.size > 10000) for (const [k, v] of rateHits) if (now - v.start >= 60000) rateHits.delete(k);
  let h = rateHits.get(key);
  if (!h || now - h.start >= 60000) { h = { start: now, n: 0 }; rateHits.set(key, h); }
  if (++h.n > max) {
    const wait = Math.max(1, Math.ceil((h.start + 60000 - now) / 1000));
    throw Object.assign(httpErr(429, `Too many requests. Try again in ${wait}s.`), { headers: { 'Retry-After': String(wait) } });
  }
}

// ---------- crypto ----------
let KEY = null, SALT = null;
const deriveKey = (pass, salt) => crypto.scryptSync(pass.normalize('NFKC'), salt, 32, SCRYPT);

function encrypt(plain, aad, key = KEY) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decrypt(box, aad, key = KEY) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}
function writeSecure(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function promptHidden(q) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { console.error('No TTY: set NOTEPAD_PASSPHRASE or run in a terminal.'); process.exit(1); }
    process.stdout.write(q);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let s = '';
    const on = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on);
          process.stdout.write('\n'); return resolve(s);
        }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    };
    stdin.on('data', on);
  });
}

async function unlock() {
  if (fs.existsSync(META_FILE)) {
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    for (let tries = 0; tries < 5; tries++) {
      const pass = process.env.NOTEPAD_PASSPHRASE || await promptHidden('Passphrase: ');
      const key = deriveKey(pass, Buffer.from(meta.salt, 'base64'));
      try {
        if (decrypt(meta.verifier, 'meta', key) === 'notepad-ok') { KEY = key; SALT = Buffer.from(meta.salt, 'base64'); return; }
      } catch { /* wrong */ }
      console.error('Wrong passphrase.');
      if (process.env.NOTEPAD_PASSPHRASE) process.exit(1);
    }
    process.exit(1);
  }
  console.log('First run: choose a passphrase. It encrypts every note and CANNOT be recovered if forgotten.');
  let pass = process.env.NOTEPAD_PASSPHRASE;
  if (!pass) {
    pass = await promptHidden('New passphrase (12+ chars): ');
    if (pass !== await promptHidden('Repeat passphrase: ')) { console.error('Did not match.'); process.exit(1); }
  }
  if (pass.length < 12) { console.error('Passphrase must be at least 12 characters.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  KEY = deriveKey(pass, salt); SALT = salt;
  writeSecure(META_FILE, JSON.stringify({ v: 1, salt: salt.toString('base64'), verifier: encrypt('notepad-ok', 'meta') }));
}

let AI_TOKEN = null;
function apiToken() {
  if (!AI_TOKEN) {
    if (!fs.existsSync(TOKEN_FILE)) writeSecure(TOKEN_FILE, crypto.randomBytes(32).toString('hex'));
    AI_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    // An empty/truncated token file must never become a valid (empty) credential: replace it.
    if (AI_TOKEN.length < 32) { writeSecure(TOKEN_FILE, crypto.randomBytes(32).toString('hex')); AI_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  }
  return AI_TOKEN;
}
function rotateApiToken() { writeSecure(TOKEN_FILE, crypto.randomBytes(32).toString('hex')); AI_TOKEN = null; apiToken(); }

// ---------- devices (tokens kept only as SHA-256 hashes; the list is encrypted with the notes key) ----------
let devices = []; // { id, name, hash, created, lastUsed }
function loadDevices() {
  try { devices = JSON.parse(decrypt(JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')), 'devices')); }
  catch (e) { if (e.code !== 'ENOENT') console.error('devices.enc unreadable; no device tokens loaded.'); devices = []; }
}
const saveDevices = (file = DEV_FILE, key = KEY) => writeSecure(file, JSON.stringify(encrypt(JSON.stringify(devices), 'devices', key)));
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const publicDevice = d => ({ id: d.id, name: d.name, created: d.created, lastUsed: d.lastUsed });

// ---------- notes ----------
const ID_RE = /^[a-f0-9]{24}$/;
const noteFile = id => path.join(NOTES_DIR, id + '.enc');
const cleanTags = t => [...new Set((Array.isArray(t) ? t : String(t || '').split(','))
  .map(x => String(x).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);

function parseNote(id, plain) {
  const n = { id, ...JSON.parse(plain) };
  n.source = n.source === 'ai' ? 'ai' : 'you'; // notes from before provenance existed count as yours
  n.editedBy = n.editedBy === 'ai' ? 'ai' : 'you'; // who last changed it; same default for older notes
  return n;
}
function readNote(id) {
  try { return parseNote(id, decrypt(JSON.parse(fs.readFileSync(noteFile(id), 'utf8')), id)); }
  catch (e) { if (e.code !== 'ENOENT') cache = null; return null; } // damaged file: rebuild the cache so it is counted as skipped
}
function saveNote(n) {
  const { id, ...rest } = n;
  writeSecure(noteFile(id), JSON.stringify(encrypt(JSON.stringify(rest), id)));
  if (cache) cache.set(id, n);
  return n;
}
const noteIds = () => fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.enc') && ID_RE.test(f.slice(0, -4))).map(f => f.slice(0, -4));
const byUpdated = (a, b) => b.updated.localeCompare(a.updated);
const loggedDamaged = new Set();
function readEverything() { // fresh read of every file; damaged ones are counted, logged once by id, never by content
  const notes = []; let skipped = 0;
  for (const id of noteIds()) {
    let n = null;
    try { n = parseNote(id, decrypt(JSON.parse(fs.readFileSync(noteFile(id), 'utf8')), id)); } catch { /* damaged */ }
    if (n) notes.push(n);
    else { skipped++; if (!loggedDamaged.has(id)) { loggedDamaged.add(id); console.error('Note file could not be decrypted (skipped): ' + id); } }
  }
  return { notes, skipped };
}
// In-memory cache of decrypted notes: built on first use, kept current by save/delete, dropped on passphrase change.
let cache = null, cacheSkipped = 0;
function cachedNotes() {
  if (!cache) {
    const { notes, skipped } = readEverything();
    cache = new Map(notes.map(n => [n.id, n])); cacheSkipped = skipped;
  }
  return [...cache.values()].sort(byUpdated);
}
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

function search(notes, q, tag) {
  if (tag) notes = notes.filter(n => n.tags.includes(tag.toLowerCase()));
  if (!q) return notes;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return notes.map(n => {
    const t = n.title.toLowerCase(), b = n.body.toLowerCase(), g = n.tags.join(' ');
    let score = 0;
    for (const w of terms) {
      const s = (t.includes(w) ? 5 : 0) + (g.includes(w) ? 3 : 0) + (b.includes(w) ? 1 : 0);
      if (!s) return null;
      score += s;
    }
    return { n, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).map(x => x.n);
}
const tagIndex = notes => {
  const m = new Map(); // not a plain object: tags like 'constructor' or '__proto__' must count normally
  for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

// ---------- auth ----------
const sessions = new Map(); // sid -> expiry
let failures = 0, lockedUntil = 0;
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function cookieSid(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && m[1];
}
// Returns 'web' | 'device' | 'ai' | null. A device token has the same access as a web session.
function authScope(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (!t) return null;
    if (eq(t, apiToken())) { req.identity = 'ai'; return 'ai'; }
    const hash = hashToken(t), d = devices.find(x => eq(x.hash, hash));
    if (d) { d.lastUsed = new Date().toISOString(); req.identity = 'dev:' + hash; return 'device'; }
    return null;
  }
  const sid = cookieSid(req);
  if (sid && sessions.has(sid)) {
    if (sessions.get(sid) > Date.now()) { req.identity = 'sid:' + sid; return 'web'; }
    sessions.delete(sid);
  }
  return null;
}
// Checks a passphrase against the unlocked key, with global lockout/backoff.
function checkPassphrase(passphrase, req, scope, via = 'passphrase') {
  if (Date.now() < lockedUntil) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)}s.`);
  let ok = false;
  try { ok = eq(deriveKey(String(passphrase || ''), SALT).toString('hex'), KEY.toString('hex')); } catch { /* bad input */ }
  if (!ok) {
    failures++;
    audit(via === 'login' ? 'login_fail' : 'passphrase_fail', scope, req, via === 'login' ? {} : { via });
    if (failures >= 5) { lockedUntil = Date.now() + Math.min(2 ** (failures - 5) * LOCK_BASE, 3600000); audit('lockout', scope, req); }
    throw httpErr(401, 'Wrong passphrase.');
  }
  failures = 0;
}
function login(passphrase, req) {
  checkPassphrase(passphrase, req, null, 'login');
  audit('login_ok', null, req);
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}

// Re-encrypt everything under a new passphrase. All new files are staged complete before the
// swap; any failure before the commit point leaves the old data untouched.
function changePassphrase(next) {
  const salt = crypto.randomBytes(16), key = deriveKey(next, salt);
  try {
    for (const f of STAGED) fs.rmSync(f, { recursive: true, force: true });
    fs.mkdirSync(NOTES_NEW, { mode: 0o700 });
    for (const f of fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.enc'))) {
      const id = f.slice(0, -4);
      const plain = decrypt(JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), 'utf8')), id); // throws if damaged
      writeSecure(path.join(NOTES_NEW, f), JSON.stringify(encrypt(plain, id, key)));
    }
    saveDevices(DEV_FILE + '.new', key);
    writeSecure(META_FILE + '.new', JSON.stringify({ v: 1, salt: salt.toString('base64'), verifier: encrypt('notepad-ok', 'meta', key) }));
    fs.renameSync(NOTES_DIR, NOTES_OLD); // commit point
  } catch (e) {
    for (const f of STAGED) fs.rmSync(f, { recursive: true, force: true });
    console.error('Passphrase change aborted:', e.message);
    throw httpErr(500, 'Could not re-encrypt your notes (a note file may be damaged). Nothing was changed.');
  }
  KEY = key; SALT = salt; cache = null;
  finishSwap(); // if this throws, the next start finishes it (use the new passphrase)
}

// ---------- http ----------
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
function send(res, status, obj, extra = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), ...extra });
  res.end(b);
}
const readBody = req => new Promise((resolve, reject) => {
  if (!/^application\/json/i.test(req.headers['content-type'] || '') && req.method !== 'GET' && req.method !== 'DELETE' && req.headers['content-length'] !== '0')
    return reject(httpErr(415, 'JSON only'));
  const c = []; let size = 0, over = false;
  const tooBig = () => { over = true; c.length = 0; req.resume(); reject(Object.assign(httpErr(413, 'Body too large'), { headers: { Connection: 'close' } })); }; // discard the rest, but still answer
  if (Number(req.headers['content-length']) > MAX_BODY) return tooBig();
  req.on('data', d => { if (over) return; size += d.length; if (size > MAX_BODY) tooBig(); else c.push(d); });
  req.on('end', () => { if (over) return; const r = Buffer.concat(c).toString('utf8'); let v; try { v = r ? JSON.parse(r) : {}; } catch { return reject(httpErr(400, 'Bad JSON')); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(httpErr(400, 'JSON object required'));
    resolve(v); });
  req.on('error', reject);
});

// Reject unexpected Host headers: stops DNS-rebinding, where a web page re-points its own name at us.
function hostAllowed(req) {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec((req.headers.host || '').toLowerCase()); // no userinfo or junk
  const name = m && m[1];
  return !!name && (name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[') || EXTRA_HOSTS.includes(name));
}

const secure = req => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const view = (n, full) => full ? n : { ...n, body: undefined, preview: n.body.slice(0, 140) };
const tooLong = () => httpErr(413, `A note can hold at most ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters.`);
function parseLimit(v) { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(Math.max(x, 1), MAX_LIMIT) : DEFAULT_LIMIT; }
function parseCursor(c) {
  if (c === null || c === '') return 0;
  const m = /^o(\d{1,9})$/.exec(Buffer.from(c, 'base64url').toString('utf8'));
  if (!m) throw httpErr(400, 'Bad cursor');
  return Number(m[1]);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET') throw httpErr(405, 'Method not allowed');
    const name = p === '/' ? 'index.html' : p.slice(1);
    if (!/^[a-z0-9.-]+$/i.test(name) || !MIME[path.extname(name)]) throw httpErr(404, 'Not found');
    const file = path.join(PUBLIC_DIR, name);
    if (!fs.existsSync(file)) throw httpErr(404, 'Not found');
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': MIME[path.extname(name)] });
    return res.end(fs.readFileSync(file));
  }

  // CSRF: a browser always sends Origin on cross-origin writes; it must be us (any scheme, same host).
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin) {
    let oh = null; try { oh = new URL(origin).host; } catch { /* "null" etc. */ }
    if (!oh || oh.toLowerCase() !== (req.headers.host || '').toLowerCase()) throw httpErr(403, 'Bad origin');
  }

  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const sid = login(b.passphrase, req);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure(req)}` });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const sid = cookieSid(req); if (sid) sessions.delete(sid);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + secure(req) });
  }
  // Issue a device token. Needs the passphrase (not a session) so a phone can enrol on first run.
  if (p === '/api/devices' && req.method === 'POST') {
    const b = await readBody(req);
    checkPassphrase(b.passphrase, req, null, 'device-enrol');
    const token = 'dev_' + crypto.randomBytes(32).toString('hex');
    const d = { id: crypto.randomBytes(12).toString('hex'), name: String(b.name || 'Device').trim().slice(0, 60) || 'Device',
      hash: hashToken(token), created: new Date().toISOString(), lastUsed: null };
    devices.push(d); saveDevices();
    audit('device_create', null, req, { id: d.id });
    return send(res, 200, { ...publicDevice(d), token });
  }

  const scope = authScope(req);
  if (!scope) throw httpErr(401, 'Not signed in.');
  const ai = scope === 'ai';
  rateCheck('all:' + req.identity, RATE_GENERAL);
  if (ai && (req.method === 'POST' || req.method === 'PUT')) rateCheck('aiw:' + req.identity, RATE_AI_WRITES);
  const visible = n => n && !(ai && n.private); // AI never sees private notes
  const noAI = () => { if (ai) throw httpErr(403, 'Not allowed for the AI token.'); };

  if (p === '/api/session') return send(res, 200, { scope });
  if (p === '/api/devices' && req.method === 'GET') { noAI(); return send(res, 200, { devices: devices.map(publicDevice) }); }
  const dm = p.match(/^\/api\/devices\/([^/]+)$/);
  if (dm && req.method === 'DELETE') {
    noAI();
    const i = ID_RE.test(dm[1]) ? devices.findIndex(d => d.id === dm[1]) : -1;
    if (i < 0) throw httpErr(404, 'Device not found');
    devices.splice(i, 1); saveDevices();
    audit('device_revoke', scope, req, { id: dm[1] });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/ai-token/rotate' && req.method === 'POST') {
    noAI(); checkPassphrase((await readBody(req)).passphrase, req, scope, 'ai-token-rotate');
    rotateApiToken();
    audit('ai_token_rotate', scope, req);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/passphrase' && req.method === 'POST') {
    noAI(); const b = await readBody(req);
    checkPassphrase(b.current, req, scope, 'passphrase-change');
    if (typeof b.next !== 'string' || b.next.length < 12) throw httpErr(400, 'New passphrase must be at least 12 characters.');
    changePassphrase(b.next);
    audit('passphrase_change', scope, req);
    const keep = cookieSid(req); for (const k of [...sessions.keys()]) if (k !== keep) sessions.delete(k);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/export' && req.method === 'GET') {
    noAI();
    audit('export', scope, req);
    return send(res, 200, { exported: new Date().toISOString(), notes: readEverything().notes.sort(byUpdated) },
      { 'Content-Disposition': `attachment; filename="notepad-export-${new Date().toISOString().slice(0, 10)}.json"` });
  }

  if (p === '/api/notes' && req.method === 'GET') {
    const list = search(cachedNotes().filter(visible), url.searchParams.get('q') || '', url.searchParams.get('tag') || '');
    const limit = parseLimit(url.searchParams.get('limit')), start = parseCursor(url.searchParams.get('cursor'));
    const full = url.searchParams.get('full') === '1';
    let page = list.slice(start, start + limit);
    if (full) { let chars = 0; const keep = page.findIndex(n => (chars += n.body.length) > FULL_PAGE_CHARS); if (keep >= 0) page = page.slice(0, Math.max(keep, 1)); } // bound the response size; "next" covers the rest
    const next = start + page.length < list.length ? Buffer.from('o' + (start + page.length)).toString('base64url') : null;
    return send(res, 200, { notes: page.map(n => view(n, full)), next, skipped: cacheSkipped });
  }
  if (p === '/api/notes' && req.method === 'POST') {
    const b = await readBody(req);
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) throw httpErr(400, 'title required');
    const body = String(b.body || '');
    if (body.length > MAX_NOTE_CHARS) throw tooLong();
    cachedNotes(); // make sure the cache exists so the count is right
    if (cache.size >= MAX_NOTES) throw httpErr(409, `You have reached the limit of ${MAX_NOTES} notes. Delete some in the app first.`);
    const now = new Date().toISOString();
    const n = { id: crypto.randomBytes(12).toString('hex'), title, body, tags: cleanTags(b.tags),
      private: ai ? false : !!b.private, source: ai ? 'ai' : 'you', editedBy: ai ? 'ai' : 'you', created: now, updated: now };
    return send(res, 200, saveNote(n));
  }
  if (p === '/api/tags' && req.method === 'GET') return send(res, 200, { tags: tagIndex(cachedNotes().filter(visible)) });

  const m = p.match(/^\/api\/notes\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === 'DELETE' && ai) { auditDenied(scope, req, ID_RE.test(id) ? id : null); throw httpErr(403, 'Only you can delete notes, in the app.'); }
    if (!ID_RE.test(id)) throw httpErr(400, 'Invalid id');
    if (req.method === 'DELETE') { // no decrypt needed: a damaged note file must still be deletable
      if (!fs.existsSync(noteFile(id))) throw httpErr(404, 'Note not found');
      fs.unlinkSync(noteFile(id)); if (cache && cache.has(id)) cache.delete(id); else cache = null; // unknown or damaged: rebuild so the skipped count stays right
      audit('note_delete', scope, req, { id });
      return send(res, 200, { ok: true });
    }
    const b = req.method === 'PUT' ? await readBody(req) : null; // body first: no await between load and save
    const n = readNote(id);
    if (!visible(n)) throw httpErr(404, 'Note not found');
    if (req.method === 'GET') return send(res, 200, n);
    if (req.method === 'PUT') {
      if (b.title !== undefined) n.title = String(b.title).trim().slice(0, 200) || n.title;
      if (b.body !== undefined) { n.body = String(b.body); if (n.body.length > MAX_NOTE_CHARS) throw tooLong(); }
      if (b.append !== undefined) {
        const add = (n.body && !n.body.endsWith('\n') ? '\n' : '') + String(b.append);
        if (n.body.length + add.length > MAX_NOTE_CHARS) throw httpErr(413, `That would make the note longer than ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters. Nothing was added.`);
        n.body += add;
      }
      if (b.tags !== undefined) n.tags = cleanTags(b.tags);
      if (b.private !== undefined && !ai) n.private = !!b.private;
      n.editedBy = ai ? 'ai' : 'you'; // from the caller's scope only, never from the request body
      n.updated = new Date().toISOString();
      return send(res, 200, saveNote(n));
    }
  }
  throw httpErr(404, 'Unknown API route');
}

(async () => {
  await unlock();
  loadDevices();
  apiToken();
  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) throw httpErr(403, 'Host not allowed. Set ALLOWED_HOSTS.');
      await route(req, res);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }, e.headers || {});
    }
  }).listen(PORT, HOST, () => {
    console.log(`Notepad unlocked on http://${HOST}:${server.address().port}`);
    console.log(`MCP token file: ${TOKEN_FILE}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('WARNING: listening beyond localhost. Use Tailscale/VPN only; traffic is plain HTTP.');
  });
})();
