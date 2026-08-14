import { Readable } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';

const handler = (await import('./api/state.js')).default;

// ---- minimal req/res so we can call the real serverless handler in-process
function call(method, body, headers = {}) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [body] : []);
    req.method = method;
    req.headers = headers;
    let status = 200, out = '';
    const res = {
      statusCode: 200,
      setHeader() {},
      end(b) { status = res.statusCode; out = b; resolve({ status, json: JSON.parse(out) }); }
    };
    handler(req, res);
  });
}

// ---- browser-ish sandbox shared by both "pages"
function makeWindow(search = '') {
  const store = {};
  const w = {
    location: { search },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    async fetch(url, opts = {}) {
      const method = opts.method || 'GET';
      const r = await call(method, opts.body, opts.headers || {});
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.json
      };
    }
  };
  w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
  return { w, ctx, store };
}

function loadComponent(page, ctx) {
  const html = fs.readFileSync(page, 'utf8');
  let js = html.slice(html.indexOf('data-dc-script'));
  js = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</script>'));
  vm.runInContext('class DCLogic { setState(o){ this.state = {...this.state, ...o}; } }\n' + js + '\n;Component', ctx);
  return vm.runInContext('Component', ctx);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('backend:', (await call('GET')).json.backend);

// ============================== phone app, device A
const A = makeWindow();
const AppCls = loadComponent('./index.html', A.ctx);
const app = new AppCls();
app.componentDidMount();
await sleep(700);

let g = await call('GET');
console.log('after app mount -> server rev', g.json.rev, '| tournaments', g.json.data ? g.json.data.tournaments.length : 0);

// score something the way the UI does
const d = JSON.parse(JSON.stringify(app.state.data));
d.competitions[0].updates.unshift({ ts: Date.now(), text: 'TEST: Marcus takes the platform' });
app.save(d);
await sleep(600);

g = await call('GET');
console.log('after edit       -> server rev', g.json.rev, '| top update:', g.json.data.competitions[0].updates[0].text);

// ============================== big screen, device B (separate localStorage)
const B = makeWindow();
const BoardCls = loadComponent('./board.html', B.ctx);
const board = new BoardCls();
board.componentDidMount();
await sleep(80);

const seen = board.state.data.competitions[0].updates[0].text;
console.log('board on device B-> sees:', seen);
console.log('\nCROSS-DEVICE SYNC:', seen.startsWith('TEST:') ? 'PASS' : 'FAIL');

// ============================== shape guard
const junk = await call('PUT', JSON.stringify({ rev: 9, data: { x: 1 } }));
console.log('SHAPE GUARD:', junk.status === 400 ? 'PASS' : 'FAIL', '(malformed rejected)');

// ============================== pin gate
const valid = g.json.data;
process.env.CHAMP_PIN = 'Champs26';
const bad = await call('PUT', JSON.stringify({ rev: 9, data: valid }), { 'x-champ-pin': 'wrong' });
const good = await call('PUT', JSON.stringify({ rev: 9, data: valid }), { 'x-champ-pin': 'Champs26' });
console.log('PIN GATE:', bad.status === 401 && good.status === 200 ? 'PASS' : 'FAIL',
            '(wrong=' + bad.status + ', right=' + good.status + ')');

// ============================== static-host fallback
const C = makeWindow();
C.w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const App2 = loadComponent('./index.html', C.ctx);
const app2 = new App2();
app2.componentDidMount();
await sleep(50);
clearInterval(board._i); clearTimeout(board._ct); clearTimeout(board._nt); clearInterval(app._poll);
console.log('STATIC FALLBACK:', app2.state.data && app2.state.data.tournaments.length === 3 ? 'PASS' : 'FAIL',
            '(app still works with no /api)');

clearInterval(app2._poll);
