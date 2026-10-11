// Automatic beginner fingering (1 = thumb … 5 = little finger, both hands).
// Teaches the Simply Piano way: keep each hand in a five-finger position, one finger per key,
// and move the hand as rarely as possible, preferably when there is time to move.
// Solved per hand with dynamic programming over note events (single notes and chords).
const PianoFingering = (() => {
  // Horizontal key position in white-key units; black keys sit halfway between whites.
  const WHITE_POS = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
  const pc = m => ((m % 12) + 12) % 12;
  const keyPos = m => Math.floor(m / 12) * 7 + WHITE_POS[pc(m)];
  const isBlack = m => [1, 3, 6, 8, 10].includes(pc(m));

  // Increasing finger tuples of length k (k notes in a chord, lowest pitch first for the right hand).
  const COMBOS = [[]];
  for (let k = 1; k <= 5; k++) {
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let f = start; f <= 5; f++) { acc.push(f); rec(f + 1, acc); acc.pop(); }
    };
    rec(1, []);
    COMBOS.push(out);
  }

  // Where the thumb would be if finger f plays key m (five-finger position: finger f sits f-1 keys from the thumb).
  const thumbAt = (m, f, hand) => (hand === 'R' ? keyPos(m) - (f - 1) : keyPos(m) + (f - 1));

  function stateFor(ev, fingers, hand) {
    const ps = ev.pitches.map((m, i) => thumbAt(m, fingers[i], hand));
    const P = ps.reduce((s, v) => s + v, 0) / ps.length;
    let cost = 0;
    // Stretching or squeezing away from the five-finger position.
    for (const v of ps) cost += Math.abs(v - P) * 1.6;
    ev.pitches.forEach((m, i) => {
      const f = fingers[i];
      if (isBlack(m) && f === 1) cost += 1.2;   // thumb on a black key is awkward, but fine in five-finger positions
      if (isBlack(m) && f === 5) cost += 0.3;
      if (f === 4) cost += 0.15;                 // weaker fingers slightly less preferred
    });
    if (ev.pitches.length > 1) {
      const span = keyPos(ev.pitches[ev.pitches.length - 1]) - keyPos(ev.pitches[0]);
      if (span > 7) cost += (span - 7) * 4;      // more than an octave apart: very hard for a beginner
    }
    return { fingers, P, cost };
  }

  // Comfortable spans in semitones between two fingers of the right hand, from Parncutt et al. (1997),
  // "An ergonomic model of keyboard fingering". [minPrac, minComf, minRel, maxRel, maxComf, maxPrac]
  const SPAN = {
    12: [-5, -3, 1, 5, 8, 10], 13: [-4, -2, 3, 7, 10, 12], 14: [-3, -1, 5, 9, 12, 14], 15: [-1, 1, 7, 10, 13, 15],
    23: [1, 1, 1, 2, 3, 5], 24: [1, 1, 3, 4, 5, 7], 25: [2, 2, 5, 6, 8, 10],
    34: [1, 1, 1, 2, 2, 4], 35: [1, 1, 3, 4, 5, 7], 45: [1, 1, 1, 2, 3, 5],
  };

  // Effort of playing pitch p2 with finger f2 straight after p1 with f1.
  function pairCost(f1, p1, f2, p2, hand) {
    if (f1 === f2) return p1 === p2 ? 0 : 3 + 0.4 * Math.abs(p2 - p1); // same finger on a new key = hand move
    let a = f1, b = f2, d = p2 - p1;
    if (a > b) { [a, b] = [b, a]; d = -d; }
    if (hand === 'L') d = -d; // the left hand is a mirror image
    const [minPrac, minComf, minRel, maxRel, maxComf, maxPrac] = SPAN[a * 10 + b];
    const w = a === 1 ? 1 : 2;
    let c = 0;
    if (d < minComf) c += 2 * (minComf - d);
    if (d > maxComf) c += 2 * (d - maxComf);
    if (d < minRel) c += w * (minRel - d);
    if (d > maxRel) c += w * (d - maxRel);
    if (d < minPrac || d > maxPrac) c += 10;
    return c;
  }

  function moveCost(a, b, dt, ea, eb, hand) {
    // Compare the outer notes of each event (for single notes this is just the two notes).
    const first = pairCost(a.fingers[0], ea.pitches[0], b.fingers[0], eb.pitches[0], hand);
    const la = ea.pitches.length - 1, lb = eb.pitches.length - 1;
    const last = pairCost(a.fingers[la], ea.pitches[la], b.fingers[lb], eb.pitches[lb], hand);
    let c = (first + last) / 2;
    // Beginner method: stay in one five-finger position. Leaving it (more than a key's stretch) is a hand shift.
    const d = Math.abs(b.P - a.P);
    if (d > 1) c += 1.5 + 0.5 * d;
    // A real jump is a hand move: cap the cost, and moving is easier when there is time.
    c = Math.min(c, 7 + 0.3 * Math.abs(eb.pitches[0] - ea.pitches[0]));
    if (dt >= 0.6) c *= 0.6;
    else if (dt < 0.15) c *= 1.4;
    return c;
  }

  // notes: [{p, on, off}] for ONE hand. Sets n.finger (1-5) and returns hand positions over time.
  function assignHand(notes, hand) {
    const sorted = notes.slice().sort((a, b) => a.on - b.on || a.p - b.p);
    const events = [];
    for (const n of sorted) {
      const e = events[events.length - 1];
      if (e && n.on - e.on < 0.04) e.notes.push(n);
      else events.push({ on: n.on, notes: [n] });
    }
    for (const e of events) {
      e.notes.sort((a, b) => a.p - b.p);
      // A hand can't play more than five notes; extra notes go unfingered.
      if (e.notes.length > 5) e.notes = hand === 'R' ? e.notes.slice(-5) : e.notes.slice(0, 5);
      e.pitches = e.notes.map(n => n.p);
    }
    if (!events.length) return [];

    // Viterbi
    const layers = events.map(e => {
      const k = e.pitches.length;
      return COMBOS[k].map(c => stateFor(e, hand === 'R' ? c : c.slice().reverse(), hand));
    });
    let prevCost = layers[0].map(s => s.cost);
    const back = [layers[0].map(() => -1)];
    for (let i = 1; i < events.length; i++) {
      const dt = events[i].on - events[i - 1].on;
      const cur = [], bp = [];
      for (const s of layers[i]) {
        let best = Infinity, bi = 0;
        layers[i - 1].forEach((ps, j) => {
          const c = prevCost[j] + moveCost(ps, s, dt, events[i - 1], events[i], hand);
          if (c < best) { best = c; bi = j; }
        });
        cur.push(best + s.cost);
        bp.push(bi);
      }
      prevCost = cur;
      back.push(bp);
    }
    let idx = prevCost.indexOf(Math.min(...prevCost));
    const chosen = new Array(events.length);
    for (let i = events.length - 1; i >= 0; i--) {
      chosen[i] = layers[i][idx];
      idx = back[i][idx];
    }

    // Apply fingers, then mark hand shifts the way method books do: the first note played in a new
    // hand position gets a bold finger number. A note "fits" the current five-finger position if its
    // finger lands within one key of where that finger rests (so a small stretch is not a shift).
    const positions = [];
    let P0 = null;
    events.forEach((e, i) => {
      const s = chosen[i];
      e.notes.forEach((n, j) => { n.finger = s.fingers[j]; n.shift = null; });
      const thumbs = e.notes.map(n => thumbAt(n.p, n.finger, hand));
      if (P0 == null) {
        P0 = thumbs.reduce((a, b) => a + b, 0) / thumbs.length;
        e.notes.forEach(n => { n.shift = 'start'; });
        positions.push({ on: e.on, P: P0, hand });
        return;
      }
      if (thumbs.every(t => Math.abs(t - P0) <= 1)) return;
      const P = thumbs.reduce((a, b) => a + b, 0) / thumbs.length;
      const dir = P > P0 ? 'up' : 'down';
      e.notes.forEach(n => { n.shift = dir; });
      positions.push({ on: e.on, P, hand });
      P0 = P;
    });
    return positions;
  }

  // Annotates notes in place: notes [{p, on, off, h}] -> n.finger. Returns { L: positions, R: positions }.
  function assign(notes) {
    return {
      L: assignHand(notes.filter(n => n.h === 'L'), 'L'),
      R: assignHand(notes.filter(n => n.h === 'R'), 'R'),
    };
  }

  // ---------- keys ----------
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  // Krumhansl-Schmuckler key estimate from note durations. pitches: [{p, on, off}]
  function estimateKey(notes) {
    const hist = new Array(12).fill(0);
    for (const n of notes) hist[pc(n.p)] += Math.max(0.05, n.off - n.on);
    const corr = (prof, tonic) => {
      const xs = prof.map((_, i) => prof[(i - tonic + 12) % 12]);
      const mx = xs.reduce((a, b) => a + b) / 12, my = hist.reduce((a, b) => a + b) / 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (hist[i] - my); dx += (xs[i] - mx) ** 2; dy += (hist[i] - my) ** 2; }
      return dx && dy ? num / Math.sqrt(dx * dy) : 0;
    };
    let best = { tonic: 0, minor: false, r: -2 };
    for (let t = 0; t < 12; t++) {
      const a = corr(MAJOR, t), b = corr(MINOR, t);
      if (a > best.r) best = { tonic: t, minor: false, r: a };
      if (b > best.r) best = { tonic: t, minor: true, r: b };
    }
    return best;
  }
  const keyName = (k, shift = 0) => KEY_NAMES[pc(k.tonic + shift)] + (k.minor ? ' minor' : ' major');

  // Transposition (-6..+6 semitones) with the fewest black-key notes; ties prefer the smallest move.
  function easiestShift(notes) {
    let best = { shift: 0, black: Infinity };
    for (let s = -6; s <= 6; s++) {
      let black = 0;
      for (const n of notes) if (isBlack(n.p + s)) black++;
      if (black < best.black || (black === best.black && Math.abs(s) < Math.abs(best.shift))) best = { shift: s, black };
    }
    return best.shift;
  }

  return { assign, estimateKey, keyName, easiestShift, keyPos, isBlack };
})();
