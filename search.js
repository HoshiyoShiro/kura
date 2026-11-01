'use strict';
// Search, snippets and section helpers for the Kura server. Pure code, no I/O, zero dependencies.
//
// Safety notes: no regular expression is ever built from user input, and every pattern applied to note
// text is linear (no nested or overlapping quantifiers), so a hostile query or note cannot stall the server.

const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const MAX_QUERY = 200, MAX_TERMS = 12, MIN_PREFIX = 3;
const FIELD_W = { t: 5, g: 3, b: 1 }; // title, tags, body
const K1 = 1.2, B = 0.75, PREFIX_W = 0.5;
const SNIP_WIDTH = 200, SNIP_LEAD = 60, SNIP_MAX = 3;

const isSpace = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0';

// Words are runs of letters/digits (any script), lower-cased one token at a time so offsets stay valid.
function tokenize(s) {
  const out = [];
  for (const m of String(s || '').matchAll(WORD)) out.push(m[0].toLowerCase());
  return out;
}
function tokenizePos(s) {
  const out = [];
  for (const m of String(s || '').matchAll(WORD)) out.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
  return out;
}

// "foo bar" -> two words. "a phrase" -> adjacent words. -word / -"a phrase" -> exclusion.
// A hyphenated piece like state-of-the-art is read as a phrase. Max 200 chars, max 12 terms.
function parseQuery(q) {
  q = String(q || '').slice(0, MAX_QUERY);
  const units = [], seen = new Set();
  const n = q.length;
  let i = 0;
  while (i < n && units.length < MAX_TERMS) {
    while (i < n && isSpace(q[i])) i++;
    if (i >= n) break;
    let neg = false;
    if (q[i] === '-') { neg = true; i++; }
    let raw;
    if (q[i] === '"') {
      const j = q.indexOf('"', i + 1), end = j < 0 ? n : j;
      raw = q.slice(i + 1, end); i = j < 0 ? n : j + 1;
    } else {
      let j = i;
      while (j < n && !isSpace(q[j])) j++;
      raw = q.slice(i, j); i = j;
    }
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const key = (neg ? '-' : '') + tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    units.push({ tokens, neg });
  }
  return { units, pos: units.filter(u => !u.neg), neg: units.filter(u => u.neg) };
}

const tokMatches = (qt, w) => (qt.length >= MIN_PREFIX ? w.startsWith(qt) : w === qt);

function countPhrase(hay, ph) {
  let c = 0;
  const k = ph.length;
  outer: for (let i = 0; i + k <= hay.length; i++) {
    for (let j = 0; j < k; j++) if (hay[i + j] !== ph[j]) continue outer;
    c++;
  }
  return c;
}

// ---------- in-memory index ----------
// term -> (note id -> packed term counts per field). Statistics for ranking (note count, average field
// lengths, document frequency) are computed per request over only the notes the caller may see, so
// private notes cannot influence scores returned to the AI.
const pack = (t, g, b) => b * 1048576 + g * 1024 + t;
const unT = v => v % 1024, unG = v => Math.floor(v / 1024) % 1024, unB = v => Math.floor(v / 1048576);

