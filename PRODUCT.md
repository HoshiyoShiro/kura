# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
One person, the owner, who self-hosts the server. They use it from a desktop browser and from a phone, over Tailscale. They keep a mix of quick notes an AI wrote for them and personal or sensitive notes they wrote themselves. No sharing, no teams.

## Product Purpose
Kura is a private, indexed notes app. The owner asks an AI (through MCP) to take notes, and reads, searches, edits and curates them in a web app. Success: finding a note in seconds, and never wondering what the AI can see.

## Positioning
Self-hosted, encrypted at rest, with a per-note Private switch that makes a note invisible to the AI. Notes, search, tags and the AI's access are controlled from one screen.

## Operating Context
Server is a zero-dependency Node process the owner unlocks with a passphrase at start. Notes are markdown with tags. The AI adds and appends notes with its own token. Android app is a separate native project, planned after the web version.

## Capabilities and Constraints
- Notes: title, markdown body, tags, private flag, created and updated times; search by text and tag; tag index with counts.
- Screens: lock/login, list plus note view, editor, settings (devices, AI token, passphrase, export).
- AI-written notes should be distinguishable from owner-written ones (needs a `source` field on notes; not yet built).
- Locked state shows no titles, counts or tag names.
- Constraints: zero npm dependencies, plain static HTML/CSS/JS in `public/` with no build step, strict CSP (no inline script or style).
- Undecided: default privacy of new notes; auto-lock timings; manual theme toggle.

## Evidence on Hand
Design draft (layout, mock content, visibility model): https://claude.ai/code/artifact/e6093545-a396-4c32-894a-967f26e433bc. Scope: `SCOPE.md`. No real notes or users yet; do not fabricate any.

## Product Principles
1. The AI's reach is always visible. Private notes say so in words and an icon, not color alone.
2. Locked means empty. Nothing leaks before unlock.
3. Finding beats browsing: search and tags come first.
4. Small and boring to run: no dependencies, no build.

## Accessibility & Inclusion
Keyboard operable, visible focus, text contrast at WCAG AA in light and dark, usable at phone width.
