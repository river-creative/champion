import fs from 'node:fs';
import vm from 'node:vm';

function load(page, search = '') {
  const store = {};
  const w = {
    location: { search },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    document: { elementFromPoint: () => null },
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

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(50) + (x || ''));

/* ------------------------------------------------- leader card dimensions */
console.log('\n-- featured leader card --');
const bh = fs.readFileSync('./board.html', 'utf8');
const top = bh.slice(bh.indexOf('margin-top:12px;display:flex'), bh.indexOf('{{ featSecond }}'));
const second = bh.slice(bh.indexOf('{{ featSecond }}'), bh.indexOf('{{ featThird }}'));

const grab = (block, re) => (block.match(re) || [])[1];
pass('leader name type matches 2nd/3rd',
     grab(top, /font-size:(\d+)px;line-height:1\.1;color:\{\{ row\.nameColor/) ===
     grab(second, /font-size:(\d+)px;line-height:1\.1;color:\{\{ row\.nameColor/),
     'both ' + grab(top, /font-size:(\d+)px;line-height:1\.1;color:\{\{ row\.nameColor/) + 'px');
pass('leader score type matches', grab(top, /font-weight:900;font-size:(\d+)px;color:\{\{ row\.scoreColor/) ===
     grab(second, /font-weight:900;font-size:(\d+)px;color:\{\{ row\.scoreColor/),
     'both ' + grab(top, /font-weight:900;font-size:(\d+)px;color:\{\{ row\.scoreColor/) + 'px');
pass('leader padding matches', top.includes('padding:8px 12px') && second.includes('padding:8px 12px'));
pass('leader is half-width like the pairs', top.includes('width:calc(50% - 5px)'));
pass('leader stays centred', top.includes('justify-content:center'));
pass('gold treatment kept', top.includes('rgba(232,180,74,0.45)') && top.includes('box-shadow:0 0 18px rgba(232,180,74,0.18)'));
pass('no oversized type left behind', !top.includes('font-size:34px') && !top.includes('font-size:30px'));

/* --------------------------------------------------- final announcements */
const Board = load('./board.html', '?demo=1');
const b = new Board();
b.state = { data: null, now: Date.now(), panelW: 600, offs: {}, focusIdx: -1, sweepCol: -1,
            newsMode: 'latest', newsY: 0, newsDur: 0 };
const data = b.seedData();

// Call of Duty: 3 rounds, one semifinal already won. Settle the other.
const cod = data.tournaments.find((t) => t.name === 'Call of Duty');
const L = cod.rounds.length;
console.log('\n-- semifinal / final updates --');
console.log('   ' + cod.name + ': ' + L + ' rounds, semis =', cod.rounds[L - 2].map((m) => `${m.a} v ${m.b}${m.winner ? ' -> ' + m.winner : ''}`).join(' | '));

b.state.data = data;
let feed = b.renderVals().feed;
let semiWin = feed.find((f) => /Squad Alpha def\. Squad Delta/.test(f.title));
pass('semifinal win notes the winner is headed to the final',
     !!semiWin && / — advances to the Final$/.test(semiWin.title), semiWin && semiWin.title);
pass('no matchup line while the other semi is open',
     !feed.some((f) => /will face/.test(f.title)));

// settle the second semifinal
const open2 = cod.rounds[L - 2].find((m) => !m.winner);
open2.winner = open2.a; open2.ts = Date.now();
cod.rounds[L - 1][0].b = open2.a;

const b2 = new Board();
b2.state = { ...b.state, data };
feed = b2.renderVals().feed;
const matchup = feed.find((f) => /will face/.test(f.title));
pass('matchup announced once both sides are known', !!matchup, matchup && matchup.title);
pass('it reads as a separate entry, not appended', matchup && !/def\./.test(matchup.title));
pass('matchup is gold', matchup && matchup.gold === true && matchup.titleColor === '#e8b44a');
pass('it sorts above the semifinal that produced it',
     feed.indexOf(matchup) < feed.findIndex((f) => / — advances to the Final$/.test(f.title)));
pass('only one matchup line per tournament',
     feed.filter((f) => /will face/.test(f.title) && f.comp === 'Call of Duty').length === 1);

// once the final is played the announcement must disappear
cod.rounds[L - 1][0].winner = cod.rounds[L - 1][0].a;
cod.rounds[L - 1][0].ts = Date.now() + 1000;
const b3 = new Board();
b3.state = { ...b.state, data };
pass('announcement clears once the final is decided',
     !b3.renderVals().feed.some((f) => /will face/.test(f.title) && f.comp === 'Call of Duty'));

/* ------------------------------------------------------------ index side */
console.log('\n-- app side --');
const App = load('./index.html');
const app = new App();
app.props = { pin: 'Champs26', showBanner: true };
const d2 = app.seedData();
const cod2 = d2.tournaments.find((t) => t.name === 'Call of Duty');
const L2 = cod2.rounds.length;
const o2 = cod2.rounds[L2 - 2].find((m) => !m.winner);
o2.winner = o2.a; o2.ts = Date.now();
cod2.rounds[L2 - 1][0].b = o2.a;
app.state = { view: 'home', adminOn: false, data: d2, boardName: '', boardBw: '', boardScore: '',
              updateText: '', cDragId: null, cOverId: null };
const hf = app.renderVals().feed;
const im = hf.find((f) => /will face/.test(f.title));
pass('app shows the matchup too', !!im, im && im.title);
pass('app labels it Final set', im && im.sub === 'Final set');
pass('app semifinal win notes the advance',
     hf.some((f) => / · advances to the Final$/.test(f.sub)),
     (hf.find((f) => / · advances to the Final$/.test(f.sub)) || {}).sub);

/* -------------------------------------------- brackets that cannot have semis */
const tiny = { name: 'Tiny', rounds: [[{ a: 'X', b: 'Y', winner: 'X', ts: Date.now() }]] };
const b4 = new Board();
b4.state = { ...b.state, data: { tournaments: [tiny], competitions: [] } };
let crashed = false;
try { b4.renderVals(); } catch (e) { crashed = true; }
pass('a one-round bracket does not crash', !crashed);
