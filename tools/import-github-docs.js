#!/usr/bin/env node
// Import the markdown docs of your GitHub repos into Kura: ONE note per repo ("GitHub: <repo>"),
// with a contents list and each file as a section, so the note list stays short.
// Zero dependencies. Safe to re-run: notes are matched by title and updated in place, never duplicated.
//
//   node tools/import-github-docs.js                 dry run: lists what would be imported, writes nothing
//   node tools/import-github-docs.js --apply         create/update the notes
//
// Options
//   --root <dir>      folder holding your cloned repos      (default: the folder above kura/)
//   --owner <name>    only repos owned by this GitHub user  (default: detected from the most common remote owner)
//   --remote          also fetch the README of public repos you have not cloned (uses GITHUB_TOKEN if set, else the unauthenticated API)
//   --skills          also import SKILL.md files and anything under .claude/skills
//   --max <n>         stop after n files (default 400)
//   --cleanup         delete the older one-note-per-file imports (title "repo: path.md", tag github). Needs a server that lets the
//                     AI token delete; otherwise delete them in the app (filter by the github tag).
//
// Env: KURA_URL (default http://127.0.0.1:4546), KURA_TOKEN (default: data/api-token next to this tool's parent folder),
//      GITHUB_TOKEN (optional, only for --remote).
//
// Notes are created with the AI token, so they are visible to the AI ("Shared"). Files that look like they contain
// secrets (private keys, tokens, password assignments) are SKIPPED and listed, because shared notes leave your machine
// when the AI reads them.

const fs = require('fs');
const path = require('path');
const ENV = n => (process.env['KURA_' + n] !== undefined ? process.env['KURA_' + n] : process.env['NOTEPAD_' + n]); // NOTEPAD_* still works
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const APPLY = flag('apply');
const ROOT = path.resolve(opt('root', path.join(__dirname, '..', '..')));
const BASE = (ENV('URL') || 'http://127.0.0.1:4546').replace(/\/+$/, '');
const MAX_FILES = Number(opt('max', 400));
const MAX_BODY = 190000;       // server cap is 200000 characters per note
const THROTTLE_MS = 2200;      // stay under 30 AI writes per minute
const SKIP_DIRS = new Set(['node_modules', '.git', '.git_broken', '.venv', 'venv']); // only for finding repos under --root
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{10,}/i,
];

const git = (dir, ...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

function parseRemote(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url || '');
  return m ? { owner: m[1], repo: m[2] } : null;
}

function findRepos() {
  const repos = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    const dir = path.join(ROOT, e.name);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const r = parseRemote(git(dir, 'remote', 'get-url', 'origin'));
    if (r) repos.push({ ...r, dir, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main' });
  }
  return repos;
}

// Only files git tracks count as "GitHub items": that leaves out vendored upstream docs, virtualenvs and ignored scratch files.
function trackedDocs(dir) {
  const out = git(dir, 'ls-files', '-z', '--', '*.md', '*.markdown');
  return out ? out.split('\0').filter(Boolean) : [];
}

const norm = p => p.split(path.sep).join('/');

function collect() {
  let repos = findRepos();
  const owner = opt('owner', (() => {
    const c = {}; for (const r of repos) c[r.owner] = (c[r.owner] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
  })());
  repos = repos.filter(r => r.owner.toLowerCase() === String(owner).toLowerCase());
  const items = [], skipped = [];
  for (const r of repos) {
    for (const rel of trackedDocs(r.dir).sort()) {
      const f = path.join(r.dir, rel);
      if (!fs.existsSync(f)) continue; // tracked but deleted locally
      if (!flag('skills') && (/(^|\/)SKILL\.md$/.test(rel) || rel.includes('.claude/skills/'))) { skipped.push([r.repo + '/' + rel, 'skill file (use --skills)']); continue; }
      let text = fs.readFileSync(f, 'utf8');
      if (!text.trim()) { skipped.push([r.repo + '/' + rel, 'empty']); continue; }
      const hit = SECRET_PATTERNS.find(p => p.test(text));
      if (hit) { skipped.push([r.repo + '/' + rel, 'looks like it contains a secret']); continue; }
      let truncated = false;
      if (text.length > MAX_BODY) { text = text.slice(0, MAX_BODY); truncated = true; }
      items.push({ repo: r.repo, owner: r.owner, rel, branch: r.branch, text, truncated, where: 'local' });
    }
  }
  return { items: items.slice(0, MAX_FILES), skipped, owner, repos };
}

async function fetchRemoteReadmes(owner, haveRepos, items, skipped) {
  const headers = { 'User-Agent': 'kura-import', Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) };
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&type=owner`, { headers });
  if (!res.ok) { skipped.push(['(remote repo list)', 'GitHub said ' + res.status + (res.status === 403 ? ' (rate limit; set GITHUB_TOKEN)' : '')]); return; }
  const list = await res.json();
  const have = new Set(haveRepos.map(r => r.repo.toLowerCase()));
  for (const r of list) {
    if (have.has(r.name.toLowerCase()) || r.fork) continue;
    const rr = await fetch(`https://api.github.com/repos/${owner}/${r.name}/readme`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
    if (!rr.ok) { skipped.push([r.name + '/README', 'no readme (' + rr.status + ')']); continue; }
    let text = await rr.text();
    if (SECRET_PATTERNS.some(p => p.test(text))) { skipped.push([r.name + '/README', 'looks like it contains a secret']); continue; }
    items.push({ repo: r.name, owner, rel: 'README.md', branch: r.default_branch || 'main', text: text.slice(0, MAX_BODY), truncated: text.length > MAX_BODY, where: 'remote' });
  }
}

