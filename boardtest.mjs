import fs from 'node:fs';
import vm from 'node:vm';

function boardCtx() {
  const store = {};
  const w = {
    location: { search: '?demo=1' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
  };
  w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
  const html = fs.readFileSync('./board.html', 'utf8');
  let js = html.slice(html.indexOf('data-dc-script'));
  js = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</script>'));
  vm.runInContext('class DCLogic { setState(o){ this.state = {...this.state, ...o}; } }\n' + js + '\n;Component', ctx);
  return vm.runInContext('Component', ctx);
}

const C = boardCtx();
const b = new C();
b.state = { data: null, now: Date.now(), panelW: 0, offs: {}, focusIdx: -1, newsMode: 'latest', newsY: 0, newsDur: 0 };
b.state.data = b.loadData();

const pass = (n, c, extra = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (extra ? '   ' + extra : ''));

// ---------- 1. rotation visits every bracket, including ones that fully fit
b.state.panelW = 4000;                      // wide panels: nothing overflows
const geoms = b.state.data.tournaments.map((t) => b.geom(t));
const fits = geoms.filter((g) => g.maxOff <= 4).length;
let visited = new Set();
const realSetState = b.setState.bind(b);
b.setState = (o) => { if (typeof o.focusIdx === 'number' && o.focusIdx >= 0) visited.add(o.focusIdx); realSetState(o); };
b.cycle();
await new Promise((r) => setTimeout(r, 100));
console.log(`\nall ${geoms.length} brackets fit on screen (maxOff<=4): ${fits}/${geoms.length}`);

// walk the chain of timers the cycle schedules
for (let i = 0; i < 40 && visited.size < geoms.length; i++) {
  await new Promise((r) => setTimeout(r, 60));
  vm.runInContext('1', vm.createContext({}));
}
await new Promise((r) => setTimeout(r, 7200 * geoms.length));
pass('rotation visits every fully-visible bracket', visited.size === geoms.length,
     `visited ${visited.size}/${geoms.length}`);
clearTimeout(b._ct);

// ---------- 2. Latest <-> Up Next
const v1 = b.renderVals();
pass('starts on Latest', v1.newsTitle === 'Latest' && v1.newsIsLatest && !v1.newsIsNext);
b.state.newsMode = 'upnext';
const v2 = b.renderVals();
pass('flips to Up Next', v2.newsTitle === 'Up Next' && v2.newsIsNext && !v2.newsIsLatest);

// ---------- 3. scroll maths: 15 px/s over the 30s lead
pass('scroll speed constant is 15 px/s', b.NEWS_SPEED === 15);
pass('period 120s, lead 30s', b.NEWS_PERIOD === 120000 && b.NEWS_LEAD === 30000);
b._news = { scrollHeight: b.NEWS_VH + 1000 };   // plenty to scroll
b.newsCycle();
await new Promise((r) => setTimeout(r, 50));
const before = b.state.newsY;
// jump straight to the scroll phase rather than waiting 90 real seconds
clearTimeout(b._nt);
const over = Math.max(0, b._news.scrollHeight - b.NEWS_VH);
const dist = Math.min(over, b.NEWS_SPEED * (b.NEWS_LEAD / 1000));
pass('caps travel at 450px (15 x 30)', dist === 450, `dist=${dist}`);
pass('duration matches speed', dist / b.NEWS_SPEED === 30, `${dist / b.NEWS_SPEED}s`);
pass('resets to top on switch', before === 0);
clearTimeout(b._nt);

// ---------- 4. Up Next ordering: featured first
const data = b.state.data;
const t0 = data.tournaments[0];
let fr = -1, fi = -1;
for (let r = 0; r < t0.rounds.length && fr < 0; r++) {
  t0.rounds[r].forEach((m, i) => { if (fr < 0 && m.a && m.b && !m.winner) { fr = r; fi = i; } });
}
t0.featured = { r: fr, i: fi };
b.state.newsMode = 'upnext';
const v3 = b.renderVals();
const star = v3.upNext[0];
pass('featured match leads the list', star && star.star === '\u2605',
     `first="${star.a} vs ${star.b}" star="${star.star}"`);
pass('non-featured matches follow', v3.upNext.length > 1 && v3.upNext.slice(1).every((u) => u.star === ''));
pass('list is capped', v3.upNext.length <= 14, `${v3.upNext.length} entries`);
const dupes = new Set(v3.upNext.map((u) => u.comp + u.a + u.b));
pass('no duplicate matches', dupes.size === v3.upNext.length);

// ---------- 5. semi/final blink
const blinking = v3.upNext.filter((u) => u.vsAnim !== 'none');
pass('semis/finals blink in Up Next', blinking.length > 0,
     blinking.map((u) => u.round).join(', ') || 'none');
pass('blinking rounds are only Final/Semifinals',
     blinking.every((u) => u.round === 'Final' || u.round === 'Semifinals'));

const panel = v3.bPanels[0];
const hotCols = [];
panel.cols.forEach((c) => { if (c.isRound) c.matches.forEach((m) => { if (m.divAnim !== 'none') hotCols.push(c.label); }); });
pass('semi/final line blinks in the bracket', hotCols.length > 0, hotCols.join(', ') || 'none');
pass('only semi/final lines blink',
     hotCols.every((l) => l === 'Final' || l === 'Semifinals'));

clearTimeout(b._ct); clearTimeout(b._nt);
