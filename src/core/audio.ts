import type { AudioDef, DroneLayer } from '../content/types/biome';
import { clamp01 } from './math';

/**
 * Procedural audio.
 *
 * There are no audio files, for the same reason there are no image files: the
 * whole game has to be a single static bundle. Everything here is oscillators,
 * filtered noise and envelopes.
 *
 * Full generative music (key modulation, adaptive arrangement) is explicitly
 * out of scope — four layered oscillators plus a sparse pentatonic motif per
 * biome is about 95% of the perceived value at 5% of the cost.
 */

interface DroneVoice {
  nodes: AudioNode[];
  gain: GainNode;
}

const NOISE_SECONDS = 2;

export class AudioEngine {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private voices: DroneVoice[] = [];
  private motifTimer = 0;
  private motifNext = 3;
  private current: AudioDef | null = null;

  masterVolume = 0.7;
  sfxVolume = 0.8;
  musicVolume = 0.55;

  /** Nothing can start before a user gesture; browsers require it. */
  private started = false;

  get ready(): boolean {
    return this.started && this.ac !== null;
  }

  /** Call from the first pointerdown/keydown. Safe to call repeatedly. */
  unlock(): void {
    if (this.started) {
      void this.ac?.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ac = new Ctor();
    } catch {
      return;
    }

    this.master = this.ac.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.ac.destination);

    this.musicBus = this.ac.createGain();
    this.musicBus.gain.value = this.musicVolume;
    this.musicBus.connect(this.master);

    this.sfxBus = this.ac.createGain();
    this.sfxBus.gain.value = this.sfxVolume;
    this.sfxBus.connect(this.master);

    this.noiseBuffer = this.makeNoise();
    this.started = true;

