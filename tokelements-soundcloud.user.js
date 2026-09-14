// ==UserScript==
// @name         TokElements for SoundCloud
// @namespace    tokelements.soundcloud
// @version      0.2.3
// @description  Drive your logged-in SoundCloud web player for TokElements (now-playing overlay + viewer song requests into Next up). No SoundCloud app or client id needed. One-click pairing when TokElements runs in the same browser.
// @author       TokElements
// @homepageURL  https://github.com/tokelements/tokelements-soundcloud
// @supportURL   https://github.com/tokelements/tokelements-soundcloud/issues
// @updateURL    https://raw.githubusercontent.com/tokelements/tokelements-soundcloud/main/tokelements-soundcloud.user.js
// @downloadURL  https://raw.githubusercontent.com/tokelements/tokelements-soundcloud/main/tokelements-soundcloud.user.js
// @match        https://soundcloud.com/*
// @match        http://localhost:3000/*
// @match        http://127.0.0.1:3000/*
// @match        https://*.tokelements.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/*
  Two roles, chosen by the page it runs on:

  1) On a TokElements page  → "bridge". Lets the SoundCloud settings page pair with ONE click:
       page  →  { __te_soundcloud:'pair', code, teUrl }  → stored with GM_setValue (shared across tabs)
       we    →  { __te_soundcloud:'agent-present' | 'paired' | 'unpaired' } → the page updates itself

  2) On soundcloud.com → the "agent". SoundCloud's web player keeps its queue in the page, not on a
     server, so the only way to read what is playing and to put a requested song in "Next up" is from
     inside the page. A small script is injected into the page context, finds the player's own
     PlayManager through the webpack runtime (by shape, never by module id — those change on every
     SoundCloud build) and exposes exactly four things: read now-playing, read the queue, run a
     transport command, add a track. If that ever stops working the script falls back to reading the
     player bar in the DOM, so at least the overlay keeps showing the song.

     The userscript half talks to TokElements over GM_xmlhttpRequest (CSP/CORS-safe):
       POST <TE>/api/soundcloud/agent/state?code=<pair>     { nowPlaying, queue }   (+15s heartbeat)
       GET  <TE>/api/soundcloud/agent/commands?code=<pair>  → { commands:[…] }
       POST <TE>/api/soundcloud/agent/ack?code=<pair>       { id, ok, error?, added? }

  For a different browser or another computer: open the TokElements SoundCloud page, copy the pairing
  code, and enter it here via the Tampermonkey menu → "TokElements: set pairing code" (+ "set URL").
*/

