import fs from 'node:fs';
import vm from 'node:vm';

function load(page) {
  const store = {};
  const listeners = {};
  let polls = 0;
  const doc = {
    hidden: false,
    elementFromPoint: () => null,
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: (ev, fn) => {
      const l = listeners[ev] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    }
  };
  const w = {
    location: { search: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    document: doc,
    // Answer like a healthy server, or sync.js decides there is no API
    // and stops polling for reasons unrelated to visibility.
    fetch: async (url) => { polls++; return { ok: true, status: 200, json: async () => ({ unchanged: true, rev: 1 }) }; }
  };
  w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
  const html = fs.readFileSync(page, 'utf8');
  let js = html.slice(html.indexOf('data-dc-script'));
  js = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</script>'));
  vm.runInContext('class DCLogic { setState(o){ this.state = {...this.state, ...o}; } }\n' + js + '\n;Component', ctx);
  const C = vm.runInContext('Component', ctx);
  return {
    C, doc, listeners,
    polls: () => polls,
    reset: () => { polls = 0; },
    fire: (ev) => (listeners[ev] || []).forEach((f) => f())
  };
}

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(54) + (x || ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────── the app ─────────────────────────────── */
console.log('\n-- app (30s poll) --');
{
  const env = load('./index.html');
  const app = new env.C();
  app.props = { pin: 'Champs26', showBanner: true };
  app.POLL_MS = 40;                      // compress the clock for the test
  app.componentDidMount();
  // The first mount seeds and pushes; polling is skipped while a write is
  // pending, so let that settle before measuring.
  await wait(700);
  env.reset();

  await wait(130);
  const visible = env.polls();
  pass('polls while on screen', visible >= 2, `${visible} polls in ~3 intervals`);

  env.doc.hidden = true;
  env.fire('visibilitychange');
  env.reset();
  await wait(200);
  pass('stops completely when backgrounded', env.polls() === 0, `${env.polls()} polls in ~5 intervals`);

  env.doc.hidden = false;
  env.reset();
  env.fire('visibilitychange');
  await wait(10);
  pass('catches up immediately on return', env.polls() >= 1, `${env.polls()} immediate pull`);

  env.reset();
  await wait(130);
  pass('resumes its normal rhythm', env.polls() >= 2, `${env.polls()} polls`);

  pass('listener registered once', (env.listeners['visibilitychange'] || []).length === 1);
  app.componentWillUnmount();
  pass('listener removed on unmount', (env.listeners['visibilitychange'] || []).length === 0);
  env.reset();
  await wait(120);
  pass('nothing polls after unmount', env.polls() === 0);
}

/* ────────────────────────────── the board ────────────────────────────── */
console.log('\n-- board (3s poll) --');
{
  const env = load('./board.html');
  const b = new env.C();
  b.componentDidMount();
  await wait(700);
  env.reset();

  env.doc.hidden = true;
  env.fire('visibilitychange');
  env.reset();
  await wait(150);
  pass('board stops when its tab is hidden', env.polls() === 0, `${env.polls()} polls`);

  env.doc.hidden = false;
  env.reset();
  env.fire('visibilitychange');
  await wait(10);
  pass('board refreshes the moment it is shown', env.polls() >= 1);
  b.componentWillUnmount();
}

/* ──────────────────────── what it saves in practice ──────────────────── */
console.log('\n-- effect on the command budget --');
const perHr = (3600 / 30) * 2;
for (const [label, mins] of [['looks for 30s then locks the phone', 0.5], ['browses for 5 minutes', 5], ['leaves the tab open all day (12h)', 720]]) {
  const before = perHr * 12;                       // tab open 12h, polling throughout
  const after = perHr * (mins / 60);               // only while actually on screen
  console.log(`   300 attendees, each ${label}`);
  console.log(`     before: ${(before * 300).toLocaleString()}   after: ${(after * 300).toLocaleString()}`);
}
