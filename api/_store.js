/* Storage adapter for the CHAMPION shared state.
 *
 * Two backends, picked from whichever env vars are present:
 *
 *   1. Redis over REST (Upstash / Vercel KV) — preferred. No npm dependency,
 *      strongly consistent, and a read costs single-digit milliseconds.
 *   2. Vercel Blob — fallback, and the reason for the caveat in the README:
 *      blob objects are served through a CDN, so a board polling every three
 *      seconds can read a stale copy for up to a minute after a score changes.
 *      Fine for the push-subscription list in ru-here, not great for live
 *      scoring. Use Redis if you can.
 */

const KEY = 'champion:state';

/* Credentials are matched by SUFFIX, not exact name. Vercel's Marketplace
 * integrations prefix variables with the store name — a store called
 * "champion" yields CHAMPION_REDIS_URL, not REDIS_URL — and the prefix varies
 * per project, so an exact-name lookup silently falls through to memory. */

function findVar(suffix) {
  const re = new RegExp('(^|_)' + suffix + '$');
  for (const k of Object.keys(process.env).sort()) {
    if (re.test(k) && (process.env[k] || '').length > 0) return k;
  }
  return null;
}

// A REST URL and its token must come from the SAME prefix, or we'd pair
// one store's address with another store's password.
function findPair(urlSuffix, tokenSuffix) {
  const urlKey = findVar(urlSuffix);
  if (!urlKey) return null;
  const tokenKey = urlKey.slice(0, urlKey.length - urlSuffix.length) + tokenSuffix;
  if (!process.env[tokenKey]) return null;
  return { url: process.env[urlKey], token: process.env[tokenKey], via: urlKey };
}

const REST =
  findPair('KV_REST_API_URL', 'KV_REST_API_TOKEN') ||
  findPair('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN') ||
  findPair('REDIS_REST_URL', 'REDIS_REST_TOKEN');

const REDIS_URL = REST ? REST.url : '';
const REDIS_TOKEN = REST ? REST.token : '';

// Marketplace integrations often hand over a single TCP connection string
// instead of the REST pair.
const TCP_KEY = findVar('REDIS_URL') || findVar('KV_URL');
const REDIS_TCP = TCP_KEY ? process.env[TCP_KEY] : '';

const BLOB_KEY = findVar('BLOB_READ_WRITE_TOKEN');
const BLOB_TOKEN = BLOB_KEY ? process.env[BLOB_KEY] : '';

export function backend() {
  if (REDIS_URL && REDIS_TOKEN) return 'redis';
  if (REDIS_TCP) return 'redis-tcp';
  if (BLOB_TOKEN) return 'blob';
  return 'memory';
}

// Which env var actually got used, for the ?debug=1 view. Name only.
export function backendVar() {
  if (REDIS_URL && REDIS_TOKEN) return REST.via;
  if (REDIS_TCP) return TCP_KEY;
  if (BLOB_TOKEN) return BLOB_KEY;
  return null;
}

/* ------------------------------------------------------------------ redis */

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${REDIS_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(command),
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.result;
}

async function redisRead() {
  const raw = await redis(['GET', KEY]);
  return raw ? JSON.parse(raw) : null;
}

async function redisWrite(record) {
  await redis(['SET', KEY, JSON.stringify(record)]);
  return record;
}

/* --------------------------------------------------------------- redis tcp */

// Cached on module scope so warm invocations reuse the socket instead of
// opening a new one on every three-second poll.
let tcpClient = null;

async function tcp() {
  if (tcpClient && tcpClient.isOpen) return tcpClient;
  const { createClient } = await import('redis');
  tcpClient = createClient({ url: REDIS_TCP });
  tcpClient.on('error', () => {});   // don't let a stray event kill the function
  await tcpClient.connect();
  return tcpClient;
}

async function tcpRead() {
  const c = await tcp();
  const raw = await c.get(KEY);
  return raw ? JSON.parse(raw) : null;
}

async function tcpWrite(record) {
  const c = await tcp();
  await c.set(KEY, JSON.stringify(record));
  return record;
}

/* ------------------------------------------------------------------- blob */

const BLOB_PATH = 'champion-state.json';

