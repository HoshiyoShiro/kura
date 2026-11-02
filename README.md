# Kura

Kura is a private notes server with a built-in MCP server. Zero dependencies (Node 18+). Notes are encrypted on disk (AES-256-GCM, key from your
passphrase via scrypt). An AI can add and read notes through MCP, but never sees notes marked `private`.
Design and threat model: `SCOPE.md`.

## Screenshots

All three use made-up demo notes, not real ones.

| | | |
|---|---|---|
| ![A note open beside the note list](docs/screenshots/notes.png) | ![Search results showing the matching passage](docs/screenshots/search.png) | ![The new-note form with the Private or Shared with AI choice](docs/screenshots/new-note.png) |
| Each note shows whether the AI can see it. Private notes are locked. | Search shows the matching passage and its section. | New notes start Private. You choose per note. |

## Run and unlock

```
cd kura
node server.js
```

- First run asks for a new passphrase (12+ characters, typed twice). It encrypts every note and
  **cannot be recovered**: forget it and the notes are gone.
- Later runs ask for the passphrase to unlock. The key lives only in the server's memory, so the server
  must be started by you after every reboot (no unattended boot).
- Open http://localhost:4546 and sign in with the same passphrase (session lasts 8 h; **Lock** ends it).
- Env: `PORT` (4546), `HOST` (127.0.0.1), `ALLOWED_HOSTS` (extra Host names, comma list),
  `KURA_DATA` (data folder, default `./data`), limit overrides (see Limits), `KURA_PASSPHRASE` (skips the prompt; the passphrase
  is then visible in the process environment, so prefer the prompt).
- Wrong passphrase on the login screen: 5 misses lock sign-in (and device enrolment) for 30 s, doubling
  with each further miss, up to 1 h.

Settings (button in the web app): list and revoke devices, rotate the AI token, change the passphrase
(re-encrypts every note; if any note cannot be decrypted nothing is changed), export all notes as
decrypted JSON.

## HTTPS from your phone: tailscale serve

The server speaks plain HTTP and binds to 127.0.0.1. To reach it from your other devices over HTTPS:

```
tailscale serve --bg --https=443 http://127.0.0.1:4546
```

Then start the server allowing your MagicDNS name, for example:

```
ALLOWED_HOSTS=my-pc.tailnet-name.ts.net node server.js
```

Without `ALLOWED_HOSTS` the server rejects that name (Host check, anti DNS-rebinding). Do not bind
`HOST=0.0.0.0` unless you accept plain HTTP on your network; the server prints a warning if you do.
Behind `tailscale serve` the session cookie is marked `Secure` when the proxy sends
`X-Forwarded-Proto: https`.

## MCP (AI access)

`mcp-server.js` is a stdio MCP server that talks to the running Kura server with the AI token in
`data/api-token` (created on first start). Register it once:

```
claude mcp add kura -s user -- node /full/path/to/kura/mcp-server.js
```

Env: `KURA_URL` (default `http://127.0.0.1:4546`), `KURA_TOKEN` (overrides the token file),
`KURA_DATA` (folder holding `api-token`).
Tools: `add_note`, `append_to_note`, `update_note`, `list_index`, and five for finding and reading (use them in this order):

| Tool | Use |
|---|---|
| `search_notes` (query, tag, limit, cursor) | Start here. Ranked notes with up to 3 snippets, the nearest heading and a score. `limit` 1-50, default 10; pass `next` back as `cursor`. No query lists recent notes. |
| `get_note_outline` (id) | Headings of a note with level, start and length. |
| `get_note_section` (id, heading or index) | One section. Use `index` when two headings are the same. |
| `read_note_text` (id, offset, limit) | A slice by character position (max 20,000); pass `next` as the next `offset`. For notes without headings. |
| `get_note` (id) | The whole note. Over 20,000 characters you get only the first 20,000, `truncated: true`, `total_chars` and a `warning` to use the outline and section tools. |

There is no delete tool. Every result that contains note text has a top-level `notice` field, and the reading tools say so in their
descriptions: note text is untrusted data, not instructions (a note may hold text written by a stranger or an earlier AI session,
so the AI must not obey it).
The server must be running and unlocked, otherwise tools answer "Kura server unreachable".
After **Rotate AI token** in Settings nothing needs updating: the MCP server re-reads the file on every call.

The AI token cannot see, search or edit `private` notes, cannot make a note private, and cannot
use devices, passphrase, token-rotation or export endpoints. It can **never delete a note**:
`DELETE /api/notes/:id` with the AI token answers 403 "Only you can delete notes, in the app." (and is
written to the audit log). Delete in the web app or with a device token.