function createIndex() {
  const docs = new Map();  // id -> { id, ref, private, tags, updated, lt, lg, lb, terms }
  const post = new Map();  // term -> Map(id -> packed)
  const stats = { all: { n: 0, t: 0, g: 0, b: 0 }, shared: { n: 0, t: 0, g: 0, b: 0 } };

  function bump(d, sign) {
    for (const s of d.private ? [stats.all] : [stats.all, stats.shared]) { s.n += sign; s.t += sign * d.lt; s.g += sign * d.lg; s.b += sign * d.lb; }
  }
  function remove(id) {
    const d = docs.get(id);
    if (!d) return;
    for (const term of d.terms) { const m = post.get(term); if (m) { m.delete(id); if (!m.size) post.delete(term); } }
    bump(d, -1); docs.delete(id);
  }
  function add(note) {
    const tt = tokenize(note.title), tg = tokenize((note.tags || []).join(' ')), tb = tokenize(note.body);
    const counts = new Map();
    const feed = (arr, f) => { for (const w of arr) { let c = counts.get(w); if (!c) counts.set(w, c = [0, 0, 0]); c[f]++; } };
    feed(tt, 0); feed(tg, 1); feed(tb, 2);
    const d = { id: note.id, ref: note, private: !!note.private, tags: note.tags || [], updated: note.updated || '', lt: tt.length, lg: tg.length, lb: tb.length, terms: new Set(counts.keys()) };
    for (const [w, c] of counts) {
      let m = post.get(w);
      if (!m) post.set(w, m = new Map());
      m.set(note.id, pack(Math.min(c[0], 1023), Math.min(c[1], 1023), c[2]));
    }
    docs.set(note.id, d); bump(d, 1);
  }
  function upsert(note) { remove(note.id); add(note); }

  // Per-document weighted counts [title, tags, body] for one word; prefix-only matches count half.
  function wordHits(t, ok) {
    const hits = new Map();
    const take = (m, w) => {
      for (const [id, v] of m) {
        const d = docs.get(id);
        if (!ok(d)) continue;
        let h = hits.get(id);
        if (!h) hits.set(id, h = [0, 0, 0]);
        h[0] += w * unT(v); h[1] += w * unG(v); h[2] += w * unB(v);
      }
    };
    const exact = post.get(t);
    if (exact) take(exact, 1);
    if (t.length >= MIN_PREFIX) for (const [term, m] of post) if (term !== t && term.startsWith(t)) take(m, PREFIX_W);
    return hits;
  }
  // Phrase units are verified together: every candidate note is tokenised once, however many phrases the
  // query holds (12 phrases over a big library would otherwise re-read every note 12 times).
  function phraseHitsMany(phrases, ok) {
    const res = phrases.map(() => new Map()), cand = new Map(); // cand: note id -> indexes of the phrases to check
    phrases.forEach((tokens, k) => {
      const lists = [];
      for (const t of tokens) { const m = post.get(t); if (!m) return; lists.push(m); }
      lists.sort((a, b) => a.size - b.size);
      for (const id of lists[0].keys()) {
        if (!ok(docs.get(id)) || !lists.every(m => m.has(id))) continue;
        const a = cand.get(id);
        if (a) a.push(k); else cand.set(id, [k]);
      }
    });
    for (const [id, ks] of cand) {
      const d = docs.get(id), tt = tokenize(d.ref.title), tg = d.tags.map(tokenize), tb = tokenize(d.ref.body);
      for (const k of ks) {
        const ct = countPhrase(tt, phrases[k]);
        let cg = 0;
        for (const x of tg) cg += countPhrase(x, phrases[k]);
        const cb = countPhrase(tb, phrases[k]);
        if (ct + cg + cb) res[k].set(id, [ct, cg, cb]);
      }
    }
    return res;
  }
  // Hit maps for a list of query units, in order: single words from the postings, phrases verified together.
  function unitHits(us, ok) {
    const out = us.map(u => (u.tokens.length > 1 ? null : wordHits(u.tokens[0], ok)));
    const at = [];
    us.forEach((u, i) => { if (!out[i]) at.push(i); });
    phraseHitsMany(at.map(i => us[i].tokens), ok).forEach((m, k) => { out[at[k]] = m; });
    return out;
  }

  // Returns { hits: [{ id, score }], query }. includePrivate=false is the AI scope.
  function search(q, { includePrivate = true, tag = '' } = {}) {
    const query = typeof q === 'string' ? parseQuery(q) : q;
    const tagL = String(tag || '').toLowerCase();
    const ok = d => !!d && (includePrivate || !d.private) && (!tagL || d.tags.includes(tagL));
    const stat = includePrivate ? stats.all : stats.shared;

    const exclude = new Set();
    for (const m of unitHits(query.neg, ok)) for (const id of m.keys()) exclude.add(id);

    const units = unitHits(query.pos, ok);
    let ids;
    if (!query.units.length) return { hits: [], query }; // nothing usable in the query
    if (!units.length) {
      ids = [];
      for (const d of docs.values()) if (ok(d) && !exclude.has(d.id)) ids.push(d.id);
      ids.sort((a, b) => docs.get(b).updated.localeCompare(docs.get(a).updated));
      return { hits: ids.map(id => ({ id, score: 0 })), query };
    }
    const order = units.map((m, i) => i).sort((a, b) => units[a].size - units[b].size);
    ids = [];
    for (const id of units[order[0]].keys()) if (!exclude.has(id) && units.every(m => m.has(id))) ids.push(id);

    const N = stat.n;
    const avg = { t: stat.n ? stat.t / stat.n : 1, g: stat.n ? stat.g / stat.n : 1, b: stat.n ? stat.b / stat.n : 1 };
    for (const k of ['t', 'g', 'b']) if (avg[k] < 1) avg[k] = 1;
    const idf = units.map(m => Math.log(1 + (N - m.size + 0.5) / (m.size + 0.5)));
    const hits = ids.map(id => {
      const d = docs.get(id);
      const nt = 1 - B + B * d.lt / avg.t, ng = 1 - B + B * d.lg / avg.g, nb = 1 - B + B * d.lb / avg.b;
      let score = 0;
      for (let i = 0; i < units.length; i++) {
        const h = units[i].get(id);
        const tf = FIELD_W.t * h[0] / nt + FIELD_W.g * h[1] / ng + FIELD_W.b * h[2] / nb;
        score += idf[i] * tf / (K1 + tf);
      }
      return { id, score, u: d.updated };
    });
    hits.sort((a, b) => b.score - a.score || b.u.localeCompare(a.u) || (a.id < b.id ? -1 : 1));
    return { hits: hits.map(({ id, score }) => ({ id, score })), query };
  }

  return { add, upsert, remove, search, size: () => docs.size, has: id => docs.has(id) };
}

