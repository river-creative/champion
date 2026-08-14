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

const REDIS_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL ||
  '';
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  '';

// Vercel's newer Marketplace integrations hand over a single TCP connection
// string instead of the REST pair, so support that too.
const REDIS_TCP =
  process.env.REDIS_URL ||
  process.env.KV_URL ||
  '';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

export function backend() {
  if (REDIS_URL && REDIS_TOKEN) return 'redis';
  if (REDIS_TCP) return 'redis-tcp';
  if (BLOB_TOKEN) return 'blob';
  return 'memory';
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