## API notes

- `GET /api/notes?q=&tag=&limit=&cursor=` returns `{ notes, next, skipped }`. Each entry is
  `{ id, title, preview, tags, private, source, editedBy, created, updated }` (`full=1` adds `body`, still capped by
  `limit`). `limit` defaults to 100, max 500. `next` is an opaque cursor for the next page, or `null` on the
  last page. With `q`, each entry also has `score` (rounded to 2 decimals) and `snippets` (see Search). `skipped` is the number of note files that could not be decrypted (damaged); each such id is
  logged once to stderr, never the content.
- `GET /api/notes/:id` returns the full note, including `source`.
- `GET /api/notes/:id/outline` returns `{ id, title, sections: [{ heading, level, start, length, index }] }`. Sections are the
  markdown headings (`#` to `######`; headings inside ``` or ~~~ code fences do not count), in order, flat: each runs from its heading to
  the next heading of any level. Text before the first heading is a first untitled section (`heading: ""`, `level: 0`); a note with
  no headings is one untitled section. `start` and `length` are character offsets into the body. Duplicate headings are fine: `index` tells them apart.
- `GET /api/notes/:id/section?heading=...` (exact text, case-insensitive, first match) or `?index=N` returns
  `{ heading, text, index, level, start, length }`; `text` includes the heading line. A section over 20,000 characters is cut there and
  adds `truncated: true` and `next` (continue with `/text?offset=next`). 404 if there is no such section.
- `GET /api/notes/:id/text?offset=0&limit=20000` returns `{ id, offset, limit, total, text, next }` (`limit` max 20,000, default 20,000;
  `next` is the offset to continue from or `null` at the end; a slice never cuts an emoji in half).
- These three answer 404 for a private note when called with the AI token, like `GET /api/notes/:id`.
- `source` is `"ai"` (created with the AI token) or `"you"` (web or device). It is set at creation, cannot be
  changed by `PUT`, is included in export, and notes saved before it existed count as `"you"`.
- `editedBy` is `"ai"` or `"you"`: who last changed the note. It is set on create and on every `PUT`
  (including `append`) from the caller's token (AI token gives `"ai"`, web or device gives `"you"`), is
  ignored if sent in a request body, is included in list previews, `GET` one and export, and notes saved
  before it existed read as `"you"`.
- Decrypted notes are cached in server memory (built on first use, updated on every write, rebuilt after a
  passphrase change), so list, tag and search requests do not decrypt every file. `/api/export` still reads
  every file fresh. Private filtering is applied per request.

## Search

`q` (web, API and `search_notes`) is ranked with BM25 over title, tags and body (title counts most, then tags, then body). Rules:

- Words are runs of letters and digits in any script, case-insensitive. Punctuation separates words.
- Every positive term must match somewhere in the note (title, tags or body).
- A term of 3 or more characters also matches longer words that start with it (`mil` finds `milk`); exact matches count more.
  Shorter terms match whole words only. It is not substring search: `ilk` does not find `milk`.
- `"two words"` must appear together, in that order. A piece like `state-of-the-art` is read as a phrase.
- `-word` (or `-"two words"`) leaves out notes containing it. A query of only exclusions lists everything else, newest first.
- Equal scores: newest first. Queries over 200 characters are cut at 200, and only the first 12 terms are used.
  A query with no usable words (for example `!!!`) matches nothing.
- `snippets` are up to 3 plain-text passages of about 200 characters around the best matches (best first), trimmed on word boundaries,
  each `{ text, heading }` with the nearest preceding markdown heading (`null` if none). Markdown and HTML are removed. If the words
  only match the title or tags, the one snippet is the start of the note.
- The index lives in server memory next to the decrypted-note cache (`search.js`), is updated on create, update and delete,
  and is rebuilt after a passphrase change and at start. With the AI token private notes are filtered inside the index query:
  they cannot appear in results, snippets or counts, and cannot change the scores the AI sees.
  No regular expression is built from user input.

## Limits

Plain in-memory counters (reset on restart). Over a limit the server answers 429 with a `Retry-After` header.

| Limit | Default | Env override |
|---|---|---|
| Requests per minute, per identity (web session, device token or AI token) | 300 | `RATE_LIMIT_PER_MIN` |
| AI writes (POST/PUT) per minute | 30 | `RATE_LIMIT_AI_WRITES_PER_MIN` |
| Characters per note body (create, update, append) | 200,000 (413) | `NOTE_MAX_CHARS` |
| Notes in total | 5,000 (409) | `NOTE_MAX_COUNT` |
| Audit log size before rotation | 1,000,000 bytes | `AUDIT_MAX_BYTES` |
| Body characters per `full=1` page | 5,000,000 (rest via `next`) | `FULL_PAGE_MAX_CHARS` |
| Search query length / terms | 200 characters / 12 terms | fixed |
| Characters per `/text`, `/section` or MCP `get_note` response | 20,000 | fixed |
| Notes per MCP `search_notes` call | 50 (default 10) | fixed |

An append that would push a note past the character cap is refused (413) and nothing is added.
Login and device enrolment keep the passphrase lockout instead.

## Audit log

`data/audit.log` (mode 0600) gets one JSON line per security event: `ts`, `event`, `scope`, `ip`, plus an
`id` for note and device events. Events: `login_ok`, `login_fail`, `passphrase_fail`, `lockout`,
`device_create`, `device_revoke`, `ai_token_rotate`, `passphrase_change`, `export`, `note_delete`,
`ai_delete_denied`. It never holds note titles or text, tokens or passphrases. At 1 MB it rotates to
`audit.log.1` (one old file is kept). The log is plaintext: it is not encrypted, and it shows when and from which address
things happened.

## Devices (Android later)

`POST /api/devices` with `{ "passphrase": "...", "name": "Pixel" }` returns a device token once
(`Authorization: Bearer dev_...`). Only its SHA-256 hash is stored, inside an encrypted file. A device
token has the same note access as the web app (including private notes and export). Revoke it in
Settings or with `DELETE /api/devices/:id`. Enrolment, rotation and passphrase change all require the
passphrase and share the login lockout.

## Backup

Deleting a note is permanent: there is no trash. Your safety net is a backup, so copy `data/` regularly
(and before bulk clean-ups). Because the AI cannot delete, a confused or manipulated AI cannot remove notes.

Copy the whole `data/` folder while the server is stopped (or at least idle). Backups are ciphertext
(`data/notes/*.enc`, `meta.json`, `devices.enc`), so they are safe to put on cloud storage; they are
useless without the passphrase. `data/api-token` is **plaintext** (it is what the AI uses): leave it out
of backups you sync elsewhere, or rotate the token after restoring. For a readable backup use
Settings -> Export (store that file somewhere safe, it is not encrypted). Restoring = put the folder back
and start the server with the same passphrase.

If a passphrase change is interrupted (power cut), the next start finishes it automatically: use the
**new** passphrase if it was far enough along, otherwise the old one still works.

## Tests

```
node test/smoke.js
node test/search.test.js
node test/markdown.test.js
```

`search.test.js` covers tokenising, ranking, snippets, outline/section/text, private-note isolation, index consistency, the MCP tools and a
speed check (2,000 notes of about 3,000 characters). `smoke.js` starts throwaway servers on random ports with temp data folders (never `./data`), runs about 366 checks
(unlock, login, lockout, CRUD/search/tags, private notes vs AI, AI cannot delete, source, pagination and
skipped count, cache, size caps, rate limits, audit log, Host/Origin/CSP, ciphertext on disk, tampering,
devices, export, token rotation, passphrase change and crash recovery, MCP over stdio) and deletes
everything afterwards.

## What this does not protect against

- Malware or another user on the machine running the server while it is unlocked (key and plaintext are in memory).
- Anything you let the AI read: it is sent to the AI provider. Put sensitive notes in `private`.
  Do not ask the AI to store passwords.
- Plain HTTP on the wire if you skip Tailscale/WireGuard/`tailscale serve`.
- `data/api-token` is not encrypted; whoever reads that file can read all non-private notes while the server runs.
- Environment variable `KURA_PASSPHRASE`, shell history, and the exported JSON are plaintext by nature.
- Note titles/sizes/timestamps: filenames are random, but file count, sizes and modification times are visible.
- Forgotten passphrase: data is unrecoverable by design.
- A note's text can still contain instructions aimed at the AI (prompt injection). The AI cannot delete, hide or see private notes, and results carry an untrusted-data notice, but it can still add or edit non-private notes.
- Rate limits and the audit log are in memory / plain files: they slow down and record abuse, they do not stop a determined local attacker.
- Login lockout is global, so someone who can reach the server can lock you out for a while (they still cannot get in).

## License

MIT. See `LICENSE`.