// ---------- plain text ----------
function stripTags(s) { // removes <tag ...> spans; an unterminated tag drops the rest of the text
  let out = '', i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return out + s.slice(i);
    const c = s[lt + 1];
    if (!(c && (c === '/' || c === '!' || c === '?' || (c.toLowerCase() !== c.toUpperCase())))) { out += s.slice(i, lt + 1); i = lt + 1; continue; }
    const gt = s.indexOf('>', lt);
    if (gt < 0) return out + s.slice(i, lt);
    out += s.slice(i, lt) + ' '; i = gt + 1;
  }
}
// Bounded quantifiers keep every pattern linear. Used on short passages and headings only.
function plainText(s) {
  s = stripTags(String(s || ''));
  s = s.replace(/!?\[([^\]\n]{0,300})\]\([^)\n]{0,1000}\)/g, '$1');
  s = s.replace(/^[ \t]*(?:#{1,6}|(?:>[ \t]*)+|[-*+]|\d{1,3}[.)])[ \t]+/gm, '');
  s = s.replace(/[`*~]+/g, ' ').replace(/(^|\s)_+|_+(?=\s|$)/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

// ---------- outline / sections ----------
// ATX headings (# .. ######) outside fenced code blocks. Flat list: each section runs from its heading
// to the next heading of any level. A first untitled section (level 0) holds text before the first heading.
function parseSections(body) {
  body = String(body || '');
  const heads = [];
  let fence = null; // { ch, len }
  let pos = 0;
  while (pos <= body.length) {
    let nl = body.indexOf('\n', pos);
    if (nl < 0) nl = body.length;
    let line = body.slice(pos, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    let ind = 0;
    while (ind < 3 && line[ind] === ' ') ind++;
    const c = line[ind];
    if (fence) {
      let run = 0;
      while (line[ind + run] === fence.ch) run++;
      if (run >= fence.len && line.slice(ind + run).trim() === '') fence = null;
    } else if (c === '`' || c === '~') {
      let run = 0;
      while (line[ind + run] === c) run++;
      if (run >= 3) fence = { ch: c, len: run };
    } else if (c === '#') {
      let level = 0;
      while (line[ind + level] === '#') level++;
      const after = line[ind + level];
      if (level <= 6 && (after === undefined || after === ' ' || after === '\t')) {
        let text = line.slice(ind + level).trim();
        let e = text.length;
        while (e > 0 && text[e - 1] === '#') e--;
        if (e === 0) text = '';
        else if (e < text.length && (text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trim();
        heads.push({ heading: plainText(text), level, start: pos });
      }
    }
    pos = nl + 1;
  }
  const sections = [];
  if (!heads.length) {
    if (body.trim()) sections.push({ heading: '', level: 0, start: 0, length: body.length });
  } else {
    if (body.slice(0, heads[0].start).trim()) sections.push({ heading: '', level: 0, start: 0, length: heads[0].start });
    heads.forEach((h, i) => sections.push({ heading: h.heading, level: h.level, start: h.start, length: (i + 1 < heads.length ? heads[i + 1].start : body.length) - h.start }));
  }
  return sections.map((s, index) => ({ index, ...s }));
}

// Slice that never cuts a surrogate pair in half.
function sliceText(text, offset, limit) {
  let s = offset, e = Math.min(text.length, offset + limit);
  if (s > 0 && s < text.length && text.charCodeAt(s) >= 0xdc00 && text.charCodeAt(s) <= 0xdfff) s++;
  if (e < text.length && e > s && text.charCodeAt(e - 1) >= 0xd800 && text.charCodeAt(e - 1) <= 0xdbff) e = e - 1 > s ? e - 1 : e + 1; // a 1-character window on an emoji takes the whole emoji, so paging always advances
  return { offset: s, text: text.slice(s, Math.max(s, e)) };
}

// ---------- snippets ----------
function snippets(note, query, { max = SNIP_MAX, width = SNIP_WIDTH } = {}) {
  const body = String(note.body || '');
  if (!body.trim() || !query.pos.length) return [];
  const sections = parseSections(body);
  const headingAt = p => { let h = null; for (const s of sections) { if (s.start <= p) h = s; else break; } return h && h.heading ? h.heading : null; };

  const toks = tokenizePos(body), M = [];
  for (let i = 0; i < toks.length; i++) {
    query.pos.forEach((u, ui) => {
      const k = u.tokens.length;
      if (k === 1) { if (tokMatches(u.tokens[0], toks[i].w)) M.push({ s: toks[i].s, e: toks[i].e, u: ui }); }
      else if (i + k <= toks.length && u.tokens.every((t, j) => toks[i + j].w === t)) M.push({ s: toks[i].s, e: toks[i + k - 1].e, u: ui });
    });
  }
  const cut = (ws, anchor) => { // trim a raw window to whole (whitespace-delimited) words, keeping the match inside
    let we = Math.min(body.length, ws + width);
    if (ws > 0 && !isSpace(body[ws - 1]) && !isSpace(body[ws])) {
      let f = ws; while (f < anchor.s && !isSpace(body[f])) f++;
      if (f < anchor.s) ws = f + 1;
      else { let b = ws; while (b > 0 && ws - b < 40 && !isSpace(body[b - 1])) b--; ws = (b === 0 || isSpace(body[b - 1])) ? b : anchor.s; }
    }
    if (we < body.length && !isSpace(body[we]) && !isSpace(body[we - 1])) {
      let b = we; while (b > anchor.e && !isSpace(body[b - 1])) b--;
      if (b > anchor.e) we = b;
      else { let f = we; while (f < body.length && f - we < 50 && !isSpace(body[f])) f++; we = f; }
    }
    return { ws, we: Math.max(we, ws), text: plainText(body.slice(ws, Math.max(we, ws))) };
  };

  if (!M.length) { // matched in title or tags only: show the start of the note
    const w = cut(0, { s: 0, e: 0 });
    return w.text ? [{ text: w.text, heading: headingAt(0) }] : [];
  }
  const cands = [], cnt = new Array(query.pos.length).fill(0);
  let l = 0, r = 0, distinct = 0;
  for (let j = 0; j < M.length; j++) {
    const ws = Math.max(0, M[j].s - SNIP_LEAD), we = Math.min(body.length, ws + width);
    while (r < M.length && M[r].s < we) { if (cnt[M[r].u]++ === 0) distinct++; r++; }
    while (l < r && M[l].s < ws) { if (--cnt[M[l].u] === 0) distinct--; l++; }
    cands.push({ j, ws, we, score: distinct * 1e6 + (r - l) });
  }
  cands.sort((a, b) => b.score - a.score || a.j - b.j);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= max) break;
    if (picked.some(p => c.ws < p.we && p.ws < c.we)) continue;
    picked.push(c);
  }
  const out = [];
  for (const c of picked) {
    const w = cut(c.ws, M[c.j]);
    if (w.text) out.push({ text: w.text, heading: headingAt(M[c.j].s) });
  }
  return out;
}

module.exports = { MAX_QUERY, MAX_TERMS, MIN_PREFIX, tokenize, parseQuery, createIndex, plainText, parseSections, sliceText, snippets };
