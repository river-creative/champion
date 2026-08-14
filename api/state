import { readState, writeState, backend } from './_store.js';

const MAX_BYTES = 512 * 1024;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // The board polls every few seconds — never let a CDN or proxy hold a copy.
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      // /api/state?debug=1 reports which storage env vars the function can
      // actually see. Names only, never values.
      if (/[?&]debug=1/.test(req.url || '')) {
        const seen = Object.keys(process.env)
          .filter((k) => /REDIS|KV_|UPSTASH|BLOB|CHAMP_PIN/.test(k))
          .filter((k) => (process.env[k] || '').length > 0)
          .sort();
        return send(res, 200, {
          backend: backend(),
          envVarsFound: seen,
          hint: seen.length === 0
            ? 'No storage env vars visible. They are not scoped to this environment, or the deployment predates them — redeploy.'
            : 'If backend is still memory with vars listed, the deployed _store.js is an older copy.'
        });
      }
      const rec = await readState();
      return send(res, 200, {
        rev: rec ? rec.rev : 0,
        data: rec ? rec.data : null,
        backend: backend()
      });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      // Writes are gated on the same PIN the app already uses for Admin mode.
      // Leaving CHAMP_PIN unset leaves the endpoint open, which is convenient
      // for a first deploy and a bad idea once the URL is public.
      const required = process.env.CHAMP_PIN || '';
      if (required && req.headers['x-champ-pin'] !== required) {
        return send(res, 401, { error: 'bad pin' });
      }

      const body = await readBody(req);
      if (body.length > MAX_BYTES) return send(res, 413, { error: 'too large' });

      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return send(res, 400, { error: 'bad json' }); }

      // Shape check. Without it a malformed PUT propagates to every device
      // and the board throws on its next render, mid-event.
      const d = parsed && parsed.data;
      if (!d || typeof d !== 'object' ||
          !Array.isArray(d.tournaments) || !Array.isArray(d.competitions)) {
        return send(res, 400, { error: 'bad shape' });
      }

      const current = await readState();
      const rec = {
        rev: (current ? current.rev : 0) + 1,
        data: parsed.data,
        updatedAt: new Date().toISOString()
      };
      await writeState(rec);
      return send(res, 200, { rev: rec.rev, updatedAt: rec.updatedAt });
    }

    res.setHeader('allow', 'GET, PUT, POST');
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    return send(res, 500, { error: String((err && err.message) || err) });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let out = '';
    req.on('data', (c) => {
      out += c;
      if (out.length > MAX_BYTES * 2) req.destroy();
    });
    req.on('end', () => resolve(out));
    req.on('error', reject);
  });
}
