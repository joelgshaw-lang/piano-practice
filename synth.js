// Small Web Audio piano-ish synth. No samples, so it loads instantly.
class PianoSynth {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.voices = new Map(); // midi -> voice (for held user notes)
  }

  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }

  _voice(midi, vel, when) {
    const ctx = this.ensure();
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const t = when ?? ctx.currentTime;
    const amp = 0.22 * vel;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(amp, t + 0.006);
    out.gain.exponentialRampToValueAtTime(amp * 0.35, t + 0.35);
    const decay = 3.2 - ((midi - 21) / 87) * 2.4; // low notes ring longer
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.35 + decay);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(9000, f * 8), t);
    filter.frequency.exponentialRampToValueAtTime(Math.min(4000, Math.max(600, f * 3)), t + 0.5);
    filter.connect(out).connect(this.master);

    const partials = [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12], [4.02, 'sine', 0.05]];
    const oscs = partials.map(([mult, type, g]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const gn = ctx.createGain();
      gn.gain.value = g;
      o.connect(gn).connect(filter);
      o.start(t);
      o.stop(t + 0.4 + decay);
      return o;
    });
    return {
      release(at) {
        const r = at ?? ctx.currentTime;
        out.gain.cancelScheduledValues(r);
        out.gain.setTargetAtTime(0.0001, r, 0.07);
        oscs.forEach(o => { try { o.stop(r + 0.5); } catch (e) { /* already stopped */ } });
      },
    };
  }

  // Fire-and-forget note of a given length (seconds of real time).
  play(midi, duration, vel = 0.8) {
    const v = this._voice(midi, vel);
    const ctx = this.ctx;
    v.release(ctx.currentTime + Math.max(0.08, duration));
  }

  noteOn(midi, vel = 0.8) {
    this.noteOff(midi);
    this.voices.set(midi, this._voice(midi, vel));
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (v) { v.release(); this.voices.delete(midi); }
  }

  allOff() { for (const m of [...this.voices.keys()]) this.noteOff(m); }
}
