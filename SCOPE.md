# Kura — scope (web + Android)

Status: web server/viewer and the security rewrite are built and tested (325 smoke tests, `node test/smoke.js`). Hardening added: AI cannot delete, note provenance (`source`), pagination + decrypted-note cache, rate limits and size caps, audit log. Android not started. This doc is the gate before more building.

## Goal
Kura is a private, indexed notes app. User asks an AI (via MCP) to take notes; user reads/edits them in a web app and an Android app. Notes may contain sensitive info, so security outranks features.

## Threat model
| Threat | Covered by |
|---|---|
| Stolen disk / backup / synced `data/` folder | AES-256-GCM at rest, scrypt-derived key, random filenames, key only in memory |
| Other devices on LAN/tailnet | Auth on every API call, bind 127.0.0.1 by default |
| Malicious web page (CSRF, DNS rebinding) | SameSite=Strict cookie, Origin check, Host allowlist, no CORS |
| XSS in rendered notes | Escaped markdown renderer, strict CSP (no inline script/style) |
| Password guessing | Global lockout with backoff, scrypt cost |
| AI sees too much, or is manipulated by note text | `private` notes invisible to AI token; AI cannot flip `private`; AI cannot delete notes (403, no MCP tool); notes carry `source` and MCP results an untrusted-data notice |
| Lost/stolen phone | Biometric gate, revocable device token, FLAG_SECURE, auto-lock |
| **Not covered** | Malware on the server PC while unlocked; text you let the AI read (goes to the AI provider); plain HTTP on the wire (use Tailscale/WireGuard or `tailscale serve` HTTPS) |

## Shared backend (one server, two clients)
- Node, zero deps, `server.js`. Port 4546.
- Notes: `{id, title, body(markdown), tags[], private, created, updated}`, encrypted per file.
- Three credentials, three scopes:
  - **web session** — passphrase login, HttpOnly cookie, 8h. Sees everything.
  - **device token** — *new, needed for Android*. Issued after passphrase login, per device, stored hashed, listable and revocable in web Settings. Sees everything.
  - **AI token** — `data/api-token`, used by MCP. Hides private notes.
- API (existing): login/logout/session, notes CRUD + append, tags, search.
- API (to add for v1): `POST /api/devices` (issue), `GET /api/devices`, `DELETE /api/devices/:id`; change passphrase (re-encrypts all notes); note export (decrypted JSON, web session only).
- Server must be running **and unlocked** (passphrase typed at start). Trade-off: no unattended boot. Optional later: DPAPI/Credential-Manager-held key.

## Web app (v1)
In scope
- Login/lock screen; Lock button; auto-lock after idle.
- Two-pane: search + tag chips + list | note view/edit.
- Markdown view (headings, lists, code, quotes, links); plain textarea editor.
- Tags, private toggle (lock icon, "hidden from AI").
- Auto-refresh so AI-added notes appear.
- Light/dark, works on phone width.
- Settings: devices list/revoke, AI token rotate, change passphrase, export.

Out of scope v1: WYSIWYG, attachments/images, note links/backlinks, multi-user, sharing, version history, offline.

## Android app (v1)
Stack: match quest-log-android — Kotlin, Jetpack Compose, Material 3, Retrofit + OkHttp + kotlinx.serialization, single activity. New project `kura-android`, package `com.hoshy.notepad`.

In scope
- First run: enter server address(es) + passphrase once → server issues device token → stored in Android Keystore-backed EncryptedSharedPreferences. Passphrase never stored.
- Reuse quest-log `ServerDiscovery` idea: local + Tailscale addresses, race both, failover.
- Unlock with BiometricPrompt (device credential fallback) on every cold start and after N min in background.
- Screens: Notes list (search, tag filter chips, lock icon on private), Note view (markdown), Note editor (title, tags, private toggle, body), Settings (addresses, auto-lock time, sign out/forget device).
- Privacy hardening: `FLAG_SECURE` (no screenshots, blank in recents), no analytics/crash upload, `allowBackup=false`, no note text in notifications/logs, clipboard clear on copy of private note.
- Cleartext: Android blocks plain HTTP by default. Allow only for the configured private/Tailscale hosts via network security config, **or** put the server behind `tailscale serve` (HTTPS) and keep cleartext off. Recommended: HTTPS via tailscale serve.
- Online-only, like quest-log. Clear "can't reach server" state.

Out of scope v1: offline cache/edit, widgets, share-sheet "save to Kura" (good v2), push, tablets layout.

## Parity table
| Feature | Web | Android |
|---|---|---|
| Passphrase login | yes | first run only |
| Biometric unlock | n/a | yes |
| Search + tags | yes | yes |
| Markdown view | yes | yes |
| Edit / private toggle | yes | yes |
| Device / token / passphrase management | yes | no (web only) |
| Export | yes | no |
| Offline | no | no |

## Build order
1. Test + fix web server security rewrite (unlock, login, lockout, private filter, Host/Origin checks, MCP end to end).
2. Device tokens + settings endpoints; web settings screen.
3. Re-register MCP (token file flow), write README.
4. Android: skeleton, discovery, onboarding, list/view/edit, biometric + hardening.
5. Security pass (review the diff, try the attacks in the threat table).

## Decisions needed
1. **Server-side vs end-to-end encryption.** Chosen: server-side (server decrypts in memory). Needed so AI search/index works. E2E (client encrypts) would make AI integration impossible for those notes.
2. **HTTPS:** `tailscale serve` (recommended) vs cleartext allowlist on Android.
3. **Forgotten passphrase = data gone.** Accept, or add a printed recovery key?
4. **Android scope v1:** is online-only OK, or is offline read required?
5. **Share-sheet "save to Kura"** in v1 or v2?
