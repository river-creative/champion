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

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(52) + (x || ''));

const App = load('./index.html');
const app = new App();
app.props = { pin: 'Champs26', showBanner: true };
const data = app.seedData();

// a bench category with more than five lifters, so a low placer exists
const bench = data.competitions.find((c) => c.dots);
bench.board = [
  { name: 'Alpha', bw: '200', score: '315' }, { name: 'Bravo', bw: '190', score: '300' },
  { name: 'Charlie', bw: '185', score: '285' }, { name: 'Delta', bw: '210', score: '280' },
  { name: 'Echo', bw: '175', score: '265' }, { name: 'Foxtrot', bw: '205', score: '250' },
  { name: 'Typo', bw: '160', score: '9999' }
];
bench.updates = [
  { ts: 1000, text: 'New leader: Typo · 9999 LBS', auto: true, gold: true },
  { ts: 900, text: 'Qualifying open at the main stage.' }
];

const saved = [];
app.save = (d) => { saved.push(d); app.state.data = d; };
const setView = (admin) => {
  app.state = { view: 'event', cId: bench.id, adminOn: admin, data: app.state && app.state.data ? app.state.data : data,
                boardName: '', boardBw: '', boardScore: '', updateText: '', confirm: null,
                cDragId: null, cOverId: null };
  return app.renderVals();
};
app.state = { data };

/* --------------------------------------------------- visibility of rows */
console.log('\n-- reaching every result --');
let v = setView(false);
pass('public view still shows only the top 5', v.cBoard.length === 5, `${v.cBoard.length} rows`);
v = setView(true);
pass('admin sees every entrant', v.cBoard.length === 7, `${v.cBoard.length} rows`);
pass('the bad row is reachable', v.cBoard.some((r) => r.name === 'Typo'));
pass('every row has a delete', v.cBoard.every((r) => typeof r.remove === 'function'));

/* -------------------------------------------------------- delete a row */
console.log('\n-- remove a single result --');
const typo = v.cBoard.find((r) => r.name === 'Typo');
typo.remove();
pass('asks before deleting', app.state.confirm && app.state.confirm.kind === 'delrow', app.state.confirm.kind);
let vv = app.renderVals();
pass('dialog names the lifter', /Remove Typo from this leaderboard/.test(vv.confirmBody), vv.confirmTitle);
pass('dialog warns the update survives', /update mentioning them stays/.test(vv.confirmBody));
vv.confirmNo();
pass('cancel leaves the row alone', app.state.data.competitions.find((c) => c.id === bench.id).board.length === 7);

v = setView(true);
v.cBoard.find((r) => r.name === 'Typo').remove();
app.renderVals().confirmYes();
const after = app.state.data.competitions.find((c) => c.id === bench.id);
pass('confirm removes just that row', after.board.length === 6 && !after.board.some((r) => r.name === 'Typo'),
     after.board.map((r) => r.name).join(', '));
pass('the write is persisted', saved.length === 1);
pass('other competitions untouched',
     app.state.data.competitions.length === data.competitions.length);

/* ----------------------------------------------------- delete an update */
console.log('\n-- remove a stale update --');
v = setView(true);
pass('the bogus update is still there', v.cUpdates.length === 2, v.cUpdates[0].text);
v.cUpdates[0].remove();
vv = app.renderVals();
pass('asks before deleting', app.state.confirm.kind === 'delupdate');
pass('dialog quotes the update', /New leader: Typo/.test(vv.confirmBody));
vv.confirmYes();
const upAfter = app.state.data.competitions.find((c) => c.id === bench.id).updates;
pass('only that update is gone', upAfter.length === 1 && !/Typo/.test(upAfter[0].text), upAfter[0].text);

/* --------------------------------------------------------- clear results */
console.log('\n-- clear a competition --');
v = setView(true);
pass('clear button offered while there is data', v.cCanClear === true);
v.clearComp();
vv = app.renderVals();
pass('asks before clearing', app.state.confirm.kind === 'clearcomp');
pass('dialog says the competition survives', /competition itself stays/.test(vv.confirmBody), vv.confirmTitle);
vv.confirmYes();
const cleared = app.state.data.competitions.find((c) => c.id === bench.id);
pass('results emptied', cleared.board.length === 0);
pass('updates emptied', cleared.updates.length === 0);
pass('competition kept with its settings',
     cleared.name === bench.name && cleared.dots === true && cleared.hasBW === true,
     `${cleared.name} dots=${cleared.dots}`);
pass('other competitions survive intact',
     app.state.data.competitions.length === data.competitions.length &&
     app.state.data.competitions.some((c) => c.board && c.board.length),
     `${app.state.data.competitions.length} competitions remain`);

v = setView(true);
pass('clear button hidden once empty', v.cCanClear === false);

/* ------------------------------------------------------- non-admin safety */
console.log('\n-- non-admin --');
const idx = fs.readFileSync('./index.html', 'utf8');
const rowBlock = idx.slice(idx.indexOf('{{ row.score }}'), idx.indexOf('{{ row.score }}') + 500);
pass('row delete is behind an admin check', /sc-if value="\{\{ adminOn \}\}"[^]{0,120}row\.remove/.test(rowBlock));
const upBlock = idx.slice(idx.indexOf('{{ u.text }}'), idx.indexOf('{{ u.text }}') + 500);
pass('update delete is behind an admin check', /sc-if value="\{\{ adminOn \}\}"[^]{0,150}u\.remove/.test(upBlock));
pass('clear button is inside the admin block',
     idx.indexOf('{{ clearComp }}') > idx.indexOf('{{ addBoardRow }}'));

/* ----------------------------------------- overwrite still works for edits */
console.log('\n-- editing by overwrite --');
const c2 = app.state.data.competitions.find((c) => c.id === bench.id);
c2.board = [{ name: 'Alpha', bw: '200', score: '315' }];
app.state = { ...app.state, view: 'event', cId: bench.id, adminOn: true,
              boardName: 'Alpha', boardBw: '200', boardScore: '325', updateText: '', confirm: null };
app.renderVals().addBoardRow();
const edited = app.state.data.competitions.find((c) => c.id === bench.id).board;
pass('re-entering a name overwrites rather than duplicating',
     edited.length === 1 && edited[0].score === '325', `${edited.length} row, score ${edited[0].score}`);
