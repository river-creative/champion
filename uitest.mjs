import fs from 'node:fs';
import vm from 'node:vm';

function load(page, search = '') {
  const store = {};
  const els = [];
  const w = {
    location: { search },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    document: { elementFromPoint: () => els.pop() || null },
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
const GOLD = '#e8b44a';

const App = load('./index.html');
const app = new App();
app.props = { pin: 'Champs26', showBanner: true };
app.state = { view: 'home', adminOn: true, data: null, boardName: '', boardBw: '', boardScore: '',
              updateText: '', cDragId: null, cOverId: null };
const seed = app.seedData();
app.state.data = seed;
const saved = [];
app.save = (d) => { saved.push(d); app.state.data = d; };

/* -------------------------------------------------------- reorder */
console.log('\n-- drag to reorder --');
const before = seed.competitions.map((c) => c.name);
console.log('   order before:', before.join(' | '));
app.moveComp(seed.competitions[4].id, seed.competitions[0].id);   // last -> first
const after = saved[saved.length - 1].competitions.map((c) => c.name);
pass('moving last to first reorders', after[0] === before[4], after.join(' | '));
pass('nothing is lost', after.length === before.length && before.every((n) => after.includes(n)));
app.moveComp(after[0], after[0]);
pass('dropping on itself is a no-op', saved.length === 1);

const home = app.renderVals();
const card = home.competitions[0];
pass('cards expose an id for drop targeting', !!card.id, card.id);
pass('cards expose a drag handler', typeof card.dragStart === 'function');
pass('board order follows the app order',
     JSON.stringify(app.state.data.competitions.map((c) => c.name)) === JSON.stringify(after));

/* ------------------------------------------------ delete / feature spacing */
console.log('\n-- admin controls --');
let stopped = 0;
const fakeEvt = { stopPropagation: () => { stopped++; } };
card.feature(fakeEvt);
pass('star click does not open the competition', stopped === 1);
card.remove(fakeEvt);
pass('delete click does not open the competition', stopped === 2);

const idx = fs.readFileSync('./index.html', 'utf8');
pass('star sits inline beside the name', /c\.feature[^]{0,600}\{\{ c\.name \}\}/.test(idx));
pass('delete is a separate right-hand column', /flex:none;display:flex;align-items:center;padding:0 12px 0 6px"[^]{0,80}c\.remove/.test(idx));
pass('no more stacked absolute buttons', !idx.includes('position:absolute;top:78px'));
pass('grip has touch-action none', idx.includes('touch-action:none;line-height:1">⋮⋮'));

/* ---------------------------------------------------- glow sync + colour */
console.log('\n-- Up Next glow --');
const glow = home.upNext.filter((u) => u.vsAnim !== 'none');
pass('semi/final entries glow', glow.length > 0, glow.map((u) => u.comp).join(', '));
pass('bar and vs share one duration and phase',
     glow.every((u) => /goldline 2\.4s ease-in-out infinite/.test(u.topAnim) &&
                       /goldglow 2\.4s ease-in-out infinite/.test(u.vsAnim)));
pass('both colours are gold', glow.every((u) => u.topColor === GOLD && u.vsColor === GOLD));
const css = idx.slice(0, idx.indexOf('</helmet>'));
const gl = css.match(/@keyframes goldline\{[^@]*?\}\}/)[0];
const gg = css.match(/@keyframes goldglow\{[^@]*?\}\}/)[0];
pass('both keyframes peak at 50%', gl.includes('50%{border-color:#e8b44a}') && gg.includes('50%{opacity:1'));
pass('both keyframes start dim (in phase)',
     gl.includes('{0%,100%{border-color:rgba(232,180,74,.28)') && gg.includes('{0%,100%{opacity:.32'));

/* ------------------------------------------------------ gold milestones */
console.log('\n-- gold milestones --');
const goldFeed = home.feed.filter((f) => f.gold);
pass('semi/final wins are gold', goldFeed.some((f) => /Semifinals|Final/.test(f.sub)),
     (goldFeed.find((f) => /Semifinals|Final/.test(f.sub)) || {}).title);
pass('gold rows are coloured', goldFeed.every((f) => f.titleColor === GOLD && f.compColor === GOLD));
pass('ordinary rows are not', home.feed.filter((f) => !f.gold).every((f) => f.titleColor === '#f3f2f2'));
pass('a new #1 is detected from stored text',
     app.isGoldUpdate({ text: 'New leader: Moses Grant · 315 LBS' }) &&
     app.isGoldUpdate({ text: 'New fastest time: Isaiah Cole · 8:42' }));
pass('a mid-table move is not gold',
     !app.isGoldUpdate({ text: 'Ben Hastings moves up to #3 at 255 LBS' }));

// a live entry that takes #1 must be flagged at write time
const bench = app.state.data.competitions.find((c) => c.dots);
app.state = { ...app.state, view: 'event', cId: bench.id, boardName: 'New Guy', boardBw: '150', boardScore: '400' };
app.renderVals().addBoardRow();
const newUpd = app.state.data.competitions.find((c) => c.id === bench.id).updates[0];
pass('taking #1 writes the gold flag', newUpd.gold === true, newUpd.text);

/* -------------------------------------------------------------- podium */
console.log('\n-- featured podium --');
const Board = load('./board.html', '?demo=1');
const b = new Board();
const data = JSON.parse(JSON.stringify(seed));
const crucible = data.competitions.find((c) => c.name === 'Crucible');
crucible.board = [
  { name: 'One', score: '1:01' }, { name: 'Two', score: '2:02' }, { name: 'Three', score: '3:03' },
  { name: 'Four', score: '4:04' }, { name: 'Five', score: '5:05' }, { name: 'Six', score: '6:06' }
];
data.featuredComp = crucible.id;
b.state = { data, now: Date.now(), panelW: 600, offs: {}, focusIdx: -1, sweepCol: -1,
            newsMode: 'latest', newsY: 0, newsDur: 0 };
const bv = b.renderVals();
pass('row 1 holds the leader alone', bv.featTop.length === 1 && bv.featTop[0].rank === 1, bv.featTop[0].name);
pass('row 2 holds 2 and 3', bv.featSecond.length === 2 && bv.featSecond[0].rank === 2 && bv.featSecond[1].rank === 3,
     bv.featSecond.map((r) => r.rank + ':' + r.name).join(' '));
pass('row 3 holds 4 and 5', bv.featThird.length === 2 && bv.featThird[0].rank === 4 && bv.featThird[1].rank === 5,
     bv.featThird.map((r) => r.rank + ':' + r.name).join(' '));
pass('sixth place is not shown', bv.featRows.length === 5);
pass('leader is gold', bv.featTop[0].nameColor === GOLD && bv.featTop[0].scoreColor === GOLD);
pass('2nd-5th are not gold', [...bv.featSecond, ...bv.featThird].every((r) => r.nameColor !== GOLD));

// short leaderboards must not render empty rows
crucible.board = [{ name: 'Solo', score: '1:00' }];
const b2 = new Board();
b2.state = { ...b.state, data };
const bv2 = b2.renderVals();
pass('a single entry shows only row 1',
     bv2.featTop.length === 1 && !bv2.featHasSecond && !bv2.featHasThird);
crucible.board = [{ name: 'A', score: '1:00' }, { name: 'B', score: '2:00' }];
const b3 = new Board();
b3.state = { ...b.state, data };
const bv3 = b3.renderVals();
pass('two entries show rows 1 and 2 only', bv3.featHasSecond && !bv3.featHasThird && bv3.featSecond.length === 1);
