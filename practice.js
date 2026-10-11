'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const HAND = { L: '#5aa9ff', R: '#8fd14f' };
  const HAND_DIM = { L: 'rgba(90,169,255,0.30)', R: 'rgba(143,209,79,0.30)' };
  const GOLD = '#ffd166', RED = '#ff4d6d';
  const synth = new PianoSynth();

  // ---------- storage ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(k) {
      if (hasChrome) return (await chrome.storage.local.get(k))[k];
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch (e) { return undefined; }
    },
    async set(k, v) {
      if (hasChrome) return chrome.storage.local.set({ [k]: v });
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ }
    },
    async remove(k) {
      if (hasChrome) return chrome.storage.local.remove(k);
      try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ }
    },
  };
  const prefs = (() => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('pp-prefs') || '{}'); } catch (e) { /* ignore */ }
    return {
      get: (k, d) => (p[k] === undefined ? d : p[k]),
      set: (k, v) => { p[k] = v; try { localStorage.setItem('pp-prefs', JSON.stringify(p)); } catch (e) { /* ignore */ } },
    };
  })();

  // ---------- state ----------
  const S = {
    song: null, notes: [], t: 0, playing: false, waiting: null,
    speed: prefs.get('speed', 1), mode: prefs.get('mode', 'wait'), hands: prefs.get('hands', 'both'),
    labels: prefs.get('labels', true), mySound: prefs.get('mySound', false),
    loopA: null, loopB: null, loopPass: 0, octave: 0, transpose: 0, lookahead: 3,
    fingerHelp: prefs.get('fingerHelp', 'auto'), view: prefs.get('view', 'notes'), mastered: false, key: null, waitSince: 0,
    startT: 0, endT: 0, duration: 0,
    score: null,
    pressed: new Map(), // pitch -> { kind: 'good'|'wrong'|'neutral', hand }
    fx: [], texts: [],
    kbOct: 0, midiNames: [],
  };
  const resetScore = () => { S.score = { points: 0, hits: 0, clean: 0, perfect: 0, misses: 0, wrong: 0, streak: 0, bestStreak: 0 }; };
  resetScore();

  const pitch = n => n.m + 12 * S.octave + S.transpose;
  const practiced = n => S.mode !== 'watch' && (S.hands === 'both' || n.h === S.hands);
  const hitWin = () => 0.2 * S.speed;     // 200 ms of real time, in song seconds
  const perfectWin = () => 0.07 * S.speed;
  const mult = () => 1 + Math.min(3, Math.floor(S.score.streak / 10));
  const judged = () => S.score.hits + S.score.misses;
  const accuracy = () => {
    const j = judged();
    if (!j) return null;
    return S.mode === 'wait' ? S.score.clean / j : S.score.hits / j;
  };

  // ---------- fingers & key ----------
  function refinger() {
    const tmp = S.notes.map(n => ({ p: pitch(n), on: n.on, off: n.off, h: n.h, src: n }));
    PianoFingering.assign(tmp);
    for (const t of tmp) { t.src.f = t.finger; t.src.shift = t.shift; }
  }
  // Finger numbers on every falling note, or only as a hint when you get stuck.
  const fingersOnNotes = () => S.fingerHelp === 'always' || (S.fingerHelp === 'auto' && !S.mastered);
  const fingerHints = () => S.fingerHelp !== 'off';
  async function checkMastered() {
    const best = (await store.get('best:' + S.song.id)) || {};
    S.mastered = Object.entries(best).some(([k, b]) => k.endsWith(':' + S.hands) && b.acc >= 0.9 && k.split(':')[0] !== 'watch');
    updateHint();
  }
  // Spell black keys as flats in flat keys (F, B♭, E♭, A♭, D♭, G♭ major and their minors), sharps otherwise.
  function useFlats() {
    if (!S.key) return false;
    const major = (S.key.tonic + S.transpose + (S.key.minor ? 3 : 0)) % 12;
    return [5, 10, 3, 8, 1, 6].includes((major + 12) % 12);
  }
  function setView(v) {
    S.view = v; prefs.set('view', v);
    syncControls();
  }

  function saveSongPrefs() {
    if (S.song) prefs.set('song:' + S.song.id, { tr: S.transpose, oct: S.octave });
  }
  function setTranspose(v) {
    S.transpose = Math.max(-11, Math.min(11, v));
    saveSongPrefs();
    synth.allOff();
    refinger();
    layoutDirty = true;
    syncControls();
  }

  // ---------- routing ----------
  async function route() {
    const raw = location.hash.slice(1);
    if (raw.startsWith('import=')) {
      try {
        const song = await SongShare.decode(raw.slice(7));
        if (song.id !== 'demo') await saveSong(song);
        toast(`Added “${song.title}”`);
        location.replace('#' + encodeURIComponent(song.id));
        return;
      } catch (e) {
        alert('That song link is damaged or incomplete. Try sending it again.');
        location.replace('#');
        return;
      }
    }
    const id = decodeURIComponent(raw);
    if (!id) return showLibrary();
    const song = id === 'demo' ? DEMO_SONG : await store.get('song:' + id);
    if (!song) return showLibrary();
    openSong(song);
  }
  window.addEventListener('hashchange', route);

  // ---------- library ----------
  async function saveSong(song) {
    await store.set('song:' + song.id, song);
    const index = ((await store.get('songIndex')) || []).filter(e => e.id !== song.id);
    const duration = song.duration || (song.notes.length ? song.notes[song.notes.length - 1].off + 1 : 0);
    await store.set('songIndex', [{ id: song.id, title: song.title, url: song.url, createdAt: song.createdAt || Date.now(), duration, noteCount: song.notes.length }, ...index]);
  }

  // The address of the practice page on the web (set up once, see the iPad guide).
  const siteUrl = () => {
    const saved = prefs.get('siteUrl', '');
    if (saved) return saved;
    if (/^https?:$/.test(location.protocol) && !/^(localhost|127\.)/.test(location.hostname)) return location.origin + location.pathname;
    return '';
  };

  async function sendToIpad(id) {
    const song = id === 'demo' ? DEMO_SONG : await store.get('song:' + id);
    if (!song) return;
    let base = siteUrl();
    if (!base) {
      $('siteUrl').focus();
      $('siteBox').classList.add('attention');
      alert('First paste your iPad page address into “iPad page address” at the bottom of this page (see the iPad guide).');
      return;
    }
    const link = base.replace(/#.*$/, '') + '#import=' + (await SongShare.encode(song));
    try {
      if (navigator.share) { await navigator.share({ title: song.title, text: 'Piano practice: ' + song.title, url: link }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(link); } catch (e) { /* shown below */ }
    $('shareLink').value = link;
    $('shareBox').hidden = false;
  }

  function downloadSong(song) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(SongShare.toFile(song));
    a.download = song.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) + '.piano.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const starText = n => '★'.repeat(n) + '☆'.repeat(3 - n);

  async function showLibrary() {
    pause();
    $('player').hidden = true;
    $('library').hidden = false;
    document.title = 'Piano Practice';
    const index = (await store.get('songIndex')) || [];
    const items = [...index, { id: 'demo', title: DEMO_SONG.title, duration: DEMO_SONG.duration, noteCount: DEMO_SONG.notes.length, demo: true }];
    const list = $('songList');
    list.textContent = '';
    if (!index.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No scanned songs yet. Try the demo below, or scan a video on YouTube.';
      list.appendChild(e);
    }
    for (const it of items) {
      const best = (await store.get('best:' + it.id)) || {};
      const topStars = Math.max(0, ...Object.values(best).map(b => b.stars || 0));
      const row = document.createElement('div');
      row.className = 'song';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div'); name.className = 'name'; name.textContent = it.title;
      const sub = document.createElement('div'); sub.className = 'sub';
      sub.textContent = `${fmtTime(it.duration || 0)} · ${it.noteCount} notes` + (it.url ? ' · from YouTube' : it.demo ? ' · built in' : ' · MIDI file');
      meta.append(name, sub);
      if (Object.keys(best).length) { const b = document.createElement('div'); b.className = 'best'; b.textContent = 'Best: ' + starText(topStars); meta.appendChild(b); }
      const actions = document.createElement('div'); actions.className = 'actions';
      const play = document.createElement('button'); play.className = 'btn primary'; play.textContent = 'Practise';
      play.onclick = () => { location.hash = encodeURIComponent(it.id); };
      actions.appendChild(play);
      if (it.url) { const yt = document.createElement('a'); yt.className = 'btn'; yt.textContent = 'Video'; yt.href = it.url; yt.target = '_blank'; yt.rel = 'noopener'; actions.appendChild(yt); }
      const send = document.createElement('button'); send.className = 'btn'; send.textContent = 'Send to iPad';
      send.title = 'Make a link that adds this song on another device';
      send.onclick = () => sendToIpad(it.id);
      actions.appendChild(send);
      const file = document.createElement('button'); file.className = 'btn'; file.textContent = 'Save file';
      file.title = 'Download this song as a file (open it on the iPad with “Import song file”)';
      file.onclick = async () => downloadSong(it.demo ? DEMO_SONG : await store.get('song:' + it.id));
      actions.appendChild(file);
      if (!it.demo) {
        const del = document.createElement('button'); del.className = 'btn danger'; del.textContent = 'Delete';
        del.onclick = async () => {
          if (!confirm(`Delete “${it.title}” from your library?`)) return;
          await store.remove('song:' + it.id);
          await store.remove('best:' + it.id);
          await store.set('songIndex', ((await store.get('songIndex')) || []).filter(e => e.id !== it.id));
          showLibrary();
        };
        actions.appendChild(del);
      }
      row.append(meta, actions);
      list.appendChild(row);
    }
  }

  $('importMidi').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let song;
      if (/\.json$/i.test(file.name)) {
        song = SongShare.fromFileText(await file.text());
      } else {
        const notes = parseMidiFile(await file.arrayBuffer());
        if (!notes.length) throw new Error('No notes in that file.');
        song = { id: 'mid_' + Date.now(), title: file.name.replace(/\.midi?$/i, ''), source: 'midi', createdAt: Date.now(), duration: notes[notes.length - 1].off + 1, notes };
      }
      await saveSong(song);
      location.hash = encodeURIComponent(song.id);
    } catch (err) {
      alert('Could not read that file: ' + err.message);
    }
  });

  $('pasteLink').onclick = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* not allowed: ask instead */ }
    if (!/import=/.test(text)) text = prompt('Paste the song link here:') || '';
    const m = text.match(/import=([A-Za-z0-9_-]+)/);
    if (!m) { if (text) alert('That doesn’t look like a song link.'); return; }
    location.hash = 'import=' + m[1];
  };
  $('siteUrl').value = prefs.get('siteUrl', '');
  $('siteUrl').onchange = e => {
    let v = e.target.value.trim();
    if (v && !/^https?:\/\//.test(v)) v = 'https://' + v;
    prefs.set('siteUrl', v);
    e.target.value = v;
    $('siteBox').classList.remove('attention');
  };
  $('shareCopy').onclick = async () => {
    $('shareLink').select();
    try { await navigator.clipboard.writeText($('shareLink').value); } catch (e) { document.execCommand('copy'); }
    $('shareCopy').textContent = 'Copied ✓';
    setTimeout(() => { $('shareCopy').textContent = 'Copy'; }, 1500);
  };
  $('shareClose').onclick = () => { $('shareBox').hidden = true; };

  // ---------- song setup ----------
  function openSong(song) {
    $('library').hidden = true;
    $('player').hidden = false;
    S.song = song;
    S.notes = song.notes.map((n, i) => ({ m: n.m, on: n.on, off: n.off, h: n.h === 'L' ? 'L' : 'R', i, st: 'pending', played: false }));
    S.duration = song.duration || (S.notes.length ? S.notes[S.notes.length - 1].off + 1 : 10);
    const first = S.notes.length ? S.notes[0].on : 0;
    S.startT = first - S.lookahead * 0.85;
    S.endT = S.notes.reduce((mx, n) => Math.max(mx, n.off), 0) + 0.8;
    S.loopA = S.loopB = null;
    const sp = prefs.get('song:' + song.id, {});
    S.octave = sp.oct || 0;
    S.transpose = sp.tr || 0;
    S.key = PianoFingering.estimateKey(S.notes.map(n => ({ p: n.m, on: n.on, off: n.off })));
    refinger();
    S.mastered = false;
    checkMastered();
    $('songTitle').textContent = song.title;
    document.title = song.title + ' · Piano Practice';
    layoutDirty = true;
    syncControls();
    restart(false);
  }

  function restart(autoplay) {
    resetScore();
    S.loopPass = 0;
    hideResults();
    seek(S.loopA != null ? S.loopA - 1.5 : S.startT);
    if (autoplay) play();
  }

  function seek(t) {
    S.t = Math.max(S.startT, Math.min(t, S.endT));
    S.waiting = null;
    for (const n of S.notes) {
      if (n.on >= S.t - 0.001) { n.st = 'pending'; n.struggled = false; n.played = false; n.hitAt = 0; }
      else { if (n.st === 'pending') n.st = 'skip'; n.played = true; }
    }
    synth.allOff();
  }

  function play() {
    if (!S.song) return;
    synth.ensure();
    if (S.t >= S.endT - 0.01) restart(false);
    S.playing = true;
    lastFrame = performance.now();
    $('playBtn').textContent = '❚❚';
  }
  function pause() {
    S.playing = false;
    $('playBtn').textContent = '▶';
  }
  const toggle = () => (S.playing ? pause() : play());

  // ---------- game clock ----------
  function nextPendingPracticed() {
    let best = null;
    for (const n of S.notes) {
      if (n.st !== 'pending' || !practiced(n)) continue;
      if (!best || n.on < best.on) best = n;
      else if (n.on > best.on + 1) break; // notes are sorted by onset
    }
    return best;
  }

  function update(dtReal) {
    if (!S.playing) return;
    const prevT = S.t;
    let target = S.t + dtReal * S.speed;

    if (S.mode === 'wait') {
      const next = nextPendingPracticed();
      if (next && target >= next.on) {
        target = Math.max(prevT, next.on - 0.0005);
        if (!S.waiting) S.waitSince = performance.now();
        S.waiting = S.notes.filter(n => n.st === 'pending' && practiced(n) && n.on <= next.on + 0.06);
      } else {
        S.waiting = null;
      }
    } else {
      S.waiting = null;
    }

    // Accompaniment: everything the player isn't playing.
    for (const n of S.notes) {
      if (n.played || n.on > target) continue;
      if (n.on > prevT - 0.05) {
        n.played = true;
        if (!practiced(n)) {
          const dur = Math.max(0.1, (n.off - n.on) / S.speed);
          synth.play(pitch(n), dur, S.mode === 'watch' ? 0.75 : 0.55);
          synthUntil.set(pitch(n), performance.now() + dur * 1000 + 400);
        }
      } else n.played = true;
    }

    // Play mode: notes that slid past the line unplayed turn red.
    if (S.mode === 'play') {
      const w = hitWin();
      for (const n of S.notes) {
        if (n.on > target) break;
        if (n.st === 'pending' && practiced(n) && n.on < target - w) {
          n.st = 'miss';
          S.score.misses++;
          S.score.streak = 0;
          floatText('Miss', pitch(n), RED);
        }
      }
    }

    S.t = target;

    if (S.loopA != null && S.loopB != null && S.t >= S.loopB) {
      loopWrap();
    } else if (S.t >= S.endT) {
      finish();
    }
  }

  function loopWrap() {
    S.loopPass++;
    const inLoop = S.notes.filter(n => practiced(n) && n.on >= S.loopA && n.on < S.loopB);
    if (inLoop.length && S.mode !== 'watch') {
      const good = inLoop.filter(n => n.st === 'hit' && (S.mode !== 'wait' || !n.struggled)).length;
      const pct = Math.round((good / inLoop.length) * 100);
      toast(`Loop ${S.loopPass}: ${pct}%${pct === 100 ? ' 🎉 perfect!' : pct >= 90 ? ' — great!' : ''}`);
    }
    seek(S.loopA - 1.5);
  }

  // ---------- input ----------
  function noteOn(p, vel = 0.8) {
    if (S.mySound) synth.noteOn(p, vel);
    if (!S.song || $('player').hidden) return;
    if (!S.playing) {
      // A key press while paused just starts the music; it isn't judged.
      S.pressed.set(p, { kind: 'neutral' });
      if ($('results').hidden) play();
      return;
    }
    if (S.mode === 'watch') { S.pressed.set(p, { kind: 'neutral' }); return; }

    const w = hitWin();
    const early = S.mode === 'wait' ? Math.max(0.3, w) : w;
    let cand = null;
    for (const n of S.notes) {
      if (n.on > S.t + early) break;
      if (n.st !== 'pending' || !practiced(n) || pitch(n) !== p) continue;
      if (n.on < S.t - w) continue;
      if (!cand || Math.abs(n.on - S.t) < Math.abs(cand.on - S.t)) cand = n;
    }
    if (cand) { hit(cand); S.pressed.set(p, { kind: 'good', hand: cand.h }); return; }

    // Not a target. Playing along with a note that is sounding anyway is not a mistake.
    const harmless = S.notes.some(n => pitch(n) === p && n.on - 0.35 <= S.t && S.t <= n.off + 0.25);
    if (harmless) { S.pressed.set(p, { kind: 'neutral' }); return; }

    S.pressed.set(p, { kind: 'wrong' });
    S.score.wrong++;
    S.score.streak = 0;
    if (S.waiting) S.waiting.forEach(n => { n.struggled = true; });
  }

  function noteOff(p) {
    S.pressed.delete(p);
    if (S.mySound) synth.noteOff(p);
  }

  function hit(n) {
    const delta = S.t - n.on;
    n.st = 'hit';
    n.hitAt = performance.now();
    const sc = S.score;
    sc.hits++;
    let pts, label;
    if (S.mode === 'wait') {
      if (!n.struggled) { sc.clean++; pts = 100; label = 'Nice'; } else { pts = 40; label = 'OK'; }
    } else if (Math.abs(delta) <= perfectWin()) { sc.perfect++; pts = 100; label = 'Perfect'; }
    else { pts = 60; label = delta < 0 ? 'Early' : 'Late'; }
    sc.streak++;
    sc.bestStreak = Math.max(sc.bestStreak, sc.streak);
    sc.points += pts * mult();
    floatText(label, pitch(n), label === 'Perfect' || label === 'Nice' ? GOLD : '#cfd6e4');
    burst(pitch(n), HAND[n.h]);
    if (sc.streak > 0 && sc.streak % 25 === 0) toast(`🔥 ${sc.streak} in a row!`);
  }

  // ---------- microphone ----------
  const synthUntil = new Map(); // pitch -> time the computer's own note stops ringing
  const mic = new MicListener({
    onNote: (m, vel) => { noteOn(m, vel); setTimeout(() => S.pressed.delete(m), 180); },
    // Listen only for the notes the song expects right now (plus the next few when paused).
    getCandidates: () => {
      const c = new Set();
      if (!S.song || S.mode === 'watch') return c;
      const early = S.mode === 'wait' ? 0.6 : hitWin() + 0.1;
      let first = null;
      for (const n of S.notes) {
        if (n.st !== 'pending' || !practiced(n) || n.on < S.t - hitWin()) continue;
        if (first == null) first = n.on;
        // While paused, listen for the very next chord so playing it starts the song.
        if (n.on > (S.playing ? S.t + early : first + 0.06)) break;
        c.add(pitch(n));
      }
      return c;
    },
    isSynthPlaying: m => {
      const now = performance.now();
      return [0, 12, 19, 24].some(d => (synthUntil.get(m - d) || 0) > now);
    },
  });
  mic.sensitivity = prefs.get('micSens', 0.5);
  async function toggleMic() {
    if (mic.active) { mic.stop(); prefs.set('mic', false); }
    else {
      try {
        await mic.start(synth.ensure());
        prefs.set('mic', true);
        toast('Listening. Play your piano near the microphone.');
      } catch (e) {
        toast('Microphone not allowed. Check your browser settings.');
      }
    }
    syncInput();
  }
  function syncInput() {
    $('micBtn').classList.toggle('set', mic.active);
    $('micBtn').textContent = mic.active ? '🎤 Listening' : '🎤 Microphone';
    $('micSensWrap').hidden = !mic.active;
    updateHint();
  }
  $('micBtn').onclick = toggleMic;
  $('micSens').value = Math.round(mic.sensitivity * 100);
  $('micSens').oninput = e => { mic.sensitivity = e.target.value / 100; prefs.set('micSens', mic.sensitivity); };

  // Web MIDI
  function setupMidi() {
    if (!navigator.requestMIDIAccess) {
      S.midiNames = [];
      setPill(false, 'No MIDI in this browser · use the microphone');
      updateHint();
      return;
    }
    navigator.requestMIDIAccess().then(access => {
      const bind = () => {
        const names = [];
        access.inputs.forEach(inp => { inp.onmidimessage = onMidi; names.push(inp.name); });
        S.midiNames = names;
        setPill(names.length > 0, names.length ? '🎹 ' + names.join(', ') : 'No keyboard connected');
        updateHint();
      };
      bind();
      access.onstatechange = bind;
    }).catch(() => setPill(false, 'MIDI not allowed · click to retry'));
  }
  $('midiPill').onclick = setupMidi;
  function onMidi(e) {
    const [st, d1, d2] = e.data;
    const cmd = st & 0xf0;
    if (cmd === 0x90 && d2 > 0) noteOn(d1, d2 / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  }
  function setPill(on, text) {
    const p = $('midiPill');
    p.textContent = text;
    p.classList.toggle('on', on);
  }

  // Computer keyboard as a fallback piano: A W S E D F T G Y H U J K O L P ; '
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
  const heldKeys = new Map();
  document.addEventListener('keydown', e => {
    if (e.target.closest('input[type=text], textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('player').hidden) return;
    const k = e.key.toLowerCase();
    if (k in KEYMAP) {
      e.preventDefault();
      if (e.repeat || heldKeys.has(k)) return;
      const p = 60 + 12 * S.kbOct + KEYMAP[k];
      heldKeys.set(k, p);
      noteOn(p, 0.8);
      return;
    }
    switch (e.key) {
      case ' ': e.preventDefault(); toggle(); break;
      case 'r': case 'R': restart(false); break;
      case 'ArrowLeft': e.preventDefault(); seek(S.t - 3); break;
      case 'ArrowRight': e.preventDefault(); seek(S.t + 3); break;
      case 'ArrowUp': e.preventDefault(); setSpeed(S.speed + 0.05); break;
      case 'ArrowDown': e.preventDefault(); setSpeed(S.speed - 0.05); break;
      case '[': setLoopA(); break;
      case ']': setLoopB(); break;
      case '\\': clearLoop(); break;
      case '1': setMode('wait'); break;
      case '2': setMode('play'); break;
      case '3': setMode('watch'); break;
      case 'v': case 'V': setView(S.view === 'staff' ? 'notes' : 'staff'); break;
      case 'n': case 'N': {
        const order = ['always', 'auto', 'off'];
        S.fingerHelp = order[(order.indexOf(S.fingerHelp) + 1) % 3];
        prefs.set('fingerHelp', S.fingerHelp);
        syncControls();
        toast({ always: 'Finger numbers: always', auto: 'Finger numbers: until you master it', off: 'Finger numbers: off' }[S.fingerHelp]);
        break;
      }
      case 'z': case 'Z': S.kbOct = Math.max(-3, S.kbOct - 1); toast(`Computer keys start at C${4 + S.kbOct}`); break;
      case 'x': case 'X': S.kbOct = Math.min(3, S.kbOct + 1); toast(`Computer keys start at C${4 + S.kbOct}`); break;
      default: break;
    }
  });
  document.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (heldKeys.has(k)) { noteOff(heldKeys.get(k)); heldKeys.delete(k); }
  });

  // ---------- controls ----------
  function setMode(m) {
    S.mode = m; prefs.set('mode', m);
    resetScore();
    seek(S.t);
    syncControls();
  }
  function setHands(h) {
    S.hands = h; prefs.set('hands', h);
    if (S.song) checkMastered();
    resetScore();
    seek(S.t);
    syncControls();
  }
  function setSpeed(v) {
    S.speed = Math.max(0.25, Math.min(1.5, Math.round(v * 20) / 20));
    prefs.set('speed', S.speed);
    syncControls();
  }
  function setLoopA() {
    S.loopA = Math.max(0, S.t);
    if (S.loopB != null && S.loopB <= S.loopA) S.loopB = null;
    toast('Loop start set');
    syncControls();
  }
  function setLoopB() {
    if (S.loopA == null) S.loopA = Math.max(0, S.t - 8);
    if (S.t <= S.loopA + 0.5) { toast('Move past the loop start first'); return; }
    S.loopB = S.t;
    S.loopPass = 0;
    toast('Looping this section');
    seek(S.loopA - 1.5);
    syncControls();
  }
  function clearLoop() { S.loopA = S.loopB = null; toast('Loop cleared'); syncControls(); }

  function syncControls() {
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.mode));
    document.querySelectorAll('#handSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.hands));
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
    $('stage').classList.toggle('paper', S.view === 'staff');
    $('speed').value = Math.round(S.speed * 100);
    $('speedVal').textContent = Math.round(S.speed * 100) + '%';
    $('octVal').textContent = (S.octave > 0 ? '+' : '') + S.octave;
    $('trVal').textContent = (S.transpose > 0 ? '+' : '') + S.transpose;
    if (S.key) {
      const from = PianoFingering.keyName(S.key), to = PianoFingering.keyName(S.key, S.transpose);
      $('keyName').textContent = S.transpose ? `${from} → ${to}` : from;
    }
    $('fingerSel').value = S.fingerHelp;
    $('labelsChk').checked = S.labels;
    $('mySoundChk').checked = S.mySound;
    $('loopA').classList.toggle('set', S.loopA != null);
    $('loopB').classList.toggle('set', S.loopB != null);
    updateHint();
  }
  function updateHint() {
    const h = {
      wait: 'Learn: the music waits for you. Play the glowing keys.',
      play: 'Play: keep up with the music. Notes you miss turn red.',
      watch: 'Watch: listen to the whole song first.',
    }[S.mode];
    const touch = matchMedia('(pointer: coarse)').matches;
    const noKb = S.midiNames && S.midiNames.length === 0 && !mic.active
      ? (touch || !navigator.requestMIDIAccess
        ? ' Tap 🎤 Microphone to listen to your piano, or tap the keys on screen.'
        : ' No keyboard? Use the computer keys A–; (tick “My notes sound”) or 🎤 Microphone.')
      : '';
    const fing = S.fingerHelp === 'auto' && S.mastered ? ' You know this one: finger numbers now only appear if you get stuck.' : '';
    $('hint').textContent = h + fing + noKb;
  }

  $('playBtn').onclick = toggle;
  $('restartBtn').onclick = () => restart(false);
  $('backBtn').onclick = () => { location.hash = ''; };
  document.querySelectorAll('#modeSeg button').forEach(b => { b.onclick = () => setMode(b.dataset.v); });
  document.querySelectorAll('#handSeg button').forEach(b => { b.onclick = () => setHands(b.dataset.v); });
  document.querySelectorAll('#viewSeg button').forEach(b => { b.onclick = () => setView(b.dataset.v); });
  $('speed').oninput = e => setSpeed(e.target.value / 100);
  $('loopA').onclick = setLoopA;
  $('loopB').onclick = setLoopB;
  $('loopClear').onclick = clearLoop;
  $('octDown').onclick = () => { S.octave = Math.max(-3, S.octave - 1); saveSongPrefs(); refinger(); layoutDirty = true; syncControls(); };
  $('octUp').onclick = () => { S.octave = Math.min(3, S.octave + 1); saveSongPrefs(); refinger(); layoutDirty = true; syncControls(); };
  $('trDown').onclick = () => setTranspose(S.transpose - 1);
  $('trUp').onclick = () => setTranspose(S.transpose + 1);
  $('trEasy').onclick = () => {
    const shift = PianoFingering.easiestShift(S.notes.map(n => ({ p: n.m + 12 * S.octave })));
    setTranspose(shift);
    toast(shift === 0 ? 'Already in the easiest key' : `Moved to ${PianoFingering.keyName(S.key, shift)} (fewest black keys)`);
  };
  $('fingerSel').onchange = e => { S.fingerHelp = e.target.value; prefs.set('fingerHelp', S.fingerHelp); updateHint(); };
  $('labelsChk').onchange = e => { S.labels = e.target.checked; prefs.set('labels', S.labels); };
  $('mySoundChk').onchange = e => { S.mySound = e.target.checked; prefs.set('mySound', S.mySound); if (S.mySound) synth.ensure(); };
  // Controls drop focus after use so Space and the arrow keys always reach the game.
  document.addEventListener('pointerup', () => setTimeout(() => {
    const a = document.activeElement;
    if (a && a.matches('#player button, #player input')) a.blur();
  }));

  // Timeline: click or drag to seek.
  (() => {
    const tl = $('timeline');
    let dragging = false;
    const at = e => {
      const r = tl.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      seek(f * S.duration);
    };
    tl.addEventListener('pointerdown', e => { dragging = true; tl.setPointerCapture(e.pointerId); at(e); });
    tl.addEventListener('pointermove', e => { if (dragging) at(e); });
    tl.addEventListener('pointerup', () => { dragging = false; });
  })();

  // ---------- results ----------
  async function finish() {
    pause();
    S.t = S.endT;
    if (S.mode === 'watch' || !judged()) { restart(false); return; }
    const acc = accuracy();
    const stars = acc >= 0.95 ? 3 : acc >= 0.8 ? 2 : acc >= 0.6 ? 1 : 0;
    $('resStars').innerHTML = '★'.repeat(stars) + `<span class="off">${'★'.repeat(3 - stars)}</span>`;
    $('resTitle').textContent = stars === 3 ? 'Amazing!' : stars === 2 ? 'Great playing!' : stars === 1 ? 'Nice work!' : 'Keep practising!';
    $('resAcc').textContent = Math.round(acc * 100) + '%';
    $('resPoints').textContent = S.score.points.toLocaleString();
    $('resStreak').textContent = S.score.bestStreak;
    $('resMiss').textContent = S.mode === 'wait' ? S.score.wrong : S.score.misses;
    $('resMiss').nextElementSibling.textContent = S.mode === 'wait' ? 'wrong keys' : 'missed';
    const key = `${S.mode}:${S.hands}`;
    const best = (await store.get('best:' + S.song.id)) || {};
    const prev = best[key];
    const mine = { acc, points: S.score.points, stars, speed: S.speed, date: Date.now() };
    const better = !prev || stars > prev.stars || (stars === prev.stars && acc > prev.acc + 1e-9);
    if (better) { best[key] = mine; await store.set('best:' + S.song.id, best); }
    $('resBest').textContent = !prev ? '🏆 First score saved. Beat it next time!' : better ? '🏆 New personal best!' : `Your best: ${Math.round(prev.acc * 100)}% at ${Math.round(prev.speed * 100)}% speed`;
    $('results').hidden = false;
  }
  function hideResults() { $('results').hidden = true; }
  $('resAgain').onclick = () => restart(true);
  $('resSlower').onclick = () => { setSpeed(S.speed - 0.2); restart(true); };
  $('resClose').onclick = () => { hideResults(); restart(false); };

  // ---------- feedback ----------
  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }
  function floatText(text, p, color) { S.texts.push({ text, p, color, born: performance.now() }); }
  function burst(p, color) {
    for (let i = 0; i < 14; i++) {
      const a = Math.PI * (1 + Math.random());
      const v = 120 + Math.random() * 220;
      S.fx.push({ p, vx: Math.cos(a) * v * 0.6, vy: Math.sin(a) * v, life: 0, max: 0.5 + Math.random() * 0.4, color: Math.random() < 0.5 ? GOLD : color });
    }
  }

  // ---------- drawing ----------
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let lastKb = { hitY: 0, kbH: 0 };
  let layoutDirty = true, keyPos = new Map(), whiteW = 10, blackW = 6, lastW = 0, lo = 48, hi = 84;

  function layoutKeys(W) {
    let mn = 60, mx = 72;
    if (S.notes.length) {
      mn = Math.min(...S.notes.map(pitch));
      mx = Math.max(...S.notes.map(pitch));
    }
    lo = mn - (((mn % 12) + 12) % 12);          // down to a C
    hi = mx + (11 - (((mx % 12) + 12) % 12));   // up to a B
    while (hi - lo < 35) { lo -= 12; if (hi - lo < 35) hi += 12; }
    lo = Math.max(21, lo); hi = Math.min(108, hi);
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    whiteW = W / whites.length;
    blackW = whiteW * 0.62;
    keyPos = new Map();
    whites.forEach((m, i) => keyPos.set(m, { x: i * whiteW, w: whiteW, black: false }));
    for (let m = lo; m <= hi; m++) {
      if (!isBlack(m)) continue;
      const left = keyPos.get(m - 1);
      if (left) keyPos.set(m, { x: left.x + whiteW - blackW / 2, w: blackW, black: true });
    }
    layoutDirty = false;
    lastW = W;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { W: r.width, H: r.height };
  }

  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
  }

  function draw(now) {
    const { W, H } = resize();
    if (!S.song) return;
    if (layoutDirty || Math.abs(W - lastW) > 0.5) layoutKeys(W);
    const staffView = S.view === 'staff';
    const kbH = staffView ? Math.max(64, Math.min(130, H * 0.17)) : Math.max(80, Math.min(170, H * 0.22));
    const hitY = H - kbH;
    lastKb = { hitY, kbH };
    const pps = hitY / S.lookahead; // pixels per song-second
    const pulse = 0.5 + 0.5 * Math.sin(now / 160);

    if (staffView) {
      PianoStaff.draw(ctx, {
        W, H: hitY, t: S.t, notes: S.notes, pitch, practiced, waiting: S.waiting, pulse,
        flats: useFlats(), fingers: fingersOnNotes(), labels: S.labels, mode: S.mode,
        lookahead: S.lookahead, loopA: S.loopA, loopB: S.loopB,
        handColor: (h, a) => withAlpha(HAND[h], a), cacheKey: S.song.id + ':' + S.notes.length,
      });
    } else {
    // background
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, W, H);
    // faint lane lines at each C and F
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    for (const [m, k] of keyPos) if (!k.black && (m % 12 === 0 || m % 12 === 5)) ctx.fillRect(Math.round(k.x), 0, 1, hitY);

    // loop region shading
    if (S.loopA != null) {
      const ya = hitY - (S.loopA - S.t) * pps;
      const yb = S.loopB != null ? hitY - (S.loopB - S.t) * pps : -1e4;
      ctx.fillStyle = 'rgba(255,209,102,0.06)';
      const top = Math.max(0, yb), bot = Math.min(hitY, ya);
      if (bot > top) ctx.fillRect(0, top, W, bot - top);
    }

    // notes
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, hitY); ctx.clip();
    for (const pass of [false, true]) { // white-key notes first, black on top
      for (const n of S.notes) {
        const p = pitch(n);
        const k = keyPos.get(p);
        if (!k || k.black !== pass) continue;
        const yBot = hitY - (n.on - S.t) * pps;
        const yTop = hitY - (n.off - S.t) * pps;
        if (yBot < -2 || yTop > hitY + 2) continue;
        const x = k.x + (k.black ? 1 : 2), w = k.w - (k.black ? 2 : 4);
        const h = Math.max(6, yBot - yTop);
        const mine = practiced(n);
        let fill;
        if (n.st === 'miss') fill = RED;
        else if (n.st === 'hit') fill = performance.now() - n.hitAt < 250 ? GOLD : (mine ? HAND[n.h] : HAND_DIM[n.h]);
        else fill = mine ? HAND[n.h] : HAND_DIM[n.h];
        ctx.globalAlpha = n.st === 'hit' && mine ? 0.55 : 1;
        if (k.black && mine && n.st === 'pending') fill = shade(fill, -0.25);
        rrect(x, yBot - h, w, h, 5);
        ctx.fillStyle = fill;
        ctx.fill();
        if (mine && n.st === 'pending' && S.waiting && S.waiting.includes(n)) {
          ctx.lineWidth = 2 + pulse * 2;
          ctx.strokeStyle = n.struggled ? '#ff9f43' : '#ffffff';
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        let labelBottom = yBot - 3;
        if (n.f && fingersOnNotes() && (mine || S.mode === 'watch') && w >= 10 && h >= 12) {
          const r = Math.max(6, Math.min(n.shift ? 13 : 11, w * (n.shift ? 0.5 : 0.42), h / 2 - 1));
          const cy = yBot - r - 3;
          ctx.beginPath(); ctx.arc(x + w / 2, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = n.shift ? '#ffd166' : 'rgba(255,255,255,0.92)'; ctx.fill();
          if (n.shift) { ctx.lineWidth = 2; ctx.strokeStyle = '#11141a'; ctx.stroke(); }
          ctx.fillStyle = '#11141a';
          ctx.font = `${n.shift ? 900 : 800} ${Math.round(r * 1.25)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(n.f), x + w / 2, cy + 0.5);
          labelBottom = cy - r - 2;
        }
        if (S.labels && labelBottom - (yBot - h) >= 14 && w >= 12) {
          ctx.fillStyle = n.st === 'miss' ? '#fff' : 'rgba(10,12,16,0.85)';
          ctx.font = `600 ${Math.min(13, w * 0.55)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(NAMES[((p % 12) + 12) % 12], x + w / 2, labelBottom);
        }
      }
    }
    ctx.restore();

    // hit line
    const grad = ctx.createLinearGradient(0, hitY - 14, 0, hitY);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.12)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, hitY - 14, W, 14);
    ctx.fillStyle = S.waiting ? `rgba(255,255,255,${0.5 + 0.4 * pulse})` : 'rgba(255,255,255,0.55)';
    ctx.fillRect(0, hitY - 2, W, 2);
    }

    // keyboard state
    const lit = new Map(); // pitch -> colour
    for (const n of S.notes) {
      if (n.on > S.t) break;
      if (n.off >= S.t && !practiced(n)) lit.set(pitch(n), HAND_DIM[n.h]);
    }
    if (S.waiting) for (const n of S.waiting) if (n.st === 'pending') lit.set(pitch(n), withAlpha(HAND[n.h], 0.35 + 0.45 * pulse));
    for (const [p, info] of S.pressed) {
      lit.set(p, info.kind === 'good' ? HAND[info.hand] : info.kind === 'wrong' ? RED : '#9fb3d1');
    }

    for (const pass of [false, true]) {
      for (const [m, k] of keyPos) {
        if (k.black !== pass) continue;
        const kh = k.black ? kbH * 0.62 : kbH;
        const glow = lit.get(m);
        if (k.black) {
          rrect(k.x, hitY, k.w, kh, 3);
          ctx.fillStyle = '#1b1d22'; ctx.fill();
          if (glow) { ctx.fillStyle = glow; ctx.fill(); }
        } else {
          ctx.fillStyle = '#f3f4f6';
          ctx.fillRect(k.x + 0.5, hitY, k.w - 1, kh);
          if (glow) { ctx.fillStyle = glow; ctx.fillRect(k.x + 0.5, hitY, k.w - 1, kh); }
          if (m % 12 === 0 && k.w > 14) {
            ctx.fillStyle = m === 60 ? '#3b82f6' : '#9aa1ad';
            ctx.font = `${m === 60 ? 700 : 500} ${Math.min(12, k.w * 0.5)}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText('C' + (Math.floor(m / 12) - 1), k.x + k.w / 2, hitY + kh - 5);
          }
        }
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, hitY, W, 3);
    drawKeyFingers(hitY, kbH, pulse);

    // particles
    const dt = 1 / 60;
    S.fx = S.fx.filter(f => (f.life += dt) < f.max);
    for (const f of S.fx) {
      const k = keyPos.get(f.p);
      if (!k) continue;
      const t = f.life;
      const x = k.x + k.w / 2 + f.vx * t;
      const y = hitY + f.vy * t + 400 * t * t;
      ctx.globalAlpha = 1 - t / f.max;
      ctx.fillStyle = f.color;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    // floating judgement text
    S.texts = S.texts.filter(t => now - t.born < 700);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of S.texts) {
      const k = keyPos.get(t.p);
      if (!k) continue;
      const age = (now - t.born) / 700;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = t.color;
      ctx.font = '700 15px system-ui, sans-serif';
      ctx.fillText(t.text, Math.min(W - 30, Math.max(30, k.x + k.w / 2)), hitY - 26 - age * 30);
    }
    ctx.globalAlpha = 1;

    // paused overlay
    if (!S.playing && $('results').hidden) {
      const msg = S.t <= S.startT + 0.01 ? 'Press ▶ or play any key on your piano to start' : 'Paused · press Space or any piano key';
      ctx.font = '650 18px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      // In staff view keep the music visible: a small pill near the bottom of the staff.
      const cy = staffView ? hitY - 26 : hitY / 2;
      const tw = ctx.measureText(msg).width + 36;
      ctx.fillStyle = 'rgba(13,15,20,0.78)';
      rrect(W / 2 - tw / 2, cy - 20, tw, 40, 20); ctx.fill();
      ctx.fillStyle = '#eef0f4';
      ctx.fillText(msg, W / 2, cy);
    }
  }

  // Finger numbers on the keys themselves: where each finger goes for the next notes (a hand-position
  // preview). When the help is in hint mode, they only appear after a few seconds stuck in Learn mode.
  function drawKeyFingers(hitY, kbH, pulse) {
    if (!fingerHints() || !S.song) return;
    const stuck = S.waiting && performance.now() - S.waitSince > 1800;
    const full = fingersOnNotes();
    if (!full && !stuck) return;
    const marks = new Map(); // pitch -> { f, hand, strong }
    for (const hand of ['L', 'R']) {
      if (S.mode !== 'watch' && S.hands !== 'both' && S.hands !== hand) continue;
      let first = null;
      for (const n of S.notes) {
        if (n.h !== hand || !n.f || n.st !== 'pending' || n.on < S.t - 0.05) continue;
        if (!first) first = n;
        if (n.on > first.on + (full ? 1.2 : 0.06)) break;
        const p = pitch(n);
        if (!marks.has(p)) marks.set(p, { f: n.f, hand, strong: n.on <= first.on + 0.06 });
      }
    }
    for (const [p, mk] of marks) {
      const k = keyPos.get(p);
      if (!k) continue;
      const kh = k.black ? kbH * 0.62 : kbH;
      const r = Math.max(7, Math.min(13, k.w * 0.4));
      const cx = k.x + k.w / 2, cy = hitY + kh - r - (k.black ? 6 : 22);
      const big = mk.strong && S.waiting;
      ctx.globalAlpha = mk.strong ? 1 : 0.55;
      ctx.beginPath(); ctx.arc(cx, cy, big ? r * (1.1 + 0.15 * pulse) : r, 0, Math.PI * 2);
      ctx.fillStyle = HAND[mk.hand]; ctx.fill();
      ctx.fillStyle = '#0d0f14';
      ctx.font = `800 ${Math.round(r * 1.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(mk.f), cx, cy + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = c => Math.max(0, Math.min(255, Math.round(c * (1 + amt))));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  function withAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  let hudCache = '';
  function updateHud() {
    const acc = accuracy();
    const sc = S.score;
    const key = [sc.points, acc, sc.streak, mult()].join('|');
    if (key !== hudCache) {
      hudCache = key;
      $('hudPoints').textContent = sc.points.toLocaleString();
      $('hudAcc').textContent = acc == null ? '–' : Math.round(acc * 100) + '%';
      $('hudStreak').textContent = sc.streak;
      $('hudMult').textContent = '×' + mult();
    }
    const d = S.duration || 1;
    $('tlFill').style.width = (Math.max(0, S.t) / d) * 100 + '%';
    $('tlHead').style.left = `calc(${(Math.max(0, S.t) / d) * 100}% - 1px)`;
    const loopEl = $('tlLoop');
    if (S.loopA != null) {
      loopEl.style.display = 'block';
      loopEl.style.left = (S.loopA / d) * 100 + '%';
      loopEl.style.width = (((S.loopB != null ? S.loopB : S.t) - S.loopA) / d) * 100 + '%';
    } else loopEl.style.display = 'none';
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    mic.tick();
    update(dt);
    draw(now);
    if (S.song) updateHud();
    requestAnimationFrame(frame);
  }

  // Web version: work offline once it has been opened (not needed inside the Chrome extension).
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  setupMidi();
  route();
  requestAnimationFrame(frame);

  // Exposed for testing in the console.
  // Tap the on-screen keys (touch screens, or a mouse): plays the note and counts it like a real key.
  (() => {
    const held = new Map(); // pointerId -> pitch
    const keyAt = (x, y) => {
      const { hitY, kbH } = lastKb;
      if (y < hitY || y > hitY + kbH) return null;
      for (const black of [true, false]) {
        for (const [m, k] of keyPos) {
          if (k.black !== black) continue;
          if (black && y > hitY + kbH * 0.62) continue;
          if (x >= k.x && x < k.x + k.w) return m;
        }
      }
      return null;
    };
    const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', e => {
      const m = keyAt(...pos(e));
      if (m == null) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      held.set(e.pointerId, m);
      if (!S.mySound) synth.noteOn(m, 0.8);
      noteOn(m, 0.8);
    });
    const up = e => {
      const m = held.get(e.pointerId);
      if (m == null) return;
      held.delete(e.pointerId);
      if (!S.mySound) synth.noteOff(m);
      noteOff(m);
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  })();

  syncInput();

  window.__piano = { S, noteOn, noteOff, seek, play, pause, setMode, setHands, tick: dt => update(dt), mic, synth };
})();
