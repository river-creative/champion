import { readState, writeState, hasQueue, queueSignup, queueLength, peekSignups, mergeSignups, QUEUE_MAX } from './_store.js';

/* Public sign-up. Deliberately the narrowest endpoint on the server: it can
 * only append a name and body weight to competitions an admin has explicitly
 * opened. It cannot score, edit, reorder or delete anything, so an open URL
 * is a nuisance at worst rather than a way to rewrite the board. */

const MAX_BODY = 8 * 1024;
const MAX_ENTRIES = 200;      // per competition
const BW_MIN = 80, BW_MAX = 500;
const LIFT_MIN = 45, LIFT_MAX = 1000;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(res, 405, { error: 'method not allowed' });
    }

    const raw = await readBody(req);
    if (raw.length > MAX_BODY) return send(res, 413, { error: 'too large' });

    let body;
    try { body = JSON.parse(raw); }
    catch { return send(res, 400, { error: 'bad request' }); }

    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 40) return send(res, 400, { error: 'Name must be 2-40 characters.' });
    if (/[<>{}]/.test(name)) return send(res, 400, { error: 'Name contains invalid characters.' });

    // Contact number. Kept out of every public response - see api/state.js.
    let phone = String(body.phone || '').trim();
    if (phone) {
      if (phone.length > 24 || !/^[0-9+()\-.\s]{7,24}$/.test(phone)) {
        return send(res, 400, { error: 'Enter a valid phone number, or leave it blank.' });
      }
    }

    const ids = Array.isArray(body.comps) ? body.comps.slice(0, 12).map(String) : [];
    const tourIds = Array.isArray(body.tours) ? body.tours.slice(0, 12).map(String) : [];
    if (!ids.length && !tourIds.length) return send(res, 400, { error: 'Pick at least one competition.' });

    const rec = await readState();
    if (!rec || !rec.data) return send(res, 409, { error: 'No competition data yet.' });

    const comps = rec.data.competitions || [];
    const tours = rec.data.tournaments || [];
    const tourTargets = [];
    for (const id of tourIds) {
      const t = tours.find((x) => x.id === id);
      if (!t) return send(res, 400, { error: 'Unknown tournament.' });
      if (!t.signupOpen) return send(res, 403, { error: `Sign-ups are closed for ${t.name}.` });
      if (!tourTargets.includes(t)) tourTargets.push(t);
    }
    const targets = [];
    for (const id of ids) {
      const c = comps.find((x) => x.id === id);
      if (!c) return send(res, 400, { error: 'Unknown competition.' });
      if (!c.signupOpen) return send(res, 403, { error: `Sign-ups are closed for ${c.name}.` });
      if (!targets.includes(c)) targets.push(c);
    }

    // One body weight, one age bracket: a lifter can only be in one of them.
    const bench = targets.filter((c) => c.dots);
    if (bench.length > 1) return send(res, 400, { error: 'Choose a single bench press category.' });

    let bw = '', attempts = [];
    if (bench.length) {
      const n = parseFloat(body.bw);
      if (!isFinite(n) || n < BW_MIN || n > BW_MAX) {
        return send(res, 400, { error: `Body weight must be ${BW_MIN}-${BW_MAX} lb.` });
      }
      bw = String(Math.round(n));

      // Three planned attempts. They are what the field is ranked on before
      // anyone lifts, so all three are required and have to be plausible.
      const raw = Array.isArray(body.attempts) ? body.attempts : [];
      if (raw.length !== 3) return send(res, 400, { error: 'Enter all three attempt weights.' });
      for (const a of raw) {
        const v = parseFloat(a);
        if (!isFinite(v) || v < LIFT_MIN || v > LIFT_MAX) {
          return send(res, 400, { error: `Attempts must be ${LIFT_MIN}-${LIFT_MAX} lb.` });
        }
        attempts.push(String(Math.round(v)));
      }
    }

    const lower = name.toLowerCase();
    const pending = hasQueue() ? await peekSignups() : [];
    const merged = mergeSignups(rec.data, pending);
    for (const t of tourTargets) {
      const mt = merged.tournaments.find((x) => x.id === t.id) || t;
      const roster = [...(mt.entrants || []), ...(mt.signups || [])];
      if (roster.length >= MAX_ENTRIES) return send(res, 409, { error: `${t.name} is full.` });
      if (roster.some((n) => String(n).trim().toLowerCase() === lower)) {
        return send(res, 409, { error: `${name} is already signed up for ${t.name}.` });
      }
    }
    for (const c of targets) {
      const mc = merged.competitions.find((x) => x.id === c.id) || c;
      const board = [...(mc.board || []), ...(mc.applicants || [])];
      if (board.length >= MAX_ENTRIES) return send(res, 409, { error: `${c.name} is full.` });
      if (board.some((r) => String(r.name || '').trim().toLowerCase() === lower)) {
        return send(res, 409, { error: `${name} is already signed up for ${c.name}.` });
      }
    }

    const ts = Date.now();

    if (hasQueue()) {
      // Atomic append per competition. Nothing is read-modified-written here,
      // so a hundred simultaneous sign-ups all survive.
      if ((await queueLength()) + targets.length + tourTargets.length > QUEUE_MAX) {
        return send(res, 503, { error: 'Sign-ups are busy right now — try again in a moment.' });
      }
      for (const c of targets) {
        await queueSignup({ compId: c.id, name, phone, bw: c.dots ? bw : '', attempts: c.dots ? attempts : [], ts });
      }
      for (const t of tourTargets) {
        await queueSignup({ tourId: t.id, name, phone, ts });
      }
      return send(res, 200, {
        ok: true,
        added: [...targets, ...tourTargets].map((x) => x.name),
        queued: true
      });
    }

    // No atomic list available (blob or in-memory): fall back to a whole-state
    // write. Correct, but only safe at low concurrency.
    const next = comps.map((c) => {
      if (!targets.includes(c)) return c;
      if (c.dots) return { ...c, applicants: [...(c.applicants || []), { name, phone, bw, attempts, signedUpAt: ts }] };
      return { ...c, board: [...(c.board || []), { name, phone, bw: '', score: '', signedUpAt: ts }] };
    });
    const nextTours = tours.map((t) =>
      tourTargets.includes(t) ? { ...t, signups: [...(t.signups || []), name], contacts: phone ? { ...(t.contacts || {}), [name]: phone } : (t.contacts || {}) } : t
    );
    await writeState({
      rev: (rec.rev || 0) + 1,
      data: { ...rec.data, competitions: next, tournaments: nextTours },
      updatedAt: new Date().toISOString()
    });
    return send(res, 200, { ok: true, added: [...targets, ...tourTargets].map((x) => x.name) });
  } catch (err) {
    return send(res, 500, { error: String((err && err.message) || err) });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let out = '';
    req.on('data', (c) => { out += c; if (out.length > MAX_BODY * 2) req.destroy(); });
    req.on('end', () => resolve(out));
    req.on('error', reject);
  });
}
