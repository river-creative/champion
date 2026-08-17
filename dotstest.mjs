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

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(48) + (x || ''));

const App = load('./index.html');
const app = new App();
app.props = { pin: 'Champs26', showBanner: true };
app.state = { data: null };

/* ------------------------------------------------- DOTS against references */
console.log('\n-- DOTS formula (men) --');
// Reference: 100 kg lifter lifting 100 kg scores 100 * 500 / f(100).
// f(100) = -307.75076 + 2409.00756 - 1918.759221 + 739.1293 - 109.3 = 812.427.
const KG = 2.20462262;
const d100 = app.dots(100 * KG, 100 * KG);
pass('100kg lifter, 100kg lift', Math.abs(d100 - 61.54) < 0.05, d100);

// A lighter lifter moving the same weight must score higher.
const light = app.dots(80 * KG, 140 * KG);
const heavy = app.dots(120 * KG, 140 * KG);
pass('lighter lifter scores higher on equal lift', light > heavy, `80kg=${light}  120kg=${heavy}`);

// Same lifter, more weight, higher score - and strictly proportional.
const lo = app.dots(200, 300), hi = app.dots(200, 600);
pass('score scales linearly with the lift', Math.abs(hi / lo - 2) < 0.0001, `${lo} -> ${hi}`);

pass('blank bodyweight returns nothing', app.dots('', '315') === null);
pass('non-numeric returns nothing', app.dots('abc', '315') === null);
pass('zero bodyweight returns nothing', app.dots('0', '315') === null);
pass('display falls back to a dash', app.dotsStr('', '315') === '—');

/* --------------------------------------------------- ranking is by points */
console.log('\n-- DOTS ranking --');
const comp = {
  dots: true,
  board: [
    { name: 'Heavy', bw: '260', score: '340' },   // big lift, big frame
    { name: 'Light', bw: '150', score: '260' }    // smaller lift, small frame
  ]
};
const ranked = app.sortBoard(comp);
pass('lighter lifter can outrank a bigger total',
     ranked[0].name === 'Light',
     `1st=${ranked[0].name} (${app.dotsStr(ranked[0].bw, ranked[0].score)}) 2nd=${ranked[1].name} (${app.dotsStr(ranked[1].bw, ranked[1].score)})`);
const partial = app.sortBoard({ dots: true, board: [{ name: 'NoBW', score: '300' }, { name: 'Full', bw: '200', score: '250' }] });
pass('rows without bodyweight sink to the bottom', partial[0].name === 'Full');

/* ------------------------------------------------------- three categories */
console.log('\n-- bench categories --');
const seed = app.seedData();
const benches = seed.competitions.filter((c) => c.dots);
pass('three DOTS bench categories exist', benches.length === 3, benches.map((c) => c.name).join(' | '));
pass('all carry bodyweight entry', benches.every((c) => c.hasBW && c.unit === 'LBS'));

/* ------------------------------------------------- event leaderboard view */
console.log('\n-- leaderboard display --');
app.state = { view: 'event', cId: benches[1].id, adminOn: false, data: seed,
              boardName: '', boardBw: '', boardScore: '', updateText: '' };
const ev = app.renderVals();
const r0 = ev.cBoard[0];
pass('BW and lift both shown', /BW \d+ · LIFT \d+ LBS/.test(r0.meta), r0.meta);
pass('DOTS points are the headline number', /^\d+\.\d\d pts$/.test(r0.score), r0.score);
pass('leader name is gold', r0.nameColor === '#e8b44a');
pass('leader score is gold', r0.scoreColor === '#e8b44a');
pass('leader rank is gold', r0.rankColor === '#e8b44a');
if (ev.cBoard[1]) pass('second place is not gold', ev.cBoard[1].nameColor !== '#e8b44a' && ev.cBoard[1].scoreColor !== '#e8b44a');

/* ------------------------------------------------------- Up Next glow */
console.log('\n-- index Up Next glow --');
app.state = { view: 'home', data: seed, adminOn: false, boardName: '', boardBw: '', boardScore: '', updateText: '' };
let home = app.renderVals();
const glow = home.upNext.filter((u) => u.vsAnim !== 'none');
pass('semi/final entries glow', glow.length > 0, glow.map((u) => u.comp + ' ' + u.round).join(' | '));
pass('both the bar and the vs animate', glow.every((u) => u.topAnim !== 'none' && u.vsAnim !== 'none'));
pass('early rounds do not glow',
     home.upNext.filter((u) => u.vsAnim === 'none').every((u) => u.topAnim === 'none'));

/* ------------------------------------------------ featured competition */
console.log('\n-- featured competition --');
const compCard = home.competitions.find((c) => c.name === benches[1].name);
pass('admin gets a feature toggle', typeof compCard.feature === 'function');
pass('unfeatured shows a hollow star', compCard.featLabel === '\u2606');

const saved = [];
app.save = (d) => { saved.push(d); app.state.data = d; };
compCard.feature();
pass('toggling records the featured id', saved[0].featuredComp === benches[1].id, saved[0].featuredComp);

const Board = load('./board.html', '?demo=1');
const b = new Board();
b.state = { data: saved[0], now: Date.now(), panelW: 600, offs: {}, focusIdx: -1, sweepCol: -1,
            newsMode: 'latest', newsY: 0, newsDur: 0 };
const bv = b.renderVals();
pass('board renders a featured panel', bv.hasFeat === true);
pass('featured panel is the chosen competition', bv.featName === benches[1].name, bv.featName);
pass('featured shows up to 10 rows', bv.featRows.length > 0 && bv.featRows.length <= 10, `${bv.featRows.length} rows`);
pass('featured leader is gold', bv.featRows[0].nameColor === '#e8b44a');
pass('featured DOTS points shown', /pts$/.test(bv.featRows[0].score), bv.featRows[0].score);
pass('featured comp removed from the grid below',
     !bv.lBoards.some((lb) => lb.name === bv.featName),
     `grid now: ${bv.lBoards.map((l) => l.name).join(', ')}`);

// nothing featured -> board looks exactly as before
const b2 = new Board();
b2.state = { ...b.state, data: seed };
const bv2 = b2.renderVals();
pass('no feature set means no panel', bv2.hasFeat === false);
pass('all competitions back in the grid', bv2.lBoards.length === seed.competitions.length, `${bv2.lBoards.length}`);
