/* CHAMPION shared-state client.
 *
 * Wraps the app's data in a tiny sync layer so the phone app and the big-screen
 * board can run on different devices. Talks to /api/state when it's there and
 * falls back to localStorage-only when it isn't, so the exact same files still
 * work on a static host like GitHub Pages.
 *
 * Writes are last-writer-wins. That is deliberate: rejecting a stale write would
 * make an operator's tap silently revert, which is worse on a stage than the
 * rare case of two people scoring the same match inside the same second.
 */
window.ChampSync = (function () {
  var API = '/api/state';  // root-absolute; a relative path breaks at /board/
  var LS = 'champion-app-v2';
  var LS_REV = 'champion-rev';
  var LS_PIN = 'champion-pin';

  // null = not probed yet, true = API answered, false = static host, cache only
  var remote = null;
  var rev = 0;
  var timer = null;
  var pending = null;
  var inflight = false;
  var onRemote = null;

  try { rev = parseInt(localStorage.getItem(LS_REV) || '0', 10) || 0; } catch (e) {}

  function demo() { return /[?&]demo=1/.test(location.search); }

  function cacheGet() {
    try { var raw = localStorage.getItem(LS); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function cacheSet(data, r) {
    try {
      localStorage.setItem(LS, JSON.stringify(data));
      if (typeof r === 'number') { rev = r; localStorage.setItem(LS_REV, String(r)); }
    } catch (e) {}
  }
  function getPin() { try { return localStorage.getItem(LS_PIN) || ''; } catch (e) { return ''; } }
  function setPin(p) { try { localStorage.setItem(LS_PIN, p || ''); } catch (e) {} }

  function isOffline() { return remote === false; }

  // Pull the authoritative copy. Resolves null when there's nothing newer,
  // or when we're running without an API.
  function pull() {
    if (remote === false || demo()) return Promise.resolve(null);
    // Tell the server what we already have. It replies "unchanged" in a few
    // bytes when nothing has moved, instead of resending the whole state on
    // every poll. Only claim a revision if we actually still hold the data.
    var since = (rev > 0 && cacheGet()) ? '&since=' + rev : '';
    // Send the PIN on reads too: contact numbers are withheld from anyone who
    // cannot prove they are an admin.
    var headers = {};
    var p = getPin();
    if (p) headers['x-champ-pin'] = p;
    return fetch(API + '?t=' + Date.now() + since, { cache: 'no-store', headers: headers })
      .then(function (r) {
        if (r.status === 404 || r.status === 405 || r.status === 501) { remote = false; return null; }
        if (!r.ok) return null;
        return r.json().then(function (j) {
          remote = true;
          if (!j || typeof j.rev !== 'number') return null;
          if (j.unchanged) return null;        // server confirmed nothing moved
          if (j.rev === rev) return null;      // unchanged, don't churn React
          if (!j.data) return null;            // server empty, caller may seed
          cacheSet(j.data, j.rev);
          return { data: j.data, rev: j.rev };
        });
      })
      .catch(function () { return null; });    // network blip: keep showing cache
  }

  // Cache immediately, then coalesce rapid edits into one request.
  function push(data) {
    cacheSet(data);
    if (remote === false || demo()) return;
    pending = data;
    if (!timer && !inflight) timer = setTimeout(flush, 400);
  }

  function flush() {
    timer = null;
    if (inflight || !pending) return;
    var body = JSON.stringify({ rev: rev, data: pending });
    pending = null;
    inflight = true;
    fetch(API, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-champ-pin': getPin() },
      body: body
    })
      .then(function (r) {
        if (r.status === 404 || r.status === 405 || r.status === 501) { remote = false; return null; }
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (j) {
        if (j && typeof j.rev === 'number') { remote = true; rev = j.rev; try { localStorage.setItem(LS_REV, String(rev)); } catch (e) {} }
      })
      .catch(function () {})                   // stays in cache, next edit retries
      .then(function () {
        inflight = false;
        if (pending && !timer) timer = setTimeout(flush, 400);
      });
  }

  // True while a local edit hasn't reached the server yet — callers use this to
  // avoid letting a poll overwrite something the operator just typed.
  function dirty() { return !!(pending || inflight || timer); }

  function subscribe(fn) { onRemote = fn; }
  function notify(d) { if (onRemote) onRemote(d); }

  return {
    cacheGet: cacheGet, cacheSet: cacheSet,
    pull: pull, push: push, dirty: dirty,
    getPin: getPin, setPin: setPin,
    isOffline: isOffline, demo: demo,
    subscribe: subscribe, notify: notify,
    get rev() { return rev; }
  };
})();
