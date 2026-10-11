// Built-in practice piece so the page works before anything has been scanned.
// Beethoven, "Ode to Joy" (public domain), simplified.
const DEMO_SONG = (() => {
  const q = 0.6; // seconds per beat (100 bpm)
  const E4 = 64, F4 = 65, G4 = 67, D4 = 62, C4 = 60;
  // [midi, beats]
  const melody = [
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [C4, 1], [C4, 1], [D4, 1], [E4, 1], [E4, 1.5], [D4, 0.5], [D4, 2],
    [E4, 1], [E4, 1], [F4, 1], [G4, 1], [G4, 1], [F4, 1], [E4, 1], [D4, 1],
    [C4, 1], [C4, 1], [D4, 1], [E4, 1], [D4, 1.5], [C4, 0.5], [C4, 2],
  ];
  // Left hand: one bass note per bar (4 beats)
  const bass = [48, 43, 48, 43, 48, 43, 48, 48]; // C3 G2 ...
  const notes = [];
  let t = 1.0;
  for (const [m, b] of melody) { notes.push({ m, on: +t.toFixed(3), off: +(t + b * q - 0.04).toFixed(3), h: 'R' }); t += b * q; }
  bass.forEach((m, i) => notes.push({ m, on: +(1.0 + i * 4 * q).toFixed(3), off: +(1.0 + (i + 1) * 4 * q - 0.06).toFixed(3), h: 'L' }));
  notes.sort((a, b) => a.on - b.on || a.m - b.m);
  return { id: 'demo', title: 'Demo: Ode to Joy (Beethoven)', source: 'demo', duration: t + 1, notes };
})();
