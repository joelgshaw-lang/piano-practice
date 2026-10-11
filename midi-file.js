// Minimal Standard MIDI File reader -> [{m, on, off, h}] in seconds.
// Hands: with 2+ note tracks the higher-pitched track is the right hand; otherwise split at middle C.
function parseMidiFile(buffer) {
  const data = new DataView(buffer);
  let p = 0;
  const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(data.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const v = data.getUint32(p); p += 4; return v; };
  const u16 = () => { const v = data.getUint16(p); p += 2; return v; };
  const u8 = () => data.getUint8(p++);
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32();
  const format = u16(), ntrks = u16(), division = u16();
  p += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  void format;

  const tempos = [{ tick: 0, us: 500000 }];
  const tracks = [];
  for (let ti = 0; ti < ntrks && p < data.byteLength; ti++) {
    const id = str(4), len = u32(), end = p + len;
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, status = 0;
    const open = new Map();
    const notes = [];
    while (p < end) {
      tick += vlq();
      let b = u8();
      if (b === 0xff) {
        const type = u8(), l = vlq();
        if (type === 0x51 && l === 3) tempos.push({ tick, us: (data.getUint8(p) << 16) | (data.getUint8(p + 1) << 8) | data.getUint8(p + 2) });
        p += l;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) { p += vlq(); continue; }
      if (b & 0x80) status = b; else p--; // running status
      const type = status & 0xf0, ch = status & 0x0f;
      const a = u8();
      const c = (type === 0xc0 || type === 0xd0) ? 0 : u8();
      const key = ch * 128 + a;
      if (type === 0x90 && c > 0) {
        if (open.has(key)) notes.push({ m: a, t0: open.get(key).t0, t1: tick, ch });
        open.set(key, { t0: tick, vel: c });
      } else if (type === 0x80 || (type === 0x90 && c === 0)) {
        const o = open.get(key);
        if (o) { notes.push({ m: a, t0: o.t0, t1: tick, ch }); open.delete(key); }
      }
    }
    p = end;
    if (notes.length) tracks.push(notes);
  }

  tempos.sort((x, y) => x.tick - y.tick);
  const toSec = tick => {
    let sec = 0, last = 0, us = 500000;
    for (const t of tempos) {
      if (t.tick > tick) break;
      sec += ((t.tick - last) / division) * (us / 1e6);
      last = t.tick; us = t.us;
    }
    return sec + ((tick - last) / division) * (us / 1e6);
  };

  const avg = ns => ns.reduce((s, n) => s + n.m, 0) / ns.length;
  let out = [];
  if (tracks.length >= 2) {
    const ranked = tracks.map(t => ({ t, a: avg(t) })).sort((x, y) => y.a - x.a);
    const mid = (ranked[0].a + ranked[ranked.length - 1].a) / 2;
    ranked.forEach(({ t, a }) => t.forEach(n => out.push({ ...n, h: a >= mid ? 'R' : 'L' })));
  } else if (tracks.length === 1) {
    out = tracks[0].map(n => ({ ...n, h: n.m >= 60 ? 'R' : 'L' }));
  }
  return out
    .map(n => ({ m: n.m, on: +toSec(n.t0).toFixed(3), off: +Math.max(toSec(n.t1), toSec(n.t0) + 0.05).toFixed(3), h: n.h }))
    .sort((a, b) => a.on - b.on || a.m - b.m);
}
