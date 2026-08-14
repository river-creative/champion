# CHAMPION

Conference scoring app (`index.html`) plus a big-screen board (`board.html`).

Two ways to run it:

| Host | Shared scoring | Setup |
| --- | --- | --- |
| GitHub Pages | No — one device only | Push the files, done |
| Vercel | Yes — phone scores, board updates | Import repo, add a Redis store |

The same files work on both. Without `/api/state`, the app falls back to
`localStorage` automatically and behaves exactly as it did before.

## Deploying to Vercel

1. vercel.com → **Add New → Project** → import `river-creative/champion`.
2. Framework preset: **Other**. No build command, no output directory.
3. Storage tab → **Upstash Redis** → create and connect it to this project.
   That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
4. Settings → Environment Variables → add `CHAMP_PIN` = `Champs26`
   (or whatever PIN you want gating writes). Redeploy after adding it.
5. Open `/api/state`. `backend` tells you which path is live:
   - `redis` — REST credentials, the fastest option
   - `redis-tcp` — a `REDIS_URL` connection string, also fine
   - `memory` — nothing attached; step 3 didn't take

### Why Redis and not Blob

Vercel Blob serves objects through a CDN, so a board polling every three seconds
can read a stale copy for up to a minute after a score changes. That's fine for
the push-subscription list in `ru-here`; it's not fine for live scoring.
`api/_store.js` supports Blob as a fallback if `BLOB_READ_WRITE_TOKEN` is the
only thing set, but Redis is the one to use here.

## Board behaviour

- **Bracket rotation** — every 2 minutes the board walks each tournament in
  turn. Brackets wider than the panel pan left to right; ones that already fit
  get a red outline for the same beat, so the rotation never skips a board.
- **Latest / Up Next** — the third card alternates every 2 minutes. It holds
  still for 90s, then creeps down at 15 px/s through the final 30s (capped at
  450px of travel) before switching.
- **Up Next** lists featured matches first, then every other ready-to-play
  match, finals first, up to 14.
- **Semifinals and the Final** get a slowly blinking red line between the two
  competitors in the bracket, and a blinking red "vs" in Up Next. Same
  treatment on the phone app.

## Running the event

- Scoring device: open the site, tap **Admin**, enter the PIN.
- Big screen: open `/board.html`. It picks up changes within ~3 seconds.
- `?demo=1` on either page loads seeded sample data without touching the server.

Writes are last-writer-wins. If two people score the same match in the same
second, the later tap wins. That's deliberate — rejecting the stale write would
make someone's tap silently revert on stage.

### Repo layout

Everything is flat at the root except the two serverless functions, which must
live in `api/`. Nothing else belongs there, and neither of those two files
belongs at the root — a copy at the root is served as downloadable plain text
instead of running as a function.

```
champion/
  api/
    state.js
    _store.js
  index.html
  board.html
  ...
```

## Files

- `index.html` — the app
- `board.html` — big screen
- `guide.html` — printable launch guide
- `sync.js` — shared-state client (server when available, cache when not)
- `api/state.js` — GET returns `{rev, data}`, PUT accepts `{rev, data}`
- `api/_store.js` — Redis (REST or TCP) / Blob / in-memory adapter
- `support.js`, `ds-*`, `react*`, `fonts.css`, `archivo-*.woff2` — runtime and assets

Two test scripts run against the real code, no browser needed:

```
node selftest.mjs    # sync: cross-device, pin gate, shape guard, offline fallback
node boardtest.mjs   # board: rotation coverage, news timing, Up Next order, blink
node tcptest.mjs     # storage: REDIS_URL path against a local RESP server
```
