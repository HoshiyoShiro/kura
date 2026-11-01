const $ = id => document.getElementById(id);
const state = { q: '', tag: '', sel: null, limit: 100, warned: 0 };
const IDLE_MS = 15 * 60 * 1000;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;

let toastTimer;
function hideToast() { clearTimeout(toastTimer); $('toast').hidden = true; }
function toast(msg, bad, action) {
  const t = $('toast');
  t.className = bad ? 'bad' : ''; t.textContent = msg;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { hideToast(); action.fn(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, bad ? 6000 : action ? 9000 : 3000);
}

async function j(url, method, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Can't reach the notepad server. Check that it is running and unlocked.");
  }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && d.error === 'Not signed in.') { showLogin(); throw new Error('locked'); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong (' + r.status + ').');
  return d;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso) {
  const d = new Date(iso), n = new Date();
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.getDate() + ' ' + MON[d.getMonth()] + (d.getFullYear() !== n.getFullYear() ? ' ' + d.getFullYear() : '');
}

// A note that starts with its own title as a heading would show the title twice.
function dropTitle(text, title) {
  const m = String(text || '').match(/^\s*#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  return m && m[1].trim().toLowerCase() === String(title || '').trim().toLowerCase() ? text.slice(m[0].length) : text;
}
const stamp = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// List previews read as text, not markdown source.
const plain = s => String(s || '').replace(/```/g, ' ').replace(/^\s*(#{1,6}|[-*>]|\d+\.)\s+/gm, '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();

/* ---- screens ---- */
const showList = () => document.body.classList.remove('view-note');
const showNote = () => document.body.classList.add('view-note');

function showLogin() {
  state.sel = null; state.limit = 100; state.warned = 0; showList(); clearTimeout(idleTimer);
  $('app').hidden = true; $('main').hidden = true; $('login').hidden = false;
  $('main').innerHTML = ''; $('list').innerHTML = ''; $('tags').innerHTML = ''; $('q').value = ''; state.q = ''; state.tag = '';
  $('pass').value = ''; $('pass').focus();
}
function showApp() {
  $('login').hidden = true; $('app').hidden = false; $('main').hidden = false;
  blank(); showList(); refresh().catch(e => toast(e.message, true)); bump();
}
function blank() {
  $('main').innerHTML = `<div class="blank"><h2>Pick a note</h2><p>Choose one from the list, search for it, or ask the AI to take a new one.</p></div>`;
}

const PAGE = 100;
let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  const [{ notes, next, skipped }, { tags }] = await Promise.all([
    j('/api/notes?q=' + encodeURIComponent(state.q) + '&tag=' + encodeURIComponent(state.tag) + '&limit=' + state.limit), j('/api/tags')]);
  if (seq !== refreshSeq) return; // a newer search is already running
  if (skipped && skipped !== state.warned) { state.warned = skipped; toast(skipped + (skipped === 1 ? " note couldn't" : " notes couldn't") + ' be read. The files may be damaged.', true); }
  $('tags').innerHTML = tags.length
    ? `<button class="chip ${state.tag ? '' : 'on'}" data-t="" aria-pressed="${!state.tag}">All</button>` + tags.map(t =>
      `<button class="chip ${t.tag === state.tag ? 'on' : ''}" data-t="${esc(t.tag)}" aria-pressed="${t.tag === state.tag}">${esc(t.tag)}<b>${t.count}</b></button>`).join('')
    : '';
  const rows = notes.map(n => `
    <button class="note-row" data-id="${esc(n.id)}" ${n.id === state.sel ? 'aria-current="true"' : ''}>
      <span class="r-title">${n.private ? icon('lock') : ''}<span>${esc(n.title)}</span></span>
      <span class="r-prev">${esc(plain(dropTitle(n.preview, n.title))) || 'Empty note'}</span>
      <span class="r-meta">${n.private ? `<span class="pill priv">${icon('lock')}Private</span>` : `<span class="pill ai">${icon('spark')}Shared with AI</span>`}${n.source === 'ai' ? '<span>by AI</span>' : n.editedBy === 'ai' ? '<span>AI edited</span>' : ''}<time datetime="${esc(n.updated)}">${esc(when(n.updated))}</time></span>
    </button>`).join('');
  $('list').innerHTML = rows
    ? rows + (next ? '<div class="more-wrap"><button class="btn" id="more" type="button">Show more notes</button></div>' : '')
    : (state.q || state.tag
      ? `<div class="blank pad"><h2>No matches</h2><p>Nothing found${state.q ? ' for \u201c' + esc(state.q) + '\u201d' : ''}${state.tag ? ' tagged ' + esc(state.tag) : ''}. Try fewer words, or pick All.</p></div>`
      : `<div class="blank pad"><h2>No notes yet</h2><p>Press New to write one, or ask the AI to take a note for you.</p></div>`);
}

function visibility(n) {
  return n.private
    ? `<span class="pill priv">${icon('lock')}Private</span>`
    : `<span class="pill ai">${icon('spark')}Shared with AI</span>`;
}

async function open(id) {
  state.sel = id;
  const n = await j('/api/notes/' + id);
  showNote();
  const acts = `<button class="btn" id="edit" type="button">Edit</button><button class="btn danger" id="del" type="button">Delete</button>`;
  $('main').innerHTML = `<div class="pane">
    <div class="head">
      <button class="btn quiet back" id="back" type="button" aria-label="Back to notes">${icon('back')}Notes</button>
      <h1>${esc(n.title)}</h1>
      <div class="acts" id="acts">${acts}</div>
    </div>
    <div class="facts">${visibility(n)}${n.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}
      <span>${n.source === 'ai' && n.editedBy !== 'you' ? 'written by AI \u00b7 ' : n.editedBy === 'ai' ? 'last edited by AI \u00b7 ' : ''}updated ${esc(stamp(n.updated))}</span></div>
    <div class="note">${md(dropTitle(n.body, n.title)) || '<p class="hint">This note is empty.</p>'}</div>
  </div>`;
  $('main').scrollTop = 0;
  $('back').onclick = () => { showList(); state.sel = null; refresh().catch(() => {}); };
  const wire = () => {
    $('edit').onclick = () => edit(n);
    $('del').onclick = () => {
      $('acts').innerHTML = `<span class="ask">Delete this note?</span><button class="btn danger" id="yes" type="button">Delete</button><button class="btn" id="keep" type="button">Keep</button>`;
      $('keep').focus();
      $('keep').onclick = () => { $('acts').innerHTML = acts; wire(); $('del').focus(); };
      $('yes').onclick = () => j('/api/notes/' + id, 'DELETE').then(() => {
        state.sel = null; blank(); showList();
        toast('Note deleted.', false, { label: 'Undo', fn: async () => {
          try {
            const r = await j('/api/notes', 'POST', { title: n.title, body: n.body, tags: n.tags, private: n.private });
            toast('Note restored.'); await refresh(); await open(r.id);
          } catch (e) { toast(e.message, true); }
        } });
        return refresh();
      }).catch(e => toast(e.message, true));
    };
  };
  wire();
  refresh().catch(() => {});
}

// n without an id is a draft: nothing exists on the server until Save.
function edit(n) {
  showNote();
  const isNew = !n.id;
  $('main').innerHTML = `<form class="pane" id="ef">
    <div class="head"><button class="btn quiet back" id="cancelTop" type="button" aria-label="Cancel and go back">${icon('back')}Back</button><h1>${isNew ? 'New note' : 'Edit note'}</h1></div>
    <div class="field"><label for="et">Title</label><input id="et" type="text" class="big" maxlength="200" value="${esc(n.title)}" placeholder="What is this note about?" required></div>
    <div class="field"><label for="eg">Tags</label><input id="eg" type="text" value="${esc(n.tags.join(', '))}" placeholder="shopping, work">
      <small class="hint">Tags group notes. Pick one in the list to show only those notes.</small></div>
    <fieldset class="vis"><legend>Who can see this note?</legend>
      <label class="opt"><input type="radio" name="vis" value="private" ${n.private ? 'checked' : ''}><span><b>${icon('lock')}Private</b><small>Only you. The AI cannot read, search or edit it.</small></span></label>
      <label class="opt"><input type="radio" name="vis" value="shared" ${n.private ? '' : 'checked'}><span><b>${icon('spark')}Shared with AI</b><small>The AI can read, search and edit it.</small></span></label>
    </fieldset>
    <div class="field"><label for="eb">Note <span class="hint">\u00b7 lists, bold and links work (markdown)</span></label><textarea id="eb">${esc(n.body)}</textarea></div>
    <div class="bar"><button class="btn pri" id="save" type="submit">Save</button><button class="btn" id="cancel" type="button">Cancel</button></div>
  </form>`;
  $('et').focus();
  const cancel = () => { if (isNew) { blank(); showList(); } else open(n.id).catch(e => toast(e.message, true)); };
  $('cancel').onclick = cancel; $('cancelTop').onclick = cancel;
  $('ef').onsubmit = async e => {
    e.preventDefault(); $('save').disabled = true;
    const body = { title: $('et').value, tags: $('eg').value, body: $('eb').value, private: document.querySelector('input[name=vis]:checked').value === 'private' };
    try {
      const saved = isNew ? await j('/api/notes', 'POST', body) : await j('/api/notes/' + n.id, 'PUT', body);
      toast(body.private ? 'Saved. Private: hidden from the AI.' : 'Saved. Shared with AI.'); await open(saved.id || n.id);
    } catch (err) { toast(err.message, true); $('save').disabled = false; }
  };
  $('eb').onkeydown = e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('ef').requestSubmit(); } };
}

async function settings() {
  state.sel = null; refresh().catch(() => {});
  const { devices } = await j('/api/devices');
  showNote();
  $('main').innerHTML = `<div class="pane">
    <div class="head"><button class="btn quiet back" id="back" type="button" aria-label="Back to notes">${icon('back')}Notes</button><h1>Settings</h1></div>
    <section class="panel"><h2>Signed-in devices</h2>
      ${devices.map(d => `<div class="dev"><span>${esc(d.name)}<small>added ${esc(new Date(d.created).toLocaleDateString())}${d.lastUsed ? ', last used ' + esc(new Date(d.lastUsed).toLocaleString()) : ''}</small></span><button class="btn danger" type="button" data-rev="${esc(d.id)}" aria-label="Revoke ${esc(d.name)}">Revoke</button></div>`).join('') || '<p>No devices signed in.</p>'}
    </section>
    <section class="panel"><h2>AI access token</h2>
      <p>Rotating replaces the token file the MCP server reads. Nothing else to update.</p>
      <div class="field"><label for="rp">Passphrase</label><input id="rp" type="password" autocomplete="current-password"></div>
      <div class="bar"><button class="btn" id="rot" type="button">Rotate AI token</button></div><p class="err" id="rerr" role="status"></p></section>
    <section class="panel"><h2>Change passphrase</h2>
      <p>Re-encrypts every note. Other web sessions are signed out; devices stay signed in.</p>
      <div class="field"><label for="cp">Current passphrase</label><input id="cp" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="np">New passphrase (12+ characters)</label><input id="np" type="password" autocomplete="new-password"></div>
      <div class="field"><label for="np2">Repeat new passphrase</label><input id="np2" type="password" autocomplete="new-password"></div>
      <div class="bar"><button class="btn" id="chg" type="button">Change passphrase</button></div><p class="err" id="cerr" role="status"></p></section>
    <section class="panel"><h2>Export</h2>
      <p>Downloads all notes, including private ones, as readable JSON. Keep the file safe.</p>
      <div class="bar"><a class="btn" href="/api/export" download>Export decrypted JSON</a></div></section>
  </div>`;
  $('back').onclick = () => { blank(); showList(); };
  $('main').onclick = async e => {
    const id = e.target.dataset && e.target.dataset.rev; if (!id) return;
    try { await j('/api/devices/' + id, 'DELETE'); toast('Device revoked.'); settings(); } catch (err) { toast(err.message, true); }
  };
  $('rot').onclick = async () => {
    $('rerr').className = 'err'; $('rerr').textContent = '';
    try { await j('/api/ai-token/rotate', 'POST', { passphrase: $('rp').value }); $('rp').value = ''; $('rerr').className = 'ok'; $('rerr').textContent = 'AI token rotated.'; }
    catch (err) { $('rerr').textContent = err.message; }
  };
  $('chg').onclick = async () => {
    $('cerr').className = 'err'; $('cerr').textContent = '';
    if ($('np').value !== $('np2').value) { $('cerr').textContent = 'The new passphrases do not match.'; return; }
    try {
      await j('/api/passphrase', 'POST', { current: $('cp').value, next: $('np').value });
      $('cp').value = $('np').value = $('np2').value = '';
      $('cerr').className = 'ok'; $('cerr').textContent = 'Passphrase changed. All notes re-encrypted.';
    } catch (err) { $('cerr').textContent = err.message; }
  };
}

/* ---- auto-lock after idle ---- */
let idleTimer;
async function lockNow() { try { await j('/api/logout', 'POST', {}); } catch { /* already locked */ } showLogin(); }
function bump() { clearTimeout(idleTimer); if (!$('app').hidden) idleTimer = setTimeout(lockNow, IDLE_MS); }
['pointerdown', 'keydown', 'scroll'].forEach(ev => addEventListener(ev, bump, { passive: true, capture: true }));

/* ---- wiring ---- */
$('login').onsubmit = async e => {
  e.preventDefault(); $('loginerr').textContent = '';
  try { await j('/api/login', 'POST', { passphrase: $('pass').value }); $('pass').value = ''; showApp(); }
  catch (err) { $('loginerr').textContent = err.message; }
};
$('out').onclick = lockNow;
$('cfg').onclick = () => settings().catch(e => e.message !== 'locked' && toast(e.message, true));
$('q').oninput = e => { state.q = e.target.value; state.limit = 100; refresh().catch(() => {}); };
$('tags').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; const t = b.dataset.t; state.tag = (t === '' || state.tag === t) ? '' : t; state.limit = 100; refresh().catch(() => {}); };
$('list').onclick = e => { if (e.target.closest('#more')) { state.limit += 100; refresh().catch(() => {}); return; } const it = e.target.closest('.note-row'); if (it) open(it.dataset.id).catch(err => toast(err.message, true)); };
// New notes start Private (the safer default) and exist only in the form until Save.
$('new').onclick = () => edit({ title: '', body: '', tags: [], private: true });
addEventListener('keydown', e => {
  if (e.key === '/' && !$('app').hidden && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('q').focus(); }
});
setInterval(() => { if (!document.hidden && !$('app').hidden && !document.querySelector('#eb')) refresh().catch(() => {}); }, 5000); // picks up AI-added notes

fetch('/api/session').then(r => r.ok ? showApp() : showLogin());
