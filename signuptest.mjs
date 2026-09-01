import { Readable } from 'node:stream';
import fs from 'node:fs';
import vm from 'node:vm';

const signup = (await import('./api/signup.js')).default;
const state = (await import('./api/state.js')).default;

function call(handler, method, body, headers = {}, url = '/') {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [body] : []);
    req.method = method; req.headers = headers; req.url = url;
    const res = {
      statusCode: 200, setHeader() {},
      end(b) { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
    };
    handler(req, res);
  });
}

const pass = (n, c, x = '') => console.log((c ? 'PASS' : 'FAIL') + '  ' + n.padEnd(54) + (x || ''));
const post = (b) => call(signup, 'POST', JSON.stringify(b));
const get = () => call(state, 'GET');

// ---------- seed the store through the real state endpoint
function loadApp() {
  const store = {};
  const w = {
    location: { search: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {},
    document: { elementFromPoint: () => null },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) })
  };
  w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(fs.readFileSync('./sync.js', 'utf8'), ctx);
  const html = fs.readFileSync('./index.html', 'utf8');
  let js = html.slice(html.indexOf('data-dc-script'));
  js = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</script>'));
  vm.runInContext('class DCLogic { setState(o){ this.state = {...this.state, ...o}; } }\n' + js + '\n;Component', ctx);
  return vm.runInContext('Component', ctx);
}

const App = loadApp();
const app = new App();
app.props = { pin: 'Champs26', showBanner: true };
const seed = app.seedData();
const bench = seed.competitions.filter((c) => c.dots);
const timed = seed.competitions.filter((c) => !c.dots);

// The seed now ships a single Bench Press competition, so build a second
// DOTS competition here purely to prove the "one bench category only" rule.
seed.competitions.push({ id: 'bench2', name: 'Bench Press B', unit: 'LBS', hasBW: true, dots: true,
                         signupOpen: true, board: [], applicants: [], updates: [] });
const bench2 = seed.competitions[seed.competitions.length - 1];
[bench[0], bench2, timed[0]].forEach((c) => { c.signupOpen = true; });
await call(state, 'PUT', JSON.stringify({ rev: 0, data: seed }));

console.log('\n-- happy path --');
let r = await post({ name: 'Caleb Ortiz', bw: '154', attempts: ['225','245','265'], comps: [bench[0].id, timed[0].id] });
pass('signs up for a bench category and an event', r.status === 200, (r.json.added || []).join(' + '));

let d = (await get()).json.data;
const bc = d.competitions.find((c) => c.id === bench[0].id);
const row = (bc.applicants || []).find((x) => x.name === 'Caleb Ortiz');
pass('bench sign-up waits as an applicant', !!row, JSON.stringify(row));
pass('with body weight and attempts', row && row.bw === '154' && row.attempts.length === 3);
pass('not yet on the leaderboard', !bc.board.some((x) => x.name === 'Caleb Ortiz'));
const trow = d.competitions.find((c) => c.id === timed[0].id).board.find((x) => x.name === 'Caleb Ortiz');
pass('lands on the timed board too', !!trow);
pass('body weight not copied where it is meaningless', trow && trow.bw === '');

console.log('\n-- guards --');
r = await post({ name: 'Caleb Ortiz', bw: '154', attempts: ['225','245','265'], comps: [bench[0].id] });
pass('rejects a duplicate name', r.status === 409, r.json.error);

r = await post({ name: 'Two Groups', bw: '180', attempts: ['200','225','250'], comps: [bench[0].id, bench2.id] });
pass('rejects two bench categories at once', r.status === 400, r.json.error);

r = await post({ name: 'No Weight', comps: [bench[0].id] });
pass('bench requires a body weight', r.status === 400, r.json.error);

r = await post({ name: 'Silly Weight', bw: '999', attempts: ['225','245','265'], comps: [bench[0].id] });
pass('rejects an implausible body weight', r.status === 400, r.json.error);

r = await post({ name: 'Closed Comp', comps: [timed[1] ? timed[1].id : 'nope'] });
pass('rejects a competition with sign-ups closed', r.status === 403, r.json.error);

r = await post({ name: 'Ghost', comps: ['does-not-exist'] });
pass('rejects an unknown competition', r.status === 400, r.json.error);

