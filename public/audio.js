// audio.js — tiny synthesized WebAudio blips. No audio assets.
// Only two sounds by design: shoot and hit.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    // iOS suspends the AudioContext when the tab is backgrounded, and this
    // game is played across several tabs, so it happens constantly. Resume
    // the moment the tab is visible / focused again, so the next shot
    // sounds instead of being silently dropped. Only resumes an existing
    // context — creation still waits for a user gesture (ensure()).
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.resume();
    });
    window.addEventListener('focus', () => this.resume());
  }

  // Resume a suspended context, if one exists. Cheap no-op when running.
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Must be called from a user gesture at least once (browser policy).
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
    }
    this.resume();
  }

  // volume: 1 for my own shots, lower for distant ones (0.12 floor).
  shoot(volume = 1) {
    // Resume first: a shot fired into a suspended context (tab was
    // backgrounded since the last gesture) is silently lost, which is
    // why shots sometimes sounded and sometimes didn't.
    this.ensure();
    if (!this.ctx) return;
    // Short burst of filtered noise: a rough "bang".
    const dur = 0.08;
    const buffer = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.9 * volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
  }

  hit() {
    this.ensure();
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.6, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.07);
    osc.connect(gain).connect(this.master);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.08);
  }
}
