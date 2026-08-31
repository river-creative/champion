import { Readable } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';

const state = (await import('./api/state.js')).default;

let bytesOut = 0;
function call(method, body, url = '/') {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [body] : []);
    req.method = method; req.headers = {}; req.url = url;
    const res = {
      statusCode: 200, setHeader() {},
      end(b) { bytesOut += Buffer.byteLength(b); resolve({ status: res.statusCode, json: JSON.parse(b), size: Buffer.byteLength(b) }); }
    };
    state(req, res);
  });
}
const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(52) + (x || ''));

// a full 300-person event
const big = JSON.parse(fs.readFileSync('/home/claude/big_state.json', 'utf8'));
await call('PUT', JSON.stringify({ rev: 0, data: big.data }));

const full = await call('GET');
console.log(`\nfull state response: ${(full.size / 1024).toFixed(1)} KB  (rev ${full.rev || full.json.rev})`);

const unchanged = await call('GET', null, `/api/state?since=${full.json.rev}`);
console.log(`unchanged response:  ${unchanged.size} bytes`);
pass('server answers "unchanged"', unchanged.json.unchanged === true);
pass('unchanged reply is tiny', unchanged.size < 100, `${unchanged.size} bytes`);
pass('saving per poll', unchanged.size < full.size / 500,
     `${(full.size / unchanged.size).toFixed(0)}x smaller`);

// a genuinely stale revision must still get the full payload
const held = full.json.rev;
await call('PUT', JSON.stringify({ rev: held, data: big.data }));   // server moves on
const stale = await call('GET', null, `/api/state?since=${held}`);
pass('a stale revision still gets the data', !!stale.json.data && !stale.json.unchanged,
     `${(stale.size / 1024).toFixed(1)} KB`);

// a client with no data must never be fobbed off
const fresh = await call('GET');
pass('a client with no revision gets the data', !!fresh.json.data);

/* ---------------- client side ---------------- */
const store = {};
const calls = [];
const w = {
  location: { search: '' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener() {}, removeEventListener() {},
  async fetch(url) {
    calls.push(url);
    const r = await call('GET', null, url);
    return { ok: true, status: 200, json: async () => r.json };
  }
};
w.window = w;
const ctx = vm.createContext(w);
vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
const CS = vm.runInContext('window.ChampSync', ctx);

console.log('\n-- client behaviour --');
let got = await CS.pull();
pass('first pull fetches everything', !!(got && got.data));
pass('first pull sends no revision', !/since=/.test(calls[0]), calls[0].replace(/t=\d+/, 't=…'));

got = await CS.pull();
pass('second pull sends its revision', /since=/.test(calls[1]), calls[1].replace(/t=\d+/, 't=…'));
pass('second pull reports no change', got === null);

/* ---------------- what this saves over the event ---------------- */
const pollsPerHour = 3600 / 3 + (3600 / 5) * 3;      // board + three phones
const hours = 48;
const changesPerEvent = 400;                          // scores, sign-ups, edits
const polls = pollsPerHour * hours;
const before = polls * full.size;
const after = changesPerEvent * full.size + (polls - changesPerEvent) * unchanged.size;
console.log('\n-- four-day event, board + 3 phones --');
console.log(`   polls:            ${polls.toLocaleString()}`);
console.log(`   before:           ${(before / 1024 / 1024 / 1024).toFixed(1)} GB`);
console.log(`   after:            ${(after / 1024 / 1024).toFixed(0)} MB`);
console.log(`   reduction:        ${(before / after).toFixed(0)}x`);
