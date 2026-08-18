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

const Board = load('./board.html', '?demo=1');
const mk = (data) => {
  const b = new Board();
  b.state = { data, now: Date.now(), panelW: 600, offs: {}, focusIdx: -1, sweepCol: -1,
              newsMode: 'upnext', newsY: 0, newsDur: 0 };
  return b.renderVals();
};

const base = new Board();
const seed = base.seedData();

console.log('\n-- Up Next rotation --');
let v = mk(JSON.parse(JSON.stringify(seed)));
console.log('   order:');
v.upNext.forEach((u, i) => console.log(`     ${i + 1}. ${u.comp.padEnd(26)} ${u.round.padEnd(14)} ${u.star || ' '} ${u.a} v ${u.b}`));

// no bracket appears twice before every other bracket has appeared once
const comps = v.upNext.map((u) => u.comp);
const distinct = [...new Set(comps)];
let ok = true, firstPass = comps.slice(0, distinct.length);
if (new Set(firstPass).size !== distinct.length) ok = false;
pass('every bracket appears before any repeats', ok, firstPass.join(' -> '));

// check the whole list cycles rather than grouping
// A bracket may only appear twice in a row once every OTHER bracket has run
// out of playable matches - otherwise the rotation skipped someone's turn.
let unfair = null;
for (let i = 1; i < comps.length; i++) {
  if (comps[i] !== comps[i - 1]) continue;
  const rest = comps.slice(i);
  const starved = distinct.filter((c) => c !== comps[i] && rest.includes(c));
  if (starved.length) unfair = `${comps[i]} repeated at ${i + 1} while ${starved.join(',')} still had matches`;
}
pass('a bracket only repeats once the others are exhausted', !unfair,
     unfair || comps.map((c) => c.split(' ')[0]).join(' > '));

/* -------------------------------------------------- later rounds first */
const d2 = JSON.parse(JSON.stringify(seed));
v = mk(d2);
const byComp = {};
v.upNext.forEach((u) => { (byComp[u.comp] = byComp[u.comp] || []).push(u.round); });
const rank = { 'Final': 0, 'Semifinals': 1, 'Quarterfinals': 2 };
const rk = (r) => (r in rank ? rank[r] : 3 + (parseInt((r.match(/\d+/) || [999])[0], 10) || 999));
let ordered = true;
Object.entries(byComp).forEach(([c, rounds]) => {
  for (let i = 1; i < rounds.length; i++) if (rk(rounds[i]) < rk(rounds[i - 1])) ordered = false;
});
pass('within a bracket, later rounds come first', ordered,
     Object.entries(byComp).map(([c, r]) => c.split(' ')[0] + ':' + r.join('>')).join('  '));

/* ------------------------------------------------------ featured jumps */
const d3 = JSON.parse(JSON.stringify(seed));
const cod = d3.tournaments.find((t) => t.name === 'Call of Duty');
// feature an early-round match in the LAST tournament
let fr = -1, fi = -1;
cod.rounds[0].forEach((m, i) => { if (fr < 0 && m.a && m.b && !m.winner) { fr = 0; fi = i; } });
if (fr < 0) { cod.rounds[1].forEach((m, i) => { if (fr < 0 && m.a && m.b && !m.winner) { fr = 1; fi = i; } }); }
cod.featured = { r: fr, i: fi };
v = mk(d3);
pass('a featured match leads the whole list',
     v.upNext[0].star === '\u2605' && v.upNext[0].comp === 'Call of Duty',
     `${v.upNext[0].comp} ${v.upNext[0].round} ${v.upNext[0].a} v ${v.upNext[0].b}`);
pass('featured is not duplicated further down',
     v.upNext.filter((u) => u.a === v.upNext[0].a && u.b === v.upNext[0].b).length === 1);

/* ---------------------------------------------------------- edge cases */
const one = { tournaments: [seed.tournaments[0]], competitions: [] };
v = mk(JSON.parse(JSON.stringify(one)));
pass('a single bracket still fills the list', v.upNext.length > 1, `${v.upNext.length} entries`);
pass('single bracket is ordered latest-round-first',
     rk(v.upNext[0].round) <= rk(v.upNext[v.upNext.length - 1].round),
     v.upNext.map((u) => u.round).join(' > '));

const none = { tournaments: [], competitions: [] };
v = mk(none);
pass('no brackets means an empty list', v.upNext.length === 0 && v.upNextEmpty === true);

// a bracket with nothing playable must not stall the rotation
const d4 = JSON.parse(JSON.stringify(seed));
d4.tournaments[1].rounds.forEach((rd) => rd.forEach((m) => { if (m.a && m.b) m.winner = m.a; }));
v = mk(d4);
pass('a finished bracket is skipped without stalling',
     v.upNext.length > 0 && !v.upNext.some((u) => u.comp === d4.tournaments[1].name),
     `${v.upNext.length} entries from ${[...new Set(v.upNext.map((u) => u.comp))].length} brackets`);

/* ------------------------------------------------------- panel padding */
console.log('\n-- featured panel sizing --');
const bh = fs.readFileSync('./board.html', 'utf8');
const panel = bh.slice(bh.indexOf('border-top:3px solid #e8b44a'), bh.indexOf('{{ gridRef }}'));
pass('outer padding reduced', panel.includes('padding:13px 18px') && !panel.includes('padding:20px 26px'));
pass('competitor boxes tightened', (panel.match(/padding:8px 12px/g) || []).length === 2,
     `${(panel.match(/padding:8px 12px/g) || []).length} of 2 boxes`);
pass('4th/5th row tightened', panel.includes('padding:7px 10px'));
pass('row gaps reduced', (panel.match(/gap:10px/g) || []).length >= 2 && !panel.includes('gap:14px'));
pass('leader width still matches a pair box', panel.includes('width:calc(50% - 5px)'));
pass('type sizes untouched', panel.includes('font-size:22px') && panel.includes('font-size:20px'));
