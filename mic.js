// Microphone input for pianos without MIDI (and for iPad, where Safari has no Web MIDI).
// Full transcription of a piano through a microphone is hard; checking whether the notes the song
// expects right now are sounding is much easier. So the game tells the listener which pitches to
// watch for, and the listener reports note-ons for those pitches when their fundamental plus
// harmonics jump out of the background.
class MicListener {
  constructor({ onNote, getCandidates, isSynthPlaying }) {
    this.onNote = onNote;                 // (midi, velocity) => void
    this.getCandidates = getCandidates;   // () => Set of midi numbers worth listening for
    this.isSynthPlaying = isSynthPlaying; // (midi) => bool, so the computer's own sound is ignored
    this.sensitivity = 0.5;               // 0..1
    this.active = false;
    this.state = new Map();               // midi -> { on, since, hist: recent dB levels }
    this.level = 0;                       // input loudness for a meter
  }

  async start(sharedCtx) {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = sharedCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.connectSource(this.ctx.createMediaStreamSource(this.stream));
  }

  // Also used by the self-test, which feeds the synth straight in.
  connectSource(node) {
    this.ctx = node.context;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;              // ~5.9 Hz per bin at 48 kHz: enough to separate low notes
    this.analyser.smoothingTimeConstant = 0;
    node.connect(this.analyser);
    this.spec = new Float32Array(this.analyser.frequencyBinCount);
    // A short window reacts within ~40 ms, so a key struck again is noticed even while it still rings.
    this.fast = this.ctx.createAnalyser();
    this.fast.fftSize = 2048;
    this.fast.smoothingTimeConstant = 0;
    node.connect(this.fast);
    this.fastSpec = new Float32Array(this.fast.frequencyBinCount);
    this.fastHz = this.ctx.sampleRate / this.fast.fftSize;
    this.binHz = this.ctx.sampleRate / this.analyser.fftSize;
    this.active = true;
    this.state.clear();
  }

  stop() {
    this.active = false;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  // Strength (dB) of a pitch: its fundamental and first harmonics. A partial only counts if it is the
  // loudest point within a quarter-tone either side, so the next semitone's sound can't stand in for it.
  pitchDb(m) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const q = Math.pow(2, 0.5 / 12);
    const partial = freq => {
      const b = Math.round(freq / this.binHz);
      const lo = Math.max(1, Math.floor(freq / q / this.binHz)), hi = Math.min(this.spec.length - 1, Math.ceil(freq * q / this.binHz));
      let mx = -200, at = b;
      for (let i = lo; i <= hi; i++) if (this.spec[i] > mx) { mx = this.spec[i]; at = i; }
      return Math.abs(at - b) <= 1 ? mx : -200;
    };
    const ps = [partial(f), partial(2 * f), partial(3 * f)];
    // Low piano notes have weak fundamentals; above C3 the fundamental itself must be there.
    if (m >= 48 && (ps[0] <= -200 || ps[0] < Math.max(ps[1], ps[2]) - 15)) return -200;
    if (m < 48 && ps[0] <= -200 && (ps[1] <= -200 || ps[2] <= -200)) return -200;
    // Octave/twelfth confusion: this pitch's fundamental is also the 2nd harmonic of the note an octave
    // down (and the 3rd harmonic of the note a twelfth down). Only count it if it is clearly stronger
    // than a harmonic of that lower note would be.
    if (ps[0] > -200) {
      const sub2 = partial(f / 2), sub3 = partial(f / 3);
      if (sub2 > -200 && ps[0] < sub2 - 4) return -200;
      if (sub3 > -200 && ps[0] < sub3 - 8) return -200;
    }
    const w = m < 48 ? [0.5, 1, 0.8] : [1, 0.7, 0.4];
    let best = -200;
    ps.forEach((p, i) => { if (p > -200) best = Math.max(best, p + 20 * Math.log10(w[i])); });
    return best;
  }

  // Energy near a pitch's fundamental and 2nd harmonic in the short window (for detecting strikes).
  fastDb(m) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    let mx = -200;
    for (const freq of [f, 2 * f]) {
      const b = Math.round(freq / this.fastHz);
      for (let i = b - 1; i <= b + 1; i++) if (i > 0 && i < this.fastSpec.length && this.fastSpec[i] > mx) mx = this.fastSpec[i];
    }
    return mx;
  }

  // Call once per animation frame.
  tick() {
    if (!this.active) return;
    this.analyser.getFloatFrequencyData(this.spec);
    this.fast.getFloatFrequencyData(this.fastSpec);
    // Broadband loudness in the short window: a hammer "click" raises everything at once,
    // so a strike only counts for a pitch if that pitch jumps clearly more than the whole spectrum.
    let tot = 0;
    const flo = Math.round(60 / this.fastHz), fhi = Math.round(4000 / this.fastHz);
    for (let i = flo; i < fhi; i++) tot += Math.pow(10, this.fastSpec[i] / 10);
    const totDb = 10 * Math.log10(tot + 1e-12);
    this.totHist = this.totHist || [];
    this.totHist.push(totDb);
    if (this.totHist.length > 6) this.totHist.shift();
    const globalRise = totDb - Math.min(...this.totHist);
    // background level: median of the musical range
    const lo = Math.round(60 / this.binHz), hi = Math.round(4200 / this.binHz);
    const slice = Array.from(this.spec.subarray(lo, hi)).sort((a, b) => a - b);
    // Clamp: a very quiet room (or a digital test signal) would otherwise make everything look loud.
    const floor = Math.max(-95, slice[slice.length >> 1]);
    let loud = -200;
    for (let i = lo; i < hi; i++) if (this.spec[i] > loud) loud = this.spec[i];
    this.level = Math.max(0, Math.min(1, (loud + 90) / 70));

    const need = 30 - this.sensitivity * 18;          // dB above the background to count as sounding
    const minAbs = -62 - this.sensitivity * 20;       // and loud enough in absolute terms (dBFS)
    const now = performance.now();
    const cands = this.getCandidates();
    for (const m of cands) {
      const abs = this.pitchDb(m);
      const db = abs < minAbs ? -100 : abs - floor;
      let st = this.state.get(m);
      if (!st) { st = { on: false, since: now, hist: [], fhist: [] }; this.state.set(m, st); }
      st.hist.push(db);
      if (st.hist.length > 9) st.hist.shift();
      const fdb = this.fastDb(m);
      st.fhist.push(fdb);
      if (st.fhist.length > 6) st.fhist.shift();
      const jump = fdb - Math.min(...st.fhist);
      const struck = jump > 9 && jump - globalRise > 4;   // this pitch was just struck again
      const rising = db - Math.min(...st.hist) > 6;
      if (!st.on && db > need && rising && now - st.since > 120 && !this.isSynthPlaying(m)) {
        st.on = true; st.since = now;
        this.onNote(m, Math.max(0.3, Math.min(1, db / 50)));
      } else if (st.on && db < need - 8) {
        st.on = false; st.since = now;
      } else if (st.on && struck && db > need && now - st.since > 150 && !this.isSynthPlaying(m)) {
        // a fresh strike of a note that was still ringing
        st.since = now;
        this.onNote(m, Math.max(0.3, Math.min(1, db / 50)));
      }
    }
    for (const m of [...this.state.keys()]) if (!cands.has(m)) this.state.delete(m);
  }
}