async function blobRead() {
  const { list } = await import('@vercel/blob');
  const { blobs } = await list({ prefix: BLOB_PATH, token: BLOB_TOKEN });
  const hit = blobs.find((b) => b.pathname === BLOB_PATH);
  if (!hit) return null;
  const res = await fetch(`${hit.url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
}

async function blobWrite(record) {
  const { put } = await import('@vercel/blob');
  await put(BLOB_PATH, JSON.stringify(record), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    token: BLOB_TOKEN
  });
  return record;
}

/* ----------------------------------------------------------------- memory */
/* Survives only until the serverless instance is recycled. Local dev only. */

let mem = null;

/* ------------------------------------------------------------------- api  */

export async function readState() {
  switch (backend()) {
    case 'redis': return redisRead();
    case 'redis-tcp': return tcpRead();
    case 'blob': return blobRead();
    default: return mem;
  }
}

export async function writeState(record) {
  switch (backend()) {
    case 'redis': return redisWrite(record);
    case 'redis-tcp': return tcpWrite(record);
    case 'blob': return blobWrite(record);
    default: mem = record; return mem;
  }
}

/* ─────────────────────────── sign-up queue ───────────────────────────
 * A mass text means dozens of people submitting at once. Read-modify-write
 * on the whole state loses entries under that kind of burst: two requests
 * read the same snapshot and the second overwrites the first.
 *
 * Sign-ups therefore go onto a Redis list instead. RPUSH is atomic and
 * append-only, so concurrent writers cannot clobber each other however many
 * arrive in the same second. The list is merged into the state on read and
 * drained into it whenever an admin saves.
 */

const QKEY = 'champion:signups';
export const QUEUE_MAX = 500;

export function hasQueue() {
  const b = backend();
  return b === 'redis' || b === 'redis-tcp';
}

export async function queueSignup(entry) {
  const payload = JSON.stringify(entry);
  if (backend() === 'redis') { await redis(['RPUSH', QKEY, payload]); return true; }
  if (backend() === 'redis-tcp') { const c = await tcp(); await c.rPush(QKEY, payload); return true; }
  return false;
}

export async function queueLength() {
  if (backend() === 'redis') return (await redis(['LLEN', QKEY])) || 0;
  if (backend() === 'redis-tcp') { const c = await tcp(); return (await c.lLen(QKEY)) || 0; }
  return 0;
}

function parseAll(list) {
  return (list || []).map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}

export async function peekSignups() {
  if (backend() === 'redis') return parseAll(await redis(['LRANGE', QKEY, '0', '-1']));
  if (backend() === 'redis-tcp') { const c = await tcp(); return parseAll(await c.lRange(QKEY, 0, -1)); }
  return [];
}

// LPOP with a count removes and returns in one operation, so anything pushed
// mid-drain simply stays queued for next time.
export async function drainSignups(n = QUEUE_MAX) {
  if (backend() === 'redis') return parseAll(await redis(['LPOP', QKEY, String(n)]));
  if (backend() === 'redis-tcp') { const c = await tcp(); return parseAll(await c.lPopCount(QKEY, n)); }
  return [];
}

// If the state write fails after a drain, put the entries back rather than
// silently dropping people who signed up.
export async function restoreSignups(items) {
  if (!items || !items.length) return;
  const payload = items.map((x) => JSON.stringify(x));
  if (backend() === 'redis') { await redis(['LPUSH', QKEY, ...payload.slice().reverse()]); return; }
  if (backend() === 'redis-tcp') { const c = await tcp(); await c.lPush(QKEY, payload.slice().reverse()); }
}

/* Fold queued entries into a state object. Matching is by name per
 * competition, so an entry that has already been persisted is skipped and
 * replaying the queue can never duplicate anyone. */
export function mergeSignups(data, queued) {
  if (!data || !queued || !queued.length) return data;
  const byComp = new Map(), byTour = new Map();
  for (const q of queued) {
    if (q.tourId) {
      if (!byTour.has(q.tourId)) byTour.set(q.tourId, []);
      byTour.get(q.tourId).push(q);
    } else {
      if (!byComp.has(q.compId)) byComp.set(q.compId, []);
      byComp.get(q.compId).push(q);
    }
  }
  return {
    ...data,
    // A tournament sign-up cannot go straight into the bracket - the tree is
    // generated from the entrant list, and rebuilding it wipes every result.
    // Entries wait in `signups` until an admin folds them in deliberately.
    tournaments: (data.tournaments || []).map((t) => {
      const adds = byTour.get(t.id);
      if (!adds || !adds.length) return t;
      const pending = [...(t.signups || [])];
      // Numbers live in a name -> phone map on the tournament so they survive
      // the name being folded into the bracket later.
      const contacts = { ...(t.contacts || {}) };
      const seen = new Set([...(t.entrants || []), ...pending].map((n) => String(n).trim().toLowerCase()));
      for (const q of adds) {
        const key = String(q.name || '').trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(q.name);
        if (q.phone) contacts[q.name] = q.phone;
      }
      return { ...t, signups: pending, contacts };
    }),
    competitions: (data.competitions || []).map((c) => {
      const adds = byComp.get(c.id);
      if (!adds || !adds.length) return c;
      const board = [...(c.board || [])];
      const applicants = [...(c.applicants || [])];
      // A sign-up carrying attempt weights is an APPLICATION, not an entry.
      // It waits in `applicants` so an admin can rank the field on projected
      // DOTS and pick who actually lifts.
      const seen = new Set([...board, ...applicants].map((r) => String(r.name || '').trim().toLowerCase()));
      for (const q of adds) {
        const key = String(q.name || '').trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (q.attempts && q.attempts.length) {
          applicants.push({ name: q.name, phone: q.phone || '', bw: q.bw || '', attempts: q.attempts, signedUpAt: q.ts });
        } else {
          board.push({ name: q.name, phone: q.phone || '', bw: q.bw || '', score: '', signedUpAt: q.ts });
        }
      }
      return { ...c, board, applicants };
    })
  };
}