(function () {
  'use strict';

  var HOST = location.hostname;
  var IS_TE = HOST === 'localhost' || HOST === '127.0.0.1' || /(^|\.)tokelements\.com$/.test(HOST);
  var IS_SC = /(^|\.)soundcloud\.com$/.test(HOST);
  if (!IS_TE && !IS_SC) return;

  var NS = '__te_soundcloud';

  // ============================ ROLE 1: bridge on the TokElements page ============================
  if (IS_TE) {
    var post = function (msg) {
      try { var m = {}; m[NS + '_from'] = 'agent'; for (var k in msg) m[k] = msg[k]; window.postMessage(m, location.origin); } catch (e) {}
    };
    var announce = function () { var m = {}; m[NS] = 'agent-present'; m.version = '0.2.3'; post(m); };
    announce();
    var n = 0, iv = setInterval(function () { announce(); if (++n > 12) clearInterval(iv); }, 1200);
    window.addEventListener('message', function (e) {
      // No e.source check: in the Tampermonkey sandbox `window` is a proxy that is not identical to
      // the page window, so comparing them would drop the page's own messages. Origin + namespace guard.
      if (e.origin !== location.origin) return;
      var d = e.data || {};
      if (!d || d[NS + '_from'] === 'agent') return;
      if (d[NS] === 'page-hello') return announce();
      if (d[NS] === 'pair' && d.code) {
        GM_setValue('teUrl', String(d.teUrl || location.origin).replace(/\/$/, ''));
        GM_setValue('pairCode', String(d.code).trim());
        var m = {}; m[NS] = 'paired'; post(m);
      }
      if (d[NS] === 'unpair') { GM_deleteValue('pairCode'); var u = {}; u[NS] = 'unpaired'; post(u); }
    });
    return;
  }

  // ============================ ROLE 2: agent on soundcloud.com ============================
  var S = {
    teUrl: (GM_getValue('teUrl', '') || '').replace(/\/$/, ''),
    pairCode: GM_getValue('pairCode', ''),
    np: null, queue: [], online: null, player: null, lastPushOk: 0, haveSnapshot: false, loggedOut: false, lastResult: null,
  };
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener('pairCode', function (_k, _o, v) { S.pairCode = v || ''; hud(); });
    GM_addValueChangeListener('teUrl', function (_k, _o, v) { S.teUrl = (v || '').replace(/\/$/, ''); hud(); });
  }

  // ---------------------------------------------------------------------------------------------
  // The page-context half. Everything below runs INSIDE soundcloud.com's own JavaScript context,
  // because the player lives there; it is injected as a <script> and talks back over postMessage.
  // ---------------------------------------------------------------------------------------------
  function pageBridge() {
    var NS = '__te_soundcloud';
    var REQ = null, PM = null, SoundModel = null;

    function webpackRequire() {
      if (REQ) return REQ;
      try {
        if (window.__teScReq) { REQ = window.__teScReq; return REQ; }
        // Ask webpack for a module of our own; its third argument is the runtime's require.
        window.webpackJsonp.push([['te_sc_probe'], { te_sc_probe: function (m, e, r) { window.__teScReq = r; } }, [['te_sc_probe']]]);
        REQ = window.__teScReq || null;
      } catch (e) { REQ = null; }
      return REQ;
    }
    // Modules are found by what they export, never by id: SoundCloud renumbers them on every build.
    function findExport(pred) {
      var R = webpackRequire();
      if (!R || !R.c) return null;
      for (var id in R.c) {
        var ex;
        try { ex = R.c[id].exports; } catch (e) { continue; }
        if (!ex) continue;
        try { if (pred(ex)) return ex; } catch (e) {}
      }
      return null;
    }
    function playManager() {
      if (PM && typeof PM.getQueue === 'function') return PM;
      PM = findExport(function (e) {
        return typeof e.getQueue === 'function' && typeof e.playNext === 'function'
          && typeof e.getCurrentSound === 'function' && typeof e.addExplicitQueueItem === 'function';
      });
      return PM;
    }
    function soundModel() {
      if (SoundModel) return SoundModel;
      SoundModel = findExport(function (e) {
        return typeof e === 'function' && e.prototype && e.prototype.resource_type === 'sound'
          && typeof e.prototype.getSounds === 'function' && typeof e.prototype.getUrn === 'function';
      });
      return SoundModel;
    }
    /*
     * Signed in, or a visitor? The hydrated `meUser` is the app's own answer. With no hydration at
     * all, only call it signed out when the page is offering a sign-in, so a slow first render does
     * not raise a false alarm in the streamer's studio.
     */
    function isLoggedOut() {
      try {
        var h = window.__sc_hydration || [];
        for (var i = 0; i < h.length; i++) if (h[i] && h[i].hydratable === 'meUser') return !h[i].data;
      } catch (e) {}
      return !!document.querySelector('.header__login, a[href*="/signin"]');
    }
    function clientId() {
      try {
        var h = window.__sc_hydration || [];
        for (var i = 0; i < h.length; i++) if (h[i] && h[i].hydratable === 'apiClient' && h[i].data) return h[i].data.id;
      } catch (e) {}
      return null;
    }

    var art = function (url) { return url ? String(url).replace(/-large\.(jpg|png)/, '-t500x500.$1') : null; };
    function brief(sound) {
      if (!sound || typeof sound.get !== 'function') return null;
      var title = sound.get('title');
      if (!title) return null;
      var user = sound.get('user') || {};
      return {
        uri: sound.get('urn') || (sound.get('id') ? 'soundcloud:tracks:' + sound.get('id') : null),
        title: title,
        artist: user.username || '',
        image: art(sound.get('artwork_url') || user.avatar_url),
        durationMs: Number(sound.get('duration')) || 0,
      };
    }
    var soundOf = function (item) { return item && (item.sound || (item.options && item.options.sound) || (item.get && item.get('sound'))); };

    // Position comes from the player bar: the internal player does not expose a clock we can read,
    // and the progress element carries plain seconds in aria attributes, in every language.
    function domPosition() {
      var el = document.querySelector('.playbackTimeline__progressWrapper');
      if (!el) return { positionMs: null, durationMs: null };
      var now = parseFloat(el.getAttribute('aria-valuenow'));
      var max = parseFloat(el.getAttribute('aria-valuemax'));
      return { positionMs: isFinite(now) ? Math.round(now * 1000) : null, durationMs: isFinite(max) ? Math.round(max * 1000) : null };
    }
    // Last resort if the player object cannot be reached: the badge in the player bar. The title
    // attributes are the real strings; the visible text has a screen-reader prefix in front of it.
    function domNowPlaying() {
      var t = document.querySelector('.playbackSoundBadge__titleLink');
      if (!t) return null;
      var a = document.querySelector('.playbackSoundBadge__lightLink');
      var img = document.querySelector('.playbackSoundBadge span.sc-artwork');
      var cover = null;
      if (img) { var bg = getComputedStyle(img).backgroundImage || ''; var m = bg.match(/url\("?([^")]+)"?\)/); if (m) cover = art(m[1]); }
      var pos = domPosition();
      var btn = document.querySelector('.playControls__play');
      return {
        track: t.getAttribute('title') || (t.textContent || '').trim(),
        artist: a ? (a.getAttribute('title') || (a.textContent || '').trim()) : '',
        cover: cover,
        positionMs: pos.positionMs, durationMs: pos.durationMs,
        playing: !!(btn && /\bplaying\b/.test(btn.className)),
      };
    }

    function snapshot() {
      var pm = playManager();
      if (!pm) { var dom = domNowPlaying(); return { nowPlaying: dom, queue: [], viaPlayer: false, loggedOut: isLoggedOut() }; }
      var cur = null, playing = false;
      try { cur = brief(pm.getCurrentSound()); playing = !!pm.isPlaying(); } catch (e) {}
      var pos = domPosition();
      var np = cur ? {
        track: cur.title, artist: cur.artist, cover: cur.image,
        positionMs: pos.positionMs, durationMs: cur.durationMs || pos.durationMs, playing: playing,
      } : domNowPlaying();
      var queue = [], missing = [];
      try {
        var q = pm.getQueue(), idx = q.indexOf(pm.getCurrentQueueItem());
        for (var i = idx + 1; i < q.length && queue.length < 8; i++) {
          var sound = soundOf(q.at(i));
          var b = brief(sound);
          if (b) { queue.push(b); }
          else if (sound && sound.get && sound.get('id')) {
            // Tracks further down the queue are not loaded yet; keep their place and fill the title in.
            queue.push({ uri: 'soundcloud:tracks:' + sound.get('id'), title: '', artist: '', image: null, durationMs: 0, _id: sound.get('id') });
            missing.push(sound.get('id'));
          }
        }
      } catch (e) {}
      if (missing.length) resolveTracks(missing);
      queue = queue.map(function (t) { var c = t._id && RESOLVED[t._id]; return c ? c : t; }).filter(function (t) { return t.title; });
      return { nowPlaying: np, queue: queue, viaPlayer: true, loggedOut: isLoggedOut() };
    }

    // Titles for queue entries the player has not loaded yet, resolved once and remembered.
    var RESOLVED = {}, RESOLVING = {};
    function resolveTracks(ids) {
      var cid = clientId();
      if (!cid) return;
      var want = [];
      for (var i = 0; i < ids.length; i++) if (!RESOLVED[ids[i]] && !RESOLVING[ids[i]]) { RESOLVING[ids[i]] = 1; want.push(ids[i]); }
      if (!want.length) return;
      fetch('https://api-v2.soundcloud.com/tracks?ids=' + want.join('%2C') + '&client_id=' + encodeURIComponent(cid), { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (list) {
          (list || []).forEach(function (t) {
            if (!t || !t.id) return;
            RESOLVED[t.id] = {
              uri: t.urn || 'soundcloud:tracks:' + t.id, title: t.title || '',
              artist: (t.user && t.user.username) || '', image: art(t.artwork_url || (t.user && t.user.avatar_url)),
              durationMs: Number(t.duration) || 0,
            };
          });
        })
        .catch(function () { want.forEach(function (id) { delete RESOLVING[id]; }); });
    }

    function control(cmd) {
      var pm = playManager();
      if (!pm) {
        // No player object: click the transport buttons instead.
        var sel = { next: '.skipControl__next', prev: '.skipControl__previous', play: '.playControls__play', pause: '.playControls__play', playpause: '.playControls__play' }[cmd];
        var el = sel && document.querySelector(sel);
        if (!el) return false;
        el.click();
        return true;
      }
      try {
        if (cmd === 'next') pm.playNext({ userInitiated: true });
        else if (cmd === 'prev') pm.playPrev({ userInitiated: true });
        else if (cmd === 'play') pm.playCurrent();
        else if (cmd === 'pause') pm.pauseCurrent();
        else if (cmd === 'playpause') pm.toggleCurrent();
        else return false;
        return true;
      } catch (e) { return false; }
    }

    // A requested song: find it, then put it directly after the current track — the same place
    // SoundCloud's own "Add to Next up" puts it.
    function queueByName(query) {
      var cid = clientId();
      if (!cid) return Promise.resolve({ ok: false, error: 'player_unavailable' });
      return fetch('https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(query) + '&client_id=' + encodeURIComponent(cid) + '&limit=10', { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var items = (j && j.collection) || [];
          var track = null;
          for (var i = 0; i < items.length; i++) {
            var t = items[i];
            // SNIP tracks are the thirty-second previews a subscription unlocks; queueing one would
            // put a stub on the stream instead of the song somebody asked for.
            if (!t || t.streamable === false || t.policy === 'SNIP' || t.policy === 'BLOCK') continue;
            track = t; break;
          }
          if (!track) return { ok: false, error: 'no_match' };
          var pm = playManager(), Model = soundModel();
          if (!pm || !Model) return { ok: false, error: 'player_unavailable' };
          var model = new Model(track);
          var sounds = (typeof model.getSounds === 'function' && model.getSounds()) || [model];
          var sound = sounds[0] || model;
          // createExplicitQueueItem asks the source where the sound sits and what it came from; a
          // one-track source answers both without needing a real playlist behind it.
          var source = {
            getSoundIndex: function () { return 0; },
            getQueueMetadataAt: function () { return { originalModel: model, queryPosition: 0, sourceInfo: {} }; },
          };
          try { pm.addExplicitQueueItem(source, sound, {}); }
          catch (e) { return { ok: false, error: 'queue_failed' }; }
          return { ok: true, added: { name: track.title, artist: (track.user && track.user.username) || '', uri: track.urn || ('soundcloud:tracks:' + track.id), image: art(track.artwork_url || (track.user && track.user.avatar_url)) } };
        })
        .catch(function () { return { ok: false, error: 'network' }; });
    }

    function send(msg) { try { msg[NS + '_page'] = 1; window.postMessage(msg, location.origin); } catch (e) {} }
    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data;
      if (!d || d[NS + '_page'] || !d[NS + '_to_page']) return;
      var m = d[NS + '_to_page'];
      if (m === 'snapshot') { var s = snapshot(); send({ evt: 'snapshot', data: s }); return; }
      if (m === 'cmd') {
        var c = d.cmd || {};
        if (c.type === 'control') return send({ evt: 'ack', id: c.id, result: { ok: control(c.cmd) } });
        if (c.type === 'queue') return queueByName(String(c.query || '')).then(function (r) { send({ evt: 'ack', id: c.id, result: r }); });
        return send({ evt: 'ack', id: c.id, result: { ok: false, error: 'unknown_command' } });
      }
    });
    send({ evt: 'ready' });
    // Its own clock, rather than answering a question the other half asked a moment ago: reading the
    // reply on the next tick meant the very first push carried "nothing playing" and the overlay
    // blinked to its empty state before the real track arrived.
    var lastSnapAt = 0;
    function snap() { var now = Date.now(); if (now - lastSnapAt < 900) return; lastSnapAt = now; try { send({ evt: 'snapshot', data: snapshot() }); } catch (e) {} }
    setInterval(snap, 1000);
    /*
     * A hidden tab gets its timers throttled — after a few minutes in the background Chrome runs
     * them once a minute — and a streamer's SoundCloud tab is hidden for the whole stream. The
     * audio element's own events are not throttled while it plays, so the snapshots ride on them
     * and keep arriving every second whatever the timers do.
     */
    var hooked = [];
    function hookAudio(a) {
      if (!a || hooked.indexOf(a) >= 0) return;
      hooked.push(a);
      ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata'].forEach(function (ev) { a.addEventListener(ev, snap); });
    }
    // SoundCloud's audio element is never attached to the document — it plays a blob: source from a
    // detached <audio> — so there is nothing to query for. Every playback goes through play(), and
    // this runs before the player's own code, so the prototype is where the element is caught.
    try {
      var origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { hookAudio(this); return origPlay.apply(this, arguments); };
    } catch (e) {}
    var stray = document.querySelector('audio, video');
    if (stray) hookAudio(stray);
  }

  // Inject the page half. A userscript sandbox cannot reach the player's own modules, and this is
  // the only way in that survives Tampermonkey's isolation.
  function inject() {
    try {
      var el = document.createElement('script');
      el.textContent = '(' + pageBridge.toString() + ')();';
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return true;
    } catch (e) { return false; }
  }
  var injected = false;
  function ensureInjected() { if (!injected) injected = inject(); }
  if (document.documentElement) ensureInjected();
  document.addEventListener('DOMContentLoaded', ensureInjected);

  // ---- messages back from the page half ----
  /*
   * SoundCloud rebuilds its player between songs and while navigating, so a snapshot can come back
   * empty for a second while music is playing. Reporting that would blink the overlay widget to its
   * empty state and back, which reads as a broken connection. Hold the last track for a few seconds.
   */
  var emptyReads = 0, lastGood = null, loggedOutSince = 0;
  function stable(np) {
    if (np && np.track) { emptyReads = 0; lastGood = np; return np; }
    emptyReads++;
    if (lastGood && emptyReads <= 8) return lastGood;
    lastGood = null;
    return np;
  }
  // The queue goes through the same rebuild as the player bar, so it too comes back empty for a
  // moment now and then. An Up Next widget that empties and refills looks broken on stream.
  var emptyQueues = 0, lastQueue = [];
  function stableQueue(q) {
    if (q && q.length) { emptyQueues = 0; lastQueue = q; return q; }
    emptyQueues++;
    if (lastQueue.length && emptyQueues <= 8) return lastQueue;
    lastQueue = [];
    return q || [];
  }

  var acks = {};
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (!d || !d[NS + '_page']) return;
    if (d.evt === 'ready') { S.player = true; hud(); return; }
    if (d.evt === 'snapshot' && d.data) {
      S.haveSnapshot = true;
      S.np = stable(d.data.nowPlaying || null);
      S.queue = stableQueue(d.data.queue || []);
      S.player = !!d.data.viaPlayer;
      if (d.data.loggedOut) { if (!loggedOutSince) loggedOutSince = Date.now(); } else loggedOutSince = 0;
      S.loggedOut = !!loggedOutSince && Date.now() - loggedOutSince > 5000;
      // the snapshots come on the audio clock in a hidden tab; the push must not wait for a timer
      pushLoop();
      return;
    }
    if (d.evt === 'ack' && d.id && acks[d.id]) { acks[d.id](d.result || { ok: false, error: 'no_result' }); delete acks[d.id]; }
  });
  function askPage(msg) { var m = {}; m[NS + '_to_page'] = msg; window.postMessage(m, location.origin); }
  function runCommand(cmd) {
    return new Promise(function (resolve) {
      var m = {}; m[NS + '_to_page'] = 'cmd'; m.cmd = cmd;
      acks[cmd.id] = resolve;
      window.postMessage(m, location.origin);
      setTimeout(function () { if (acks[cmd.id]) { acks[cmd.id]({ ok: false, error: 'timeout' }); delete acks[cmd.id]; } }, 12000);
    });
  }

  // ---- TokElements comms over GM_xmlhttpRequest (CSP-safe) ----
  function te(method, path, body) {
    return new Promise(function (resolve) {
      if (!S.teUrl || !S.pairCode) return resolve(null);
      GM_xmlhttpRequest({
        method: method, url: S.teUrl + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'code=' + encodeURIComponent(S.pairCode),
        headers: { 'content-type': 'application/json' }, data: body ? JSON.stringify(body) : undefined,
        onload: function (r) { S.online = r.status >= 200 && r.status < 500; try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); } catch (e) { resolve({}); } },
        onerror: function () { S.online = false; resolve(null); },
      });
    });
  }

  // Push on change, plus a heartbeat every ~10s so TokElements keeps the link marked connected
  // through pauses and between songs. Called by the timer and by every snapshot that arrives.
  var lastKey = '', lastSentAt = 0;
  function pushLoop() {
    ensureInjected();
    // Nothing is sent until the page half has answered once: an empty first push would tell the
    // overlay that nothing is playing before we have even looked.
    if (!S.haveSnapshot) { askPage('snapshot'); hud(); return; }
    var np = S.np;
    var key = JSON.stringify([np && np.track, np && np.artist, np && np.playing, Math.round(((np && np.positionMs) || 0) / 3000), S.loggedOut, S.queue.map(function (q) { return q.uri; })]);
    var now = Date.now();
    // The server keeps a pushed track for two minutes; ten seconds survives a few failed requests
    // and a throttled tab. Never more often than every two seconds, whatever fires this.
    if (now - lastSentAt < 2000 && key === lastKey) return;
    if (key !== lastKey || now - lastSentAt > 10000) {
      lastKey = key; lastSentAt = now;
      te('POST', '/api/soundcloud/agent/state', { nowPlaying: np, queue: S.queue, premium: null, loggedOut: S.loggedOut, connected: true })
        .then(function (r) { if (r) S.lastPushOk = Date.now(); });
    }
    hud();
  }
  function pollLoop() {
    te('GET', '/api/soundcloud/agent/commands').then(function (r) {
      if (!r || !r.commands) return;
      r.commands.forEach(function (c) {
        runCommand({ id: c.id, type: c.type, cmd: c.cmd, query: c.query }).then(function (result) {
          S.lastResult = { at: Date.now(), type: c.type, ok: !!(result && result.ok), error: result && result.error, added: result && result.added };
          hud();
          te('POST', '/api/soundcloud/agent/ack', Object.assign({ id: c.id }, result || {}));
        });
      });
    });
  }
  setInterval(pushLoop, 1000);
  setInterval(pollLoop, 2000);

  // ---- pairing menu (for another browser / another computer) + reset ----
  GM_registerMenuCommand('TokElements: set URL', function () { var v = prompt('TokElements URL', S.teUrl || 'https://tokelements.com'); if (v != null) { S.teUrl = v.trim().replace(/\/$/, ''); GM_setValue('teUrl', S.teUrl); hud(); } });
  GM_registerMenuCommand('TokElements: set pairing code', function () { var v = prompt('Pairing code (from the TokElements SoundCloud page)', S.pairCode || ''); if (v != null) { S.pairCode = v.trim(); GM_setValue('pairCode', S.pairCode); hud(); } });
  GM_registerMenuCommand('TokElements: check for updates', function () { window.open('https://raw.githubusercontent.com/tokelements/tokelements-soundcloud/main/tokelements-soundcloud.user.js', '_blank'); });
  GM_registerMenuCommand('TokElements: reset / unpair', function () { S.pairCode = ''; GM_deleteValue('pairCode'); hud(); });

  // ---- status panel, so a streamer can see what is happening without opening a console ----
  var hudEl = null;
  function hud() {
    if (!document.body) return;
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.style.cssText = 'position:fixed;z-index:99999;right:12px;bottom:96px;max-width:280px;min-width:212px;background:#121212f0;color:#fff;font:12px/1.45 system-ui,sans-serif;padding:10px 12px;border-radius:12px;box-shadow:0 8px 28px #0009;border:1px solid #ff550055';
      document.body.appendChild(hudEl);
    }
    var dot = '#f0c674', label, sub = '';
    if (!S.teUrl || !S.pairCode) { dot = '#888'; label = 'Not paired'; sub = 'Open TokElements → “Connect in this browser”, or menu → set code'; }
    else if (S.online === false) { dot = '#e05555'; label = 'TokElements unreachable'; sub = 'Check the URL in the Tampermonkey menu'; }
    else if (S.loggedOut) { dot = '#e05555'; label = 'Not signed in to SoundCloud'; sub = 'Log in on this tab — nothing can play or be queued until you do'; }
    else if (!S.np || !S.np.track) { dot = '#f0c674'; label = 'Linked · waiting for a song'; sub = 'Play a track in this SoundCloud tab'; }
    else { dot = '#FF5500'; label = '♪ ' + String(S.np.track).slice(0, 34); sub = (S.np.playing ? 'Playing' : 'Paused') + (S.player ? '' : ' · player not reachable, requests off') + ' · sending to TokElements'; }
    var line = '';
    if (S.lastResult && Date.now() - S.lastResult.at < 30000) {
      var r = S.lastResult;
      var what = r.type === 'control' ? (r.ok ? 'Skipped' : 'Skip failed') : r.ok ? ('Queued: ' + String((r.added && r.added.name) || 'track').slice(0, 28)) : ('Request failed: ' + (r.error || 'unknown'));
      line = '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ffffff1a;font-size:11px;color:' + (r.ok ? '#8fdba4' : '#ff9aa2') + '">' + what + '</div>';
    }
    hudEl.innerHTML =
      '<div style="display:flex;align-items:center;gap:7px;font-weight:700">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + dot + ';box-shadow:0 0 8px ' + dot + '"></span>' +
      '<span style="color:#FF5500">TokElements</span><span style="opacity:.85">· ' + label + '</span></div>' +
      (sub ? '<div style="margin-top:4px;opacity:.6;font-size:11px">' + sub + '</div>' : '') + line;
  }
  hud();
})();