    if (this.current) this.setBiome(this.current, true);
  }

  applyVolumes(master: number, sfx: number, music: number): void {
    this.masterVolume = clamp01(master);
    this.sfxVolume = clamp01(sfx);
    this.musicVolume = clamp01(music);
    if (this.master) this.master.gain.value = this.masterVolume;
    if (this.sfxBus) this.sfxBus.gain.value = this.sfxVolume;
    if (this.musicBus) this.musicBus.gain.value = this.musicVolume;
  }

  private makeNoise(): AudioBuffer | null {
    const ac = this.ac;
    if (!ac) return null;
    const len = ac.sampleRate * NOISE_SECONDS;
    const buffer = ac.createBuffer(1, len, ac.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly smoothed white noise: pure white is harsh at drone volumes.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.6 + white * 0.4;
      data[i] = last;
    }
    return buffer;
  }

  // ------------------------------------------------------------------ drone

  setBiome(def: AudioDef, force = false): void {
    if (!force && this.current === def) return;
    this.current = def;
    if (!this.started || !this.ac || !this.musicBus) return;

    this.stopDrone();

    const ac = this.ac;
    // Shared bus: a lowpass into a feedback delay. That delay is most of what
    // makes a handful of oscillators read as "a place" rather than "a tone".
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = def.bus.lpHz;

    const delay = ac.createDelay(1.5);
    delay.delayTime.value = def.bus.delayS;
    const feedback = ac.createGain();
    feedback.gain.value = def.bus.delayFeedback;
    const wet = ac.createGain();
    wet.gain.value = 0.5;

    lp.connect(this.musicBus);
    lp.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(this.musicBus);

    for (const layer of def.drone) {
      const voice = this.buildLayer(layer, lp);
      if (voice) this.voices.push(voice);
    }

    this.voices.push({ nodes: [lp, delay, feedback, wet], gain: wet });
    this.motifTimer = 0;
    this.motifNext = def.motif.intervalRange[0];
  }

  private buildLayer(layer: DroneLayer, dest: AudioNode): DroneVoice | null {
    const ac = this.ac;
    if (!ac) return null;

    const gain = ac.createGain();
    gain.gain.value = 0;
    // Fade in rather than clicking on.
    gain.gain.linearRampToValueAtTime(layer.gain, ac.currentTime + 1.5);

    const nodes: AudioNode[] = [gain];
    let source: AudioNode;

    if (layer.wave === 'noise') {
      if (!this.noiseBuffer) return null;
      const src = ac.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      src.start();
      source = src;
      nodes.push(src);
    } else {
      const osc = ac.createOscillator();
      osc.type = layer.wave;
      osc.frequency.value = layer.hz;
      if (layer.detune) osc.detune.value = layer.detune;
      osc.start();
      source = osc;
      nodes.push(osc);
    }

    let tail: AudioNode = source;
    if (layer.lpHz) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = layer.lpHz;
      tail.connect(f);
      tail = f;
      nodes.push(f);
    }
    tail.connect(gain);
    gain.connect(dest);

    // Slow amplitude wobble. This is what makes the fungal caves breathe.
    if (layer.lfoHz) {
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = layer.lfoHz;
      const depth = ac.createGain();
      depth.gain.value = layer.gain * (layer.lfoDepth ?? 0.5);
      lfo.connect(depth);
      depth.connect(gain.gain);
      lfo.start();
      nodes.push(lfo, depth);
    }

    return { nodes, gain };
  }

  private stopDrone(): void {
    const ac = this.ac;
    for (const v of this.voices) {
      try {
        if (ac) v.gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.4);
        for (const n of v.nodes) {
          const stoppable = n as AudioScheduledSourceNode;
          if (typeof stoppable.stop === 'function') {
            stoppable.stop(ac ? ac.currentTime + 0.5 : 0);
          }
        }
      } catch {
        // Already stopped; nothing to do.
      }
    }
    this.voices = [];
  }

  /** Sparse melodic layer. Driven from the game loop, in seconds. */
  update(dt: number): void {
    if (!this.started || !this.ac || !this.current) return;
    this.motifTimer += dt;
    if (this.motifTimer < this.motifNext) return;
    this.motifTimer = 0;

    const m = this.current.motif;
    const [lo, hi] = m.intervalRange;
    this.motifNext = lo + Math.random() * (hi - lo);

    const semi = m.scaleSemis[Math.floor(Math.random() * m.scaleSemis.length)];
    const octave = Math.random() < 0.3 ? 2 : 1;
    this.pluck(m.rootHz * Math.pow(2, semi / 12) * octave, m.decay, m.gain, m.wave);
  }

  private pluck(hz: number, decay: number, gain: number, wave: string): void {
    const ac = this.ac;
    const bus = this.musicBus;
    if (!ac || !bus) return;

    const osc = ac.createOscillator();
    osc.type = wave === 'noise' ? 'triangle' : (wave as OscillatorType);
    osc.frequency.value = hz;

    const env = ac.createGain();
    env.gain.value = 0;
    const now = ac.currentTime;
    env.gain.linearRampToValueAtTime(gain, now + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    osc.connect(env);
    env.connect(bus);
    osc.start(now);
    osc.stop(now + decay + 0.05);
  }

  // -------------------------------------------------------------------- sfx

  /** A filtered noise burst. The backbone of every impact sound. */
  private burst(bandHz: number, q: number, decay: number, gain: number): void {
    const ac = this.ac;
    const bus = this.sfxBus;
    if (!ac || !bus || !this.noiseBuffer) return;

    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = bandHz;
    filter.Q.value = q;

    const env = ac.createGain();
    const now = ac.currentTime;
    env.gain.value = 0;
    env.gain.linearRampToValueAtTime(gain, now + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    src.connect(filter);
    filter.connect(env);
    env.connect(bus);
    src.start(now, Math.random() * 1.5);
    src.stop(now + decay + 0.02);
  }

  private blip(hz: number, decay: number, gain: number, type: OscillatorType = 'square'): void {
    const ac = this.ac;
    const bus = this.sfxBus;
    if (!ac || !bus) return;

    const osc = ac.createOscillator();
    osc.type = type;
    const now = ac.currentTime;
    osc.frequency.setValueAtTime(hz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, hz * 0.5), now + decay);

    const env = ac.createGain();
    env.gain.value = 0;
    env.gain.linearRampToValueAtTime(gain, now + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    osc.connect(env);
    env.connect(bus);
    osc.start(now);
    osc.stop(now + decay + 0.02);
  }

  /** Biome-tinted, so the same action sounds different in the caves. */
  private tint(): { hitBandHz: number; killNoiseDecay: number; pitchBias: number } {
    return this.current?.sfxTint ?? { hitBandHz: 900, killNoiseDecay: 0.14, pitchBias: 0 };
  }

  hit(heavy: boolean): void {
    const t = this.tint();
    this.burst(t.hitBandHz * (heavy ? 0.7 : 1), 3, heavy ? 0.16 : 0.1, heavy ? 0.3 : 0.2);
    this.blip(180 * Math.pow(2, t.pitchBias / 12), 0.07, 0.09, 'triangle');
  }

  kill(): void {
    const t = this.tint();
    this.burst(t.hitBandHz * 0.55, 1.6, t.killNoiseDecay, 0.26);
  }

  hurt(): void {
    this.blip(220, 0.3, 0.28, 'sawtooth');
    this.burst(300, 1.2, 0.22, 0.2);
  }

  dash(): void {
    this.burst(2200, 0.8, 0.16, 0.12);
  }

  pickup(rarity: number): void {
    const base = 520 * Math.pow(2, rarity / 6);
    this.blip(base, 0.12, 0.12, 'sine');
    this.blip(base * 1.5, 0.16, 0.08, 'sine');
  }

  levelUp(): void {
    const root = 392;
    [0, 4, 7, 12].forEach((semi, i) => {
      setTimeout(() => this.blip(root * Math.pow(2, semi / 12), 0.28, 0.11, 'triangle'), i * 70);
    });
  }

  ui(up: boolean): void {
    this.blip(up ? 660 : 440, 0.07, 0.07, 'square');
  }

  descend(): void {
    this.blip(140, 0.7, 0.2, 'sine');
    this.burst(420, 1, 0.5, 0.16);
  }

  bossPhase(): void {
    this.blip(90, 0.9, 0.3, 'sawtooth');
    this.burst(700, 2, 0.6, 0.24);
  }

  death(): void {
    const root = 220;
    [0, -3, -7, -12].forEach((semi, i) => {
      setTimeout(() => this.blip(root * Math.pow(2, semi / 12), 0.5, 0.16, 'triangle'), i * 150);
    });
  }
}

export const audio = new AudioEngine();
