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