function tokenValue() {
  if (ENV('TOKEN')) return ENV('TOKEN').trim();
  try { return fs.readFileSync(path.join(__dirname, '..', 'data', 'api-token'), 'utf8').trim(); } catch { return ''; }
}
async function api(p, method = 'GET', body) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: 'Bearer ' + tokenValue(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${d.error || ''}`);
  return d;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const demote = text => {           // push headings down so a file's "# Title" sits under the section heading
  let fence = false;
  return text.split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    return !fence && /^#{1,6}\s/.test(l) ? '##' + l : l;
  }).map(l => l.replace(/^#{7,}/, '######')).join('\n');
};

function groupByRepo(items) {
  const g = new Map();
  for (const it of items) { if (!g.has(it.repo)) g.set(it.repo, []); g.get(it.repo).push(it); }
  const notes = [];
  for (const [repo, files] of g) {
    const { owner, branch } = files[0];
    const head = `Docs from [${owner}/${repo}](https://github.com/${owner}/${repo}), imported from the repository. ${files.length} file${files.length === 1 ? '' : 's'}.`;
    const toc = files.length > 1 ? '\n\n' + files.map(f => `- ${f.rel}`).join('\n') : '';
    let body = head + toc, truncated = false;
    for (const f of files) {
      const section = `\n\n---\n\n## ${f.rel}\n\n[View on GitHub](https://github.com/${owner}/${repo}/blob/${branch}/${f.rel})\n\n${demote(f.text)}`;
      if (body.length + section.length > MAX_BODY) { truncated = true; break; }
      body += section;
    }
    if (truncated) body += '\n\n(Some files were left out because the note would be too long. Open the repository for the rest.)';
    notes.push({ title: `GitHub: ${repo}`, body, tags: ['github', repo.toLowerCase().replace(/[^a-z0-9-_]/g, '-')], files: files.length });
  }
  return notes;
}

(async () => {
  const { items, skipped, owner, repos } = collect();
  if (flag('remote') && owner) await fetchRemoteReadmes(owner, repos, items, skipped);
  const notes = groupByRepo(items);
  console.log(`Owner: ${owner || '(none found)'}   Repos with a GitHub remote under ${ROOT}: ${repos.length}`);
  console.log(`Markdown files found: ${items.length}  ->  notes to create or update: ${notes.length}`);
  for (const n of notes) console.log(`  ${n.title}  (${n.files} file${n.files === 1 ? '' : 's'}, ${n.body.length} chars)`);
  if (skipped.length) { console.log(`Skipped ${skipped.length}:`); for (const [f, why] of skipped.slice(0, 40)) console.log(`  ${f}  (${why})`); if (skipped.length > 40) console.log(`  ... and ${skipped.length - 40} more`); }
  if (!APPLY && !flag('cleanup')) { console.log('\nDry run only. Re-run with --apply (Kura server running and unlocked) to import.'); return; }

  if (!tokenValue()) throw new Error('No AI token. Start the Kura server once, or set KURA_TOKEN.');
  const list = await api('/api/notes?tag=github&limit=500&full=1');
  const existing = new Map(list.notes.map(n => [n.title, n]));
  let created = 0, updated = 0, same = 0, failed = 0;
  if (APPLY) for (const n of notes) {
    try {
      const old = existing.get(n.title);
      if (old && old.body === n.body) { same++; continue; }
      if (old) { await api('/api/notes/' + old.id, 'PUT', { body: n.body, tags: n.tags }); updated++; }
      else { await api('/api/notes', 'POST', { title: n.title, body: n.body, tags: n.tags }); created++; }
      process.stdout.write(`\r${created} created, ${updated} updated, ${same} unchanged`);
      await sleep(THROTTLE_MS);
    } catch (e) { failed++; console.log(`\n  failed ${n.title}: ${e.message}`); if (/429|unreachable|ECONN/.test(e.message)) await sleep(15000); }
  }
  if (APPLY) console.log(`\nDone: ${created} created, ${updated} updated, ${same} unchanged, ${failed} failed.`);

  if (flag('cleanup')) {
    // Older imports: one note per file, titled "repo: path.md". Only notes tagged github with that exact shape are touched.
    const old = list.notes.filter(n => /^[\w.-]+: .+\.(md|markdown)$/i.test(n.title) && n.tags.includes('github'));
    let gone = 0;
    for (const n of old) {
      try { await api('/api/notes/' + n.id, 'DELETE'); gone++; await sleep(300); }
      catch (e) { console.log(`Could not delete "${n.title}": ${e.message}`); if (/403/.test(e.message)) { console.log('The AI token is not allowed to delete. Delete them in the app: filter by the "github" tag.'); break; } }
    }
    console.log(`Cleanup: ${gone} of ${old.length} old per-file notes deleted.`);
  }
})().catch(e => { console.error('\n' + e.message); process.exit(1); });