r = await post({ name: 'X', comps: [timed[0].id] });
pass('rejects a one-character name', r.status === 400, r.json.error);

r = await post({ name: 'No Picks', comps: [] });
pass('rejects an empty selection', r.status === 400, r.json.error);

r = await post({ name: '<script>bad</script>', comps: [timed[0].id] });
pass('rejects markup in a name', r.status === 400, r.json.error);

r = await call(signup, 'GET');
pass('GET is not allowed', r.status === 405);

console.log('\n-- cannot be used to score --');
const before = JSON.stringify((await get()).json.data.tournaments);
await post({ name: 'Someone Else', bw: '200', attempts: ['225','245','265'], comps: [bench[0].id] });
pass('brackets untouched by sign-up', JSON.stringify((await get()).json.data.tournaments) === before);
const sample = (await get()).json.data.competitions.find((c) => c.id === bench[0].id);
pass('existing results untouched',
     sample.board.filter((x) => x.score).length === bench[0].board.filter((x) => x.score).length,
     `${sample.board.filter((x) => x.score).length} scored rows intact`);

console.log('\n-- sorting with pending rows --');
{
  const c = { dots: true, board: [
    { name: 'Scored A', bw: '200', score: '315' },
    { name: 'Pending', bw: '180', score: '' },
    { name: 'Scored B', bw: '160', score: '250' }
  ] };
  const order = app.sortBoard(c).map((x) => x.name);
  pass('pending rows sink below scored ones', order[order.length - 1] === 'Pending', order.join(' > '));
  const pts = (bw, l) => app.dots(bw, l);
  pass('scored rows still rank by points',
       order[0] === (pts('200','315') > pts('160','250') ? 'Scored A' : 'Scored B'),
       `${pts('200','315')} vs ${pts('160','250')} -> ${order.join(' > ')}`);
}
{
  const c = { lowerBetter: true, board: [
    { name: 'Slow', score: '9:15' }, { name: 'Pending', score: '' }, { name: 'Fast', score: '8:42' }
  ] };
  const order = app.sortBoard(c).map((x) => x.name);
  pass('timed events sort correctly despite a pending row', order.join(',') === 'Fast,Slow,Pending', order.join(' > '));
}

console.log('\n-- app surface --');
app.state = { view: 'events', adminOn: false, data: (await get()).json.data,
              signupName: '', signupBw: '', signupPick: {}, signupBench: '', signupMsg: '', signupBusy: false,
              boardName: '', boardBw: '', boardScore: '', updateText: '', cDragId: null, cOverId: null };
let v = app.renderVals();
pass('form appears when something is open', v.signupAny === true);
pass('bench options are a single-choice group', v.signupBench.length === 2, v.signupBench.map((b) => b.name).join(', '));
pass('other events are multi-choice', v.signupOther.length === 1, v.signupOther.map((o) => o.name).join(', '));
v.signupBench[0].pick(); v.signupBench[1].pick();
pass('picking a second bench group replaces the first', app.state.signupBench === v.signupBench[1].id);

app.state = { ...app.state, data: seed };
seed.competitions.forEach((c) => { c.signupOpen = false; });
pass('form hides when everything is closed', app.renderVals().signupAny === false);

app.state = { ...app.state, adminOn: true, data: (await get()).json.data };
v = app.renderVals();
const card = v.competitions.find((c) => c.id === bench[0].id);
pass('admin sees a sign-up toggle', typeof card.toggleSignup === 'function' && card.signupOn === true, card.signupLabel);

app.state = { ...app.state, view: 'event', cId: bench[0].id };
v = app.renderVals();
// a non-bench sign-up goes straight onto the board with no score
app.state = { ...app.state, view: 'event', cId: timed[0].id };
const pending = app.renderVals().cBoard.find((x) => x.name === 'Caleb Ortiz');
pass('pending row reads as awaiting', pending && pending.score === 'AWAITING', pending && pending.score);
pass('pending row is dimmed', pending && pending.nameColor === '#8b93a1');
pending.fill();
pass('tapping it prefills the score form',
     app.state.boardName === 'Caleb Ortiz' && app.state.boardBw === '',
     `name "${app.state.boardName}", no body weight on a timed event`);

