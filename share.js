// Moving songs between devices without a server: the whole song is compressed into the part of a
// link after "#", which browsers never send to the website. Open the link on the iPad and the song
// is saved there. Also plain .json files for AirDrop / Files.
const SongShare = (() => {
  const b64url = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64url = str => {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  async function pipe(bytes, stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }

  // Compact form: notes as [midi, start (centiseconds since previous start), length (cs), hand 0/1].
  function pack(song) {
    let prev = 0;
    const n = [];
    for (const x of song.notes) {
      const on = Math.round(x.on * 100), len = Math.max(1, Math.round((x.off - x.on) * 100));
      n.push(x.m, on - prev, len, x.h === 'L' ? 0 : 1);
      prev = on;
    }
    return { v: 1, id: song.id, t: song.title, u: song.url || '', d: Math.round((song.duration || 0) * 100), n };
  }
  function unpack(o) {
    const notes = [];
    let on = 0;
    for (let i = 0; i + 3 < o.n.length; i += 4) {
      on += o.n[i + 1];
      notes.push({ m: o.n[i], on: on / 100, off: (on + o.n[i + 2]) / 100, h: o.n[i + 3] ? 'R' : 'L' });
    }
    return { id: o.id, title: o.t, url: o.u || undefined, duration: o.d / 100, source: 'shared', createdAt: Date.now(), notes };
  }

  async function encode(song) {
    const json = new TextEncoder().encode(JSON.stringify(pack(song)));
    if (typeof CompressionStream === 'undefined') return 'j' + b64url(json);
    return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
  }
  async function decode(code) {
    const kind = code[0], bytes = fromB64url(code.slice(1));
    const json = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
    return unpack(JSON.parse(new TextDecoder().decode(json)));
  }

  function toFile(song) {
    return new Blob([JSON.stringify(pack(song))], { type: 'application/json' });
  }
  function fromFileText(text) {
    const o = JSON.parse(text);
    if (o && o.v === 1 && Array.isArray(o.n)) return unpack(o);
    if (o && Array.isArray(o.notes)) return o; // a full song object
    throw new Error('Not a Piano Practice song file');
  }

  return { encode, decode, toFile, fromFileText };
})();
