import fs from 'node:fs';
import vm from 'node:vm';

function load(page, search = '') {
  const store = {};
  const w = {
    location: { search },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
  };
  w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
  const html = fs.readFileSync(page, 'utf8');
  let js = html.slice(html.indexOf('data-dc-script'));
  js = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</script>'));
  vm.runInContext('class DCLogic { setState(o){ this.state = {...this.state, ...o}; } }\n' + js + '\n;Component', ctx);
  return vm.runInContext('Component', ctx);
}

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(46) + (x || ''));

/* ---------------------------------------------- 1. score decides the winner */
const App = load('./index.html');
const app = new App();
app.state = { data: null };

const cf = (sa, sb, clicked, scored = true) =>
  ({ kind: 'advance', scored, aName: 'Jake Rollins', bName: 'Marcus Reed', sa, sb, winner: clicked,
     loserName: clicked === 'Jake Rollins' ? 'Marcus Reed' : 'Jake Rollins' });

console.log('\n-- winner resolution --');
pass('tapped wrong name, score overrides',
     app.scoreWinner(cf('21', '7', 'Marcus Reed')) === 'Jake Rollins',
     app.scoreWinner(cf('21', '7', 'Marcus Reed')));
pass('tapped right name, score agrees',
     app.scoreWinner(cf('21', '7', 'Jake Rollins')) === 'Jake Rollins');
pass('B side higher wins',
     app.scoreWinner(cf('7', '21', 'Jake Rollins')) === 'Marcus Reed');
pass('tie keeps the tapped name',
     app.scoreWinner(cf('14', '14', 'Marcus Reed')) === 'Marcus Reed');
pass('blank scores keep the tapped name',
     app.scoreWinner(cf('', '', 'Marcus Reed')) === 'Marcus Reed');
pass('unscored tournament keeps the tapped name',
     app.scoreWinner(cf('21', '7', 'Marcus Reed', false)) === 'Marcus Reed');
pass('non-numeric (times) keeps the tapped name',
     app.scoreWinner(cf('1:42', '1:58', 'Marcus Reed')) === 'Marcus Reed');

/* ------------------------------------------------ 2. higher score displayed */
console.log('\n-- results line --');
const sl = (sa, sb, winner) => app.scoreline({ a: 'Jake Rollins', b: 'Marcus Reed', sa, sb, winner });
pass('higher score leads when A won', sl('21', '7', 'Jake Rollins') === '21–7', sl('21', '7', 'Jake Rollins'));
pass('higher score leads when B won', sl('7', '21', 'Marcus Reed') === '21–7', sl('7', '21', 'Marcus Reed'));
pass('higher score leads even on a bad record',
     sl('7', '21', 'Jake Rollins') === '21–7', sl('7', '21', 'Jake Rollins'));

/* --------------------------------------------------- 3/4. board feed + gold */
const Board = load('./board.html', '?demo=1');
const b = new Board();
b.state = { data: null, now: Date.now(), panelW: 600, offs: {}, focusIdx: -1, sweepCol: -1,
            newsMode: 'latest', newsY: 0, newsDur: 0 };
b.state.data = b.loadData();
const v = b.renderVals();

console.log('\n-- board feed --');
const withScore = v.feed.filter((f) => / · \d+–\d+$/.test(f.title));
pass('results carry the round label', withScore.length > 0 && / · (Final|Semifinals|Quarterfinals|Round of \d+) · /.test(withScore[0].title),
     withScore[0] ? withScore[0].title : 'none');
const bad = withScore.filter((f) => {
  const m = f.title.match(/(\d+)–(\d+)$/);
  return m && parseInt(m[1]) < parseInt(m[2]);
});
pass('never shows the lower score first', bad.length === 0, bad.length ? bad[0].title : '');

console.log('\n-- leaderboards --');
pass('first place is gold on the board', v.lBoards[0].rows[0].rankColor === '#e8b44a', v.lBoards[0].rows[0].rankColor);
pass('other ranks unchanged', v.lBoards[0].rows[1].rankColor === '#8b93a1');

/* ----------------------------------------------------- 5. blink treatments */
console.log('\n-- semi/final emphasis --');
const hot = [];
v.bPanels[0].cols.forEach((c) => { if (c.isRound) c.matches.forEach((m) => { if (m.cardAnim !== 'none') hot.push(c.label); }); });
pass('whole card outline blinks (not one row)', hot.length > 0 && hot.every((l) => l === 'Final' || l === 'Semifinals'),
     hot.join(', ') || 'none');
pass('divider binding is gone', !JSON.stringify(v.bPanels[0].cols).includes('divAnim'));

b.state.newsMode = 'upnext';
const v2 = b.renderVals();
const big = v2.upNext.filter((u) => u.vsAnim !== 'none');
pass('Up Next vs blinks', big.length > 0, big.map((u) => u.round).join(', '));
pass('Up Next rule above the match blinks', big.every((u) => u.topAnim !== 'none' && u.topW === 2));
pass('ordinary matches get no rule', v2.upNext.filter((u) => u.vsAnim === 'none').every((u) => u.topW === 0));

/* -------------------------------------------------------------- 6. sweep */
console.log('\n-- rotation on a bracket that fits --');
b.state.panelW = 4000;                       // everything fits, nothing to pan
const geoms = b.state.data.tournaments.map((t) => b.geom(t));
console.log('   brackets with no overflow:', geoms.filter((g) => g.maxOff <= 4).length + '/' + geoms.length);
const cols = new Set(), panels = new Set();
const real = b.setState.bind(b);
b.setState = (o) => {
  if (typeof o.sweepCol === 'number' && o.sweepCol >= 0) cols.add(o.sweepCol);
  if (typeof o.focusIdx === 'number' && o.focusIdx >= 0) panels.add(o.focusIdx);
  real(o);
};
b.cycle();
await new Promise((r) => setTimeout(r, 1400 * 6 + 2600 * 3 + 500));
pass('sweeps through round columns', cols.size >= 3, `columns lit: ${[...cols].sort().join(',')}`);
pass('still visits every bracket', panels.size === geoms.length, `${panels.size}/${geoms.length}`);
clearTimeout(b._ct); clearTimeout(b._nt);