/* ─────────────────────── tournament sign-ups ─────────────────────── */
console.log('\n-- tournament sign-ups --');
{
  const d = (await get()).json.data;
  d.tournaments = [{ id: 't1', name: 'FC World Cup', seeding: 'order',
                     entrants: ['Existing One', 'Existing Two'],
                     rounds: [[{ a: 'Existing One', b: 'Existing Two', winner: null, bye: false, ts: null, sa: null, sb: null }]],
                     signupOpen: true }];
  await call(state, 'PUT', JSON.stringify({ rev: 0, data: d }));

  let r = await post({ name: 'Bracket Hopeful', comps: [], tours: ['t1'] });
  pass('can sign up for a tournament alone', r.status === 200, (r.json.added || []).join(', '));

  let t = (await get()).json.data.tournaments[0];
  pass('waits in the sign-up list', (t.signups || []).includes('Bracket Hopeful'), JSON.stringify(t.signups));
  pass('bracket is NOT rebuilt underneath the admin', t.rounds.length === 1 && t.entrants.length === 2,
       `${t.entrants.length} entrants, ${t.rounds.length} round`);

  r = await post({ name: 'Bracket Hopeful', comps: [], tours: ['t1'] });
  pass('rejects a duplicate', r.status === 409, r.json.error);

  r = await post({ name: 'Existing One', comps: [], tours: ['t1'] });
  pass('rejects someone already in the bracket', r.status === 409, r.json.error);

  const d2 = (await get()).json.data;
  d2.tournaments[0].signupOpen = false;
  await call(state, 'PUT', JSON.stringify({ rev: 0, data: d2 }));
  r = await post({ name: 'Too Late', comps: [], tours: ['t1'] });
  pass('rejects when closed', r.status === 403, r.json.error);

  r = await post({ name: 'Nobody', comps: [], tours: ['nope'] });
  pass('rejects an unknown tournament', r.status === 400, r.json.error);

  r = await post({ name: 'Empty Pick', comps: [], tours: [] });
  pass('still requires at least one pick', r.status === 400);
}

/* ─────────────────────── admin folds them in ─────────────────────── */
console.log('\n-- admin adds them to the bracket --');
{
  const d = (await get()).json.data;
  d.tournaments[0].signupOpen = true;
  await call(state, 'PUT', JSON.stringify({ rev: 0, data: d }));
  await post({ name: 'Second Hopeful', comps: [], tours: ['t1'] });

  app.state = { ...app.state, view: 'bracket', tId: 't1', adminOn: true,
                entrantsText: null, signupTour: {}, signupPick: {}, signupBench: '',
                data: (await get()).json.data };
  let v = app.renderVals();
  pass('admin sees the waiting list', v.bHasWaiting === true, v.bWaitingLabel);
  pass('names are listed', /Bracket Hopeful/.test(v.bWaitingText), v.bWaitingText);
  pass('toggle is available', typeof v.bToggleSignup === 'function' && v.bSignupLabel === 'Sign-ups open');

  v.bAddWaiting();
  const lines = app.state.entrantsText.split('\n');
  pass('adds them to the editor without rebuilding', lines.length === 4, lines.join(' | '));
  pass('existing entrants kept first', lines[0] === 'Existing One' && lines[1] === 'Existing Two');
  pass('nothing saved yet', app.state.data.tournaments[0].entrants.length === 2);

  v = app.renderVals();
  v.regenerate();
  const t = app.state.data.tournaments[0];
  pass('applying builds the bracket with everyone', t.entrants.length === 4, t.entrants.join(', '));
  pass('waiting list is cleared once they are in', (t.signups || []).length === 0);
}

