// Scrolling grand staff in the style of Simply Piano: right hand on the treble staff, left hand on
// the bass staff, notes travel right-to-left into a playhead. Note spacing is proportional to time,
// so scanned songs (which have exact timings but no written rhythm) read correctly.
// Finger numbers sit above the right-hand notes and below the left-hand notes; the first note of each
// new hand position gets a bold, highlighted number with an arrow showing which way the hand moves.
const PianoStaff = (() => {
  // [letter index C=0..B=6, accidental -1/0/1] per pitch class
  const SHARP = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
  const FLAT = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const E4 = 30, F5 = 38, B4 = 34;   // treble: bottom line, top line, middle line (diatonic steps)
  const G2 = 18, A3 = 26, D3 = 22;   // bass: bottom line, top line, middle line

  function spell(m, flats) {
    const pc = ((m % 12) + 12) % 12;
    const [l, acc] = (flats ? FLAT : SHARP)[pc];
    return { step: (Math.floor(m / 12) - 1) * 7 + l, acc, letter: LETTERS[l] };
  }

  // Group notes by hand and onset (chords share a stem and a finger-number stack).
  let cache = { key: '', groups: [] };
  function groupsFor(env) {
    const key = env.cacheKey;
    if (cache.key === key) return cache.groups;
    const groups = [];
    const sorted = env.notes.slice().sort((a, b) => a.on - b.on);
    const open = { L: null, R: null };
    for (const n of sorted) {
      const g = open[n.h];
      if (g && n.on - g.on < 0.04) g.notes.push(n);
      else { open[n.h] = { on: n.on, hand: n.h, notes: [n] }; groups.push(open[n.h]); }
    }
    cache = { key, groups };
    return groups;
  }

  function draw(ctx, env) {
    const { W, H, t, pitch, practiced, flats, pulse } = env;
    const sp = Math.max(7, Math.min(15, H / 27));          // space between staff lines
    const trebleTop = H / 2 - 6.5 * sp;
    const trebleBottom = trebleTop + 4 * sp;
    const bassTop = trebleBottom + 5 * sp;
    const bassBottom = bassTop + 4 * sp;
    const yOf = (step, treble) => (treble ? trebleBottom - (step - E4) * sp / 2 : bassBottom - (step - G2) * sp / 2);
    const clefW = 4.2 * sp + 14;
    const playX = clefW + Math.max(40, W * 0.14);
    const pps = Math.max(60, (W - playX) / (env.lookahead * 1.25));
    const rx = sp * 0.62, ry = sp * 0.44;

    // paper
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, W, H);

    // loop region
    if (env.loopA != null) {
      const xa = playX + (env.loopA - t) * pps;
      const xb = env.loopB != null ? playX + (env.loopB - t) * pps : W + 10;
      ctx.fillStyle = 'rgba(255,209,102,0.18)';
      ctx.fillRect(Math.max(clefW, xa), trebleTop - 5 * sp, Math.max(0, xb - Math.max(clefW, xa)), bassBottom - trebleTop + 10 * sp);
    }

    // staff lines
    ctx.strokeStyle = 'rgba(30,30,30,0.55)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      for (const top of [trebleTop, bassTop]) {
        const y = Math.round(top + i * sp) + 0.5;
        ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(W, y); ctx.stroke();
      }
    }
    // system line + brace
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(8, trebleTop); ctx.lineTo(8, bassBottom); ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.font = `${Math.round(sp * 7.4)}px "Bravura", "Apple Symbols", "Noto Music", "Segoe UI Symbol", serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('\u{1D11E}', 12, trebleBottom + sp * 1.15);
    ctx.font = `${Math.round(sp * 3.9)}px "Bravura", "Apple Symbols", "Noto Music", "Segoe UI Symbol", serif`;
    ctx.fillText('\u{1D122}', 14, bassTop + sp * 2.95);

    // clip notes to the scrolling area
    ctx.save();
    ctx.beginPath(); ctx.rect(clefW - 4, 0, W - clefW + 4, H); ctx.clip();

    const groups = groupsFor(env);
    const now = performance.now();
    for (const g of groups) {
      const x0 = playX + (g.on - t) * pps;
      if (x0 > W + 40) break;
      const endX = playX + (Math.max(...g.notes.map(n => n.off)) - t) * pps;
      if (endX < clefW - 30) continue;
      const treble = g.hand === 'R';
      const mine = g.notes.some(practiced);
      const past = x0 < playX - 2;
      ctx.globalAlpha = past ? Math.max(0.25, 1 - (playX - x0) / (playX - clefW + 1) * 0.8) : 1;

      const items = g.notes.map(n => {
        const p = pitch(n);
        const s = spell(p, flats);
        return { n, p, ...s, y: yOf(s.step, treble) };
      }).sort((a, b) => a.step - b.step);

      // seconds in a chord sit side by side
      let prevStep = null, prevShift = false;
      for (const it of items) {
        it.dx = prevStep != null && it.step - prevStep === 1 && !prevShift ? rx * 1.9 : 0;
        prevShift = it.dx !== 0; prevStep = it.step;
      }

      // how long to hold: a soft bar behind the notehead
      for (const it of items) {
        const len = (it.n.off - it.n.on) * pps;
        if (len > rx * 2.2) {
          ctx.fillStyle = env.handColor(it.n.h, 0.22);
          ctx.fillRect(x0 + it.dx, it.y - ry * 0.55, len - 2, ry * 1.1);
        }
      }

      // ledger lines
      ctx.strokeStyle = 'rgba(30,30,30,0.7)'; ctx.lineWidth = 1.2;
      for (const it of items) {
        const [lo, hi] = treble ? [E4, F5] : [G2, A3];
        const ledgers = [];
        for (let s = lo - 2; s >= it.step; s -= 2) ledgers.push(s);
        for (let s = hi + 2; s <= it.step; s += 2) ledgers.push(s);
        for (const s of ledgers) {
          const y = Math.round(yOf(s, treble)) + 0.5;
          ctx.beginPath(); ctx.moveTo(x0 + it.dx - rx * 1.7, y); ctx.lineTo(x0 + it.dx + rx * 1.7, y); ctx.stroke();
        }
      }

      // stem (one per chord)
      const mid = treble ? B4 : D3;
      const avg = items.reduce((s, it) => s + it.step, 0) / items.length;
      const stemUp = avg < mid;
      const topY = Math.min(...items.map(i => i.y)), botY = Math.max(...items.map(i => i.y));
      ctx.strokeStyle = mine ? '#1c1c1c' : '#9a9a9a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let stemEnd;
      if (stemUp) { stemEnd = topY - sp * 3.4; ctx.moveTo(x0 + rx * 0.92, botY); ctx.lineTo(x0 + rx * 0.92, stemEnd); }
      else { stemEnd = botY + sp * 3.4; ctx.moveTo(x0 - rx * 0.92, topY); ctx.lineTo(x0 - rx * 0.92, stemEnd); }
      ctx.stroke();

      // noteheads
      for (const it of items) {
        const n = it.n, hx = x0 + it.dx;
        let fill = practiced(n) ? '#1c1c1c' : '#a3a3a3';
        if (n.st === 'hit') fill = '#22a35a';
        else if (n.st === 'miss') fill = '#e5484d';
        else if (n.struggled) fill = '#f08c2b';
        const waiting = env.waiting && env.waiting.includes(n);
        if (waiting) {
          ctx.beginPath(); ctx.arc(hx, it.y, sp * (1.15 + 0.25 * pulse), 0, Math.PI * 2);
          ctx.fillStyle = env.handColor(n.h, 0.35); ctx.fill();
        }
        if (n.st === 'hit' && now - n.hitAt < 300) {
          ctx.beginPath(); ctx.arc(hx, it.y, sp * (1 + (now - n.hitAt) / 200), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(34,163,90,0.25)'; ctx.fill();
        }
        ctx.beginPath();
        ctx.ellipse(hx, it.y, rx, ry, -0.35, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        if (env.labels && sp >= 10) {
          ctx.fillStyle = '#fff';
          ctx.font = `700 ${Math.round(sp * 0.72)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(it.letter, hx, it.y + 0.5);
        }
        if (it.acc) {
          ctx.fillStyle = fill;
          ctx.font = `${Math.round(sp * 1.6)}px "Apple Symbols", "Noto Music", "Segoe UI Symbol", serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(it.acc > 0 ? '♯' : '♭', hx - rx * 2.3, it.y - (it.acc < 0 ? sp * 0.3 : 0));
        }
      }

      // finger numbers: above for the right hand, below for the left
      if (env.fingers && g.notes.some(n => n.f && (practiced(n) || env.mode === 'watch'))) {
        const fs = Math.round(sp * 1.15);
        const order = items.slice().reverse(); // highest note first
        const lineH = fs * 1.25;
        let y = treble
          ? Math.min(topY - sp * 1.6, trebleTop - sp * 1.2, stemUp ? stemEnd - sp * 0.9 : Infinity) - (order.length - 1) * lineH
          : Math.max(botY + sp * 1.6, bassBottom + sp * 1.2, !stemUp ? stemEnd + sp * 0.9 : -Infinity);
        for (const it of order) {
          const n = it.n;
          if (!n.f) { y += lineH; continue; }
          const bold = !!n.shift;
          if (bold) {
            const r = fs * 0.78;
            ctx.beginPath(); ctx.arc(x0, y, r, 0, Math.PI * 2);
            ctx.fillStyle = env.handColor(n.h, 1); ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#11141a'; ctx.stroke();
            ctx.fillStyle = '#0d0f14';
            ctx.font = `900 ${Math.round(fs * 1.05)}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(n.f), x0, y + 1);
            if (n.shift === 'up' || n.shift === 'down') {
              ctx.fillStyle = '#11141a';
              ctx.font = `700 ${Math.round(fs * 0.8)}px system-ui, sans-serif`;
              ctx.fillText(n.shift === 'up' ? '▲' : '▼', x0 + r + fs * 0.5, y + 1);
            }
          } else {
            ctx.fillStyle = '#3a3f4b';
            ctx.font = `600 ${fs}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(String(n.f), x0, y + 1);
          }
          y += lineH;
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // playhead
    ctx.fillStyle = env.waiting ? `rgba(59,130,246,${0.55 + 0.35 * pulse})` : 'rgba(59,130,246,0.55)';
    ctx.fillRect(playX - 1.5, trebleTop - 4 * sp, 3, bassBottom - trebleTop + 8 * sp);

    // hand labels
    ctx.font = `600 ${Math.round(sp * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = env.handColor('R', 1);
    ctx.fillText('R', 12, trebleTop - sp * 1.6);
    ctx.fillStyle = env.handColor('L', 1);
    ctx.fillText('L', 12, bassBottom + sp * 1.6);
  }

  return { draw, spell };
})();