/* ─────────────────── bench sign-up with three attempts ─────────────────── */
console.log('\n-- bench applications --');
{
  const d = (await get()).json.data;
  d.competitions = [{ id: 'bp', name: 'Bench Press', unit: 'LBS', hasBW: true, dots: true,
                      signupOpen: true, board: [], applicants: [], updates: [] }];
  d.tournaments = [];
  await call(state, 'PUT', JSON.stringify({ rev: 0, data: d }));

  let r = await post({ name: 'Heavy Guy', bw: '260', attempts: ['300', '325', '340'], comps: ['bp'] });
  pass('accepts a bench application', r.status === 200);

  r = await post({ name: 'Light Guy', bw: '150', attempts: ['230', '245', '260'], comps: ['bp'] });
  pass('accepts a second', r.status === 200);

  let c = (await get()).json.data.competitions[0];
  pass('applications wait in a separate list', (c.applicants || []).length === 2, `${c.applicants.length} applicants`);
  pass('the leaderboard stays empty', (c.board || []).length === 0);
  pass('attempts are stored', c.applicants[0].attempts.join('/') === '300/325/340', c.applicants[0].attempts.join('/'));

  r = await post({ name: 'No Attempts', bw: '200', comps: ['bp'] });
  pass('requires all three attempts', r.status === 400, r.json.error);
  r = await post({ name: 'Two Only', bw: '200', attempts: ['200', '225'], comps: ['bp'] });
  pass('rejects two attempts', r.status === 400, r.json.error);
  r = await post({ name: 'Silly', bw: '200', attempts: ['200', '225', '5000'], comps: ['bp'] });
  pass('rejects an implausible attempt', r.status === 400, r.json.error);
  r = await post({ name: 'Heavy Guy', bw: '260', attempts: ['300', '325', '340'], comps: ['bp'] });
  pass('rejects a duplicate applicant', r.status === 409, r.json.error);
}

/* ───────────────────────── admin ranks the field ───────────────────────── */
console.log('\n-- ranking on projected DOTS --');
{
  app.state = { ...app.state, view: 'event', cId: 'bp', adminOn: true,
                signupTour: {}, signupPick: {}, signupBench: '',
                data: (await get()).json.data };
  let v = app.renderVals();
  pass('admin sees the applicants', v.cHasApplicants === true, v.cApplicantCount);

  const order = v.cApplicants.map((a) => a.name);
  const light = app.dots('150', '260'), heavy = app.dots('260', '340');
  pass('ranked on the best planned attempt, not raw weight',
       order[0] === (light > heavy ? 'Light Guy' : 'Heavy Guy'),
       `Light ${light} vs Heavy ${heavy} -> ${order.join(' > ')}`);
  pass('projection shown per applicant', /^\d+\.\d\d proj$/.test(v.cApplicants[0].proj), v.cApplicants[0].proj);
  pass('attempts shown for context', /BW \d+ · \d+ \/ \d+ \/ \d+ LBS/.test(v.cApplicants[0].meta), v.cApplicants[0].meta);

  v.cApplicants[0].accept();
  const c = app.state.data.competitions[0];
  pass('accepting moves them onto the board', c.board.length === 1 && c.board[0].name === order[0]);
  pass('and off the applicant list', c.applicants.length === 1);
  pass('body weight carried over, no score yet', c.board[0].bw !== '' && c.board[0].score === '');

  v = app.renderVals();
  v.cApplicants[0].drop();
  pass('declining removes without adding', app.state.data.competitions[0].applicants.length === 0 &&
       app.state.data.competitions[0].board.length === 1);
}

/* ────────────────────────── accept the top field ───────────────────────── */
console.log('\n-- accept top 30 --');
{
  const d = (await get()).json.data;
  d.competitions[0].board = [];
  d.competitions[0].applicants = Array.from({ length: 42 }, (_, i) => ({
    name: `Applicant ${String(i + 1).padStart(2, '0')}`, bw: String(150 + i), attempts: ['200', '225', String(250 + i)]
  }));
  app.state = { ...app.state, data: d };
  let v = app.renderVals();
  pass('button offers the right count', v.cAcceptLabel === 'Accept top 30', v.cAcceptLabel);
  pass('top 30 highlighted, rest not',
       v.cApplicants[29].projColor === '#e8b44a' && v.cApplicants[30].projColor === '#8b93a1');
  v.cAcceptTop();
  const c = app.state.data.competitions[0];
  pass('exactly 30 enter the competition', c.board.length === 30, `${c.board.length} entered`);
  pass('the other 12 stay as applicants', c.applicants.length === 12, `${c.applicants.length} remaining`);
  const entered = new Set(c.board.map((r) => r.name));
  pass('nobody is both entered and waiting', !c.applicants.some((a) => entered.has(a.name)));
}
