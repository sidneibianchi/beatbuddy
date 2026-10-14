/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PercussionSynthesizer, SoundParams } from './synthEngine';
import { SongPartId, SongProject } from '../types/rhythm';
import {
  saveSampleToStorage,
  getAllStoredSamples,
  deleteSampleFromStorage,
  renameSampleInStorage,
} from './sampleStorage';

export interface SchedulerCallback {
  onStep: (stepInfo: {
    partId: SongPartId;
    globalTick: number;
    beat: number; // 1, 2, 3, 4
    bar: number;
    subdivision: number; // 0, 1, 2, 3 in 16ths
    trackSteps: Record<string, number>; // trackId -> active step index
    isFill: boolean;
    isTransition: boolean;
  }) => void;
  onPedalStateChange: (state: {
    currentPart: SongPartId;
    basePart?: SongPartId;
    selectedStartPart?: SongPartId;
    activeFill: SongPartId | null;
    isTransitioning: boolean;
    activeTransition?: SongPartId | null;
    targetPart?: SongPartId | null;
    isOutro: boolean;
    isIntro?: boolean;
  }) => void;
  onPlaybackStateChange: (isPlaying: boolean) => void;
  onPartAutoAdvance?: (partId: SongPartId) => void;
  onSamplesUpdated?: (samples: Array<{ id: string; name: string }>) => void;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private synth: PercussionSynthesizer | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private customSamples: Map<string, { buffer: AudioBuffer; name: string }> = new Map();
  private rawAudioBuffers: Map<string, { arrayBuffer: ArrayBuffer; name: string }> = new Map();

  // Playback state
  private isPlaying: boolean = false;
  private bpm: number = 120;
  private swing: number = 0; // 0% - 50%
  private humanize: number = 0; // 0 - 100%
  private metronomeEnabled: boolean = false;

  // Clock & Scheduling
  private lookaheadMs: number = 25.0; // Interval frequency
  private scheduleAheadSec: number = 0.1; // Schedule window
  private nextStepTime: number = 0.0;
  private globalTick: number = 0;
  private timerId: number | null = null;

  // BeatBuddy Live Logic (Pedal 1 & Pedal 2)
  private currentPartId: SongPartId = 'verse';
  private basePartId: SongPartId = 'verse'; // The underlying active groove ('verse' or 'part_b')
  private selectedStartPart: SongPartId = 'verse'; // Selected part when stopped ('verse' or 'part_b')
  private targetPartId: SongPartId | null = null;
  private activeFillId: SongPartId | null = null;
  private fillEndTick: number | null = null;
  private activeTransitionId: SongPartId | null = null;
  private transitionEndTick: number | null = null;
  private isTransitioning: boolean = false;
  private isOutroPlaying: boolean = false;
  private outroEndTick: number | null = null;
  private isIntroPlaying: boolean = false;
  private introEndTick: number | null = null;
  private playIntroOnStart: boolean = true;

  // Active Project Reference
  private currentProject: SongProject | null = null;
  private callbacks: SchedulerCallback | null = null;

  constructor() {
    // Lazily init AudioContext upon user interaction
  }

  public init() {
    if (!this.ctx) {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass();
      this.synth = new PercussionSynthesizer(this.ctx);
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.85, this.ctx.currentTime);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.8;
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public getContext(): AudioContext | null {
    return this.ctx;
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  public setMasterVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.2, vol)), this.ctx.currentTime);
    }
  }

  public setMetronome(enabled: boolean) {
    this.metronomeEnabled = enabled;
  }

  public setCallbacks(cb: SchedulerCallback) {
    this.callbacks = cb;
  }

  public updateProject(project: SongProject) {
    this.currentProject = project;
    this.bpm = project.bpm;
    this.swing = project.swing;
    this.humanize = project.humanize;
  }

  public setBpm(bpm: number) {
    this.bpm = Math.max(40, Math.min(260, bpm));
  }

  public setSwing(swing: number) {
    this.swing = Math.max(0, Math.min(50, swing));
  }

  public setHumanize(humanize: number) {
    this.humanize = Math.max(0, Math.min(100, humanize));
  }

  // --- Sample Management with IndexedDB Persistence ---
  public registerCustomSample(id: string, name: string, buffer: AudioBuffer) {
    const rec = { buffer, name };
    this.customSamples.set(id, rec);
    this.customSamples.set(name, rec);
    const noExt = name.replace(/\.[^/.]+$/, '');
    this.customSamples.set(noExt, rec);
    const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    this.customSamples.set(clean, rec);
  }

  public async initPersistentSamples(): Promise<void> {
    try {
      const records = await getAllStoredSamples();
      if (!records || records.length === 0) {
        this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
        return;
      }
      this.init();
      for (const rec of records) {
        if (!this.customSamples.has(rec.id) && !this.customSamples.has(rec.name)) {
          try {
            const arrayBuffer = await rec.blob.arrayBuffer();
            this.rawAudioBuffers.set(rec.id, { arrayBuffer, name: rec.name });
            if (this.ctx && this.ctx.state !== 'suspended') {
              const audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
              this.registerCustomSample(rec.id, rec.name, audioBuffer);
            }
          } catch (e) {
            console.warn(`Failed to process stored sample "${rec.name}":`, e);
          }
        }
      }
      this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
    } catch (err) {
      console.error('Failed to restore samples from IndexedDB:', err);
    }
  }

  // Safe, fast audio decoding with modern Promise API and callback fallback (no blocking timeouts)
  public async decodeAudioDataSafe(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
    this.init();
    if (!this.ctx) throw new Error('No AudioContext');

    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {}
    }

    const copy = arrayBuffer.slice(0);
    try {
      const decoded = await this.ctx.decodeAudioData(copy);
      return decoded;
    } catch {
      return new Promise<AudioBuffer>((resolve, reject) => {
        try {
          this.ctx!.decodeAudioData(
            arrayBuffer.slice(0),
            (buf) => resolve(buf),
            (err) => reject(err || new Error('decodeAudioData callback failed'))
          );
        } catch (e) {
          reject(e);
        }
      });
    }
  }

  // Pre-load all samples directly from server into audio buffers for immediate playback on mobile & PC
  public async preloadAllServerSamples(): Promise<void> {
    try {
      this.init();
      let samples: Array<{ id: string; name: string; fileName?: string }> = [];

      // 1. Try server API
      try {
        const resp = await fetch('/api/samples');
        if (resp.ok) {
          const data = await resp.json();
          samples = data.samples || [];
        }
      } catch {}

      // 2. Fallback to static public/samples/index.json if API is unavailable
      if (samples.length === 0) {
        try {
          const staticResp = await fetch('/samples/index.json');
          if (staticResp.ok) {
            const list = await staticResp.json();
            samples = Array.isArray(list) ? list : (list.samples || []);
          }
        } catch {}
      }

      // Also gather any custom samples referenced in current project tracks
      if (this.currentProject?.tracks) {
        for (const t of this.currentProject.tracks) {
          if (t.customSampleId && !samples.some((s) => s.id === t.customSampleId)) {
            samples.push({
              id: t.customSampleId,
              name: t.customSampleName || t.name,
              fileName: `${t.customSampleId}.wav`,
            });
          }
        }
      }

      await Promise.all(
        samples.map(async (s) => {
          if (this.customSamples.has(s.id) || this.customSamples.has(s.name)) return;
          try {
            let audioResp: Response | null = null;
            const candidates = [
              `/api/samples/${encodeURIComponent(s.id)}/audio`,
              s.fileName ? `/samples/${encodeURIComponent(s.fileName)}` : null,
              `/samples/${encodeURIComponent(s.id)}.wav`,
              `/samples/${encodeURIComponent(s.name)}`,
            ].filter(Boolean) as string[];

            for (const url of candidates) {
              try {
                const r = await fetch(url);
                if (r.ok) {
                  audioResp = r;
                  break;
                }
              } catch {}
            }

            if (audioResp && audioResp.ok) {
              const arrayBuffer = await audioResp.arrayBuffer();
              this.rawAudioBuffers.set(s.id, { arrayBuffer, name: s.name });
              this.rawAudioBuffers.set(s.name, { arrayBuffer, name: s.name });
              try {
                const audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
                this.registerCustomSample(s.id, s.name, audioBuffer);
              } catch {
                // Saved in rawAudioBuffers, will decode on first touch gesture
              }
            }
          } catch (e) {
            console.warn(`Could not preload audio for "${s.name}":`, e);
          }
        })
      );
      this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
    } catch (err) {
      console.warn('Failed to preload server samples:', err);
    }
  }

  private loadingSampleIds = new Set<string>();

  public async fetchAndCacheRemoteSample(id: string, name?: string): Promise<AudioBuffer | null> {
    if (this.customSamples.has(id)) {
      return this.customSamples.get(id)!.buffer;
    }
    if (this.loadingSampleIds.has(id)) return null;
    this.loadingSampleIds.add(id);

    try {
      this.init();
      const urls = [
        `/api/samples/${encodeURIComponent(id)}/audio`,
        `/samples/${encodeURIComponent(id)}.wav`,
        name ? `/samples/${encodeURIComponent(name)}` : null,
      ].filter(Boolean) as string[];

      let audioResp: Response | null = null;
      for (const u of urls) {
        try {
          const r = await fetch(u);
          if (r.ok) {
            audioResp = r;
            break;
          }
        } catch {}
      }

      if (!audioResp || !audioResp.ok) return null;
      const arrayBuffer = await audioResp.arrayBuffer();
      this.rawAudioBuffers.set(id, { arrayBuffer, name: name || id });
      const audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
      this.registerCustomSample(id, name || id, audioBuffer);
      this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
      return audioBuffer;
    } catch {
      return null;
    } finally {
      this.loadingSampleIds.delete(id);
    }
  }

  /**
   * Intelligently resolves an AudioBuffer for a track:
   * 1. Direct ID match
   * 2. Name alias match (e.g. "ganza.wav", "pandeiro grave.wav")
   * 3. Decode pending raw buffers immediately
   * 4. Background fetch if missing
   */
  public getTrackAudioBuffer(
    customSampleId?: string,
    trackName?: string,
    customSampleName?: string
  ): AudioBuffer | undefined {
    // 1. Direct ID match
    if (customSampleId && this.customSamples.has(customSampleId)) {
      return this.customSamples.get(customSampleId)!.buffer;
    }
    // 2. Custom sample name match
    if (customSampleName && this.customSamples.has(customSampleName)) {
      return this.customSamples.get(customSampleName)!.buffer;
    }
    // 3. Track name match
    if (trackName && this.customSamples.has(trackName)) {
      return this.customSamples.get(trackName)!.buffer;
    }

    // 4. Check if raw audio buffer is pending decode and decode synchronously or queue
    const pendingKey = customSampleId || customSampleName || trackName;
    if (pendingKey && this.rawAudioBuffers.has(pendingKey)) {
      const raw = this.rawAudioBuffers.get(pendingKey)!;
      if (this.ctx && this.ctx.state !== 'suspended') {
        this.decodeAudioDataSafe(raw.arrayBuffer).then((buf) => {
          this.registerCustomSample(pendingKey, raw.name, buf);
        }).catch(() => {});
      }
    }

    const clean = (str: string) =>
      str
        .toLowerCase()
        .replace(/\.wav$/i, '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');

    const candidates = [
      customSampleName ? clean(customSampleName) : '',
      trackName ? clean(trackName) : '',
      customSampleId ? clean(customSampleId) : '',
    ].filter(Boolean);

    for (const [key, sRecord] of this.customSamples.entries()) {
      const cleanKey = clean(key);
      const cleanName = clean(sRecord.name);
      for (const target of candidates) {
        if (
          cleanKey === target ||
          cleanName === target ||
          (cleanKey.length > 2 && target.includes(cleanKey)) ||
          (cleanName.length > 2 && target.includes(cleanName)) ||
          (target.length > 2 && cleanKey.includes(target)) ||
          (target.length > 2 && cleanName.includes(target))
        ) {
          if (customSampleId && !this.customSamples.has(customSampleId)) {
            this.customSamples.set(customSampleId, sRecord);
          }
          return sRecord.buffer;
        }
      }
    }

    // Trigger async background fetch if missing
    if (customSampleId && !this.loadingSampleIds.has(customSampleId)) {
      this.fetchAndCacheRemoteSample(customSampleId, customSampleName || trackName);
    }

    return undefined;
  }

  public async unlockAudioContext(): Promise<void> {
    this.init();
    if (!this.ctx) return;
    try {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      // Play 1-sample silent node to truly unblock iOS hardware output
      const buffer = this.ctx.createBuffer(1, 1, 22050);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.ctx.destination);
      source.start(0);

      // Instantly decode all raw audio buffers that arrived while context was suspended
      if (this.rawAudioBuffers.size > 0) {
        await Promise.all(
          Array.from(this.rawAudioBuffers.entries()).map(async ([id, item]) => {
            if (!this.customSamples.has(id)) {
              try {
                const audioBuffer = await this.decodeAudioDataSafe(item.arrayBuffer);
                this.registerCustomSample(id, item.name, audioBuffer);
              } catch (e) {
                console.warn('Decode raw buffer error for', item.name, e);
              }
            }
          })
        );
        this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
      }
    } catch (e) {
      console.warn('AudioContext unlock attempt:', e);
    }
  }

  public async loadSampleFromBlob(blob: Blob, name: string, targetId?: string): Promise<string> {
    this.init();
    if (!this.ctx) throw new Error('AudioContext unavailable');
    const arrayBuffer = await blob.arrayBuffer();
    const id = targetId || `sample_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.rawAudioBuffers.set(id, { arrayBuffer, name });
    this.rawAudioBuffers.set(name, { arrayBuffer, name });

    try {
      const audioBuffer = await this.decodeAudioDataSafe(arrayBuffer);
      this.registerCustomSample(id, name, audioBuffer);
    } catch {
      // Will decode on unlock
    }

    // Persist to IndexedDB and cloud
    await saveSampleToStorage(id, name, blob);
    this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
    return id;
  }

  public async deleteCustomSample(id: string): Promise<boolean> {
    const rec = this.customSamples.get(id);
    const targetName = rec?.name;
    let deleted = this.customSamples.delete(id);
    for (const [key, val] of this.customSamples.entries()) {
      if (
        key === id ||
        (targetName && (val.name === targetName || key === targetName || key === targetName.replace(/\.wav$/i, '')))
      ) {
        this.customSamples.delete(key);
        deleted = true;
      }
    }
    await deleteSampleFromStorage(id);
    try {
      await fetch(`/api/samples/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (targetName && targetName !== id) {
        await fetch(`/api/samples/${encodeURIComponent(targetName)}`, { method: 'DELETE' });
      }
    } catch (e) {
      console.warn('Failed to delete sample from server:', e);
    }
    this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
    return deleted;
  }

  public renameCustomSample(id: string, newName: string): boolean {
    const existing = this.customSamples.get(id);
    if (!existing) return false;
    existing.name = newName;
    renameSampleInStorage(id, newName);
    this.callbacks?.onSamplesUpdated?.(this.getCustomSamplesList());
    return true;
  }

  public getCustomSamplesList(): Array<{ id: string; name: string }> {
    const seenNames = new Set<string>();
    const list: Array<{ id: string; name: string }> = [];
    this.customSamples.forEach((val, id) => {
      if (!seenNames.has(val.name)) {
        seenNames.add(val.name);
        list.push({ id, name: val.name });
      }
    });
    return list;
  }

  public getSubdivisionsPerBeat(): number {
    const res = this.currentProject?.resolution || '1/32';
    switch (res) {
      case '1/4':
        return 1;
      case '1/8':
        return 2;
      case '1/8T':
        return 3;
      case '1/16':
        return 4;
      case '1/16T':
        return 6;
      case '1/32':
        return 8;
      case '1/64':
        return 16;
      default:
        return 8; // Fusa (1/32) default
    }
  }

  public getStepsPerBar(): number {
    const subPerBeat = this.getSubdivisionsPerBeat();
    const timeSig = this.currentProject?.timeSignature || '4/4';
    if (timeSig === '2/4') return 2 * subPerBeat; // Traditional Samba / Choro / Marcha (2 beats per bar)
    if (timeSig === '3/4') return 3 * subPerBeat;
    if (timeSig === '6/8') return Math.max(6, Math.round(6 * (subPerBeat / 2)));
    if (timeSig === '7/8') return Math.max(7, Math.round(7 * (subPerBeat / 2)));
    if (timeSig === '5/4') return 5 * subPerBeat;
    if (timeSig === '12/8') return Math.max(12, Math.round(12 * (subPerBeat / 4)));
    return 4 * subPerBeat; // 4/4 default
  }

  // Direct trigger for pad auditioning
  public triggerInstrument(
    soundType: string,
    params: Partial<SoundParams> = {},
    customSampleId?: string,
    trackName?: string,
    trackCategory?: string
  ) {
    this.init();
    if (!this.ctx || !this.synth || !this.masterGain) return;
    const fullParams: SoundParams = {
      velocity: params.velocity ?? 100,
      tune: params.tune ?? 0,
      decay: params.decay ?? 1.0,
      tone: params.tone ?? 0.8,
      pan: params.pan ?? 0,
      volume: params.volume ?? 0.8,
      reverse: params.reverse ?? false,
    };
    const buffer = this.getTrackAudioBuffer(customSampleId, trackName, trackName);
    this.synth.playSound(
      soundType,
      this.masterGain,
      this.ctx.currentTime,
      fullParams,
      buffer,
      trackName,
      trackCategory
    );
  }

  // Instant pedal Accent hit (e.g. Crash cymbal)
  public triggerAccent() {
    this.init();
    if (!this.ctx || !this.synth || !this.masterGain || !this.currentProject) return;
    const accentSound = this.currentProject.accentSound || 'crash';
    this.synth.playSound(
      accentSound,
      this.masterGain,
      this.ctx.currentTime,
      {
        velocity: 125,
        tune: 0,
        decay: 1.2,
        tone: 0.9,
        pan: 0.2,
        volume: 0.9,
      }
    );
  }

  public setPlayIntroOnStart(enabled: boolean) {
    this.playIntroOnStart = enabled;
  }

  public getPlayIntroOnStart(): boolean {
    return this.playIntroOnStart;
  }

  public hasIntroNotes(): boolean {
    if (!this.currentProject?.parts?.intro?.trackSteps) return false;
    return Object.values(this.currentProject.parts.intro.trackSteps).some((steps) =>
      steps.some((s) => s.active)
    );
  }

  // --- BeatBuddy Live Pedal Actions ---
  // PEDAL 1:
  // IN STOP: TAP -> INTRO
  // IN PLAY: TAP -> FILL A / FILL B (Strict: Fill A only on Part A, Fill B only on Part B)
  // HOLD: ENDING (Outro)
  public handlePedal1Tap() {
    if (!this.isPlaying) {
      this.startWithIntro();
      return;
    }
    // If currently playing intro, tap can immediately advance to Parte A
    if (this.isIntroPlaying) {
      this.isIntroPlaying = false;
      this.introEndTick = null;
      this.currentPartId = this.basePartId || 'verse';
      this.notifyPedalState();
      this.callbacks?.onPartAutoAdvance?.(this.currentPartId);
      return;
    }
    // Trigger dynamic fill strictly matching the current base part
    if (!this.activeFillId && !this.isTransitioning && !this.isOutroPlaying) {
      if (this.basePartId === 'part_b') {
        this.triggerFill('fill_b');
      } else {
        this.triggerFill('fill_a');
      }
    }
  }

  // Legacy alias for Pedal 1 Tap
  public handlePedalTap() {
    this.handlePedal1Tap();
  }

  // PEDAL 1 HOLD: ENDING
  public handlePedal1HoldStart() {
    if (!this.isPlaying || this.isOutroPlaying) return;
    this.triggerOutro();
  }

  // Legacy alias for Pedal 1 Hold
  public handlePedalHoldStart() {
    this.handlePedal1HoldStart();
  }

  public handlePedalHoldEnd() {
    // In new spec, holding pedal 1 triggers ending, no action required on release
  }

  // PEDAL 2:
  // IN STOP: TAP -> Alterna PARTE A / PARTE B
  // IN PLAY: TAP -> TRANSIÇÃO A -> B / TRANSIÇÃO B -> A
  public handlePedal2Tap() {
    if (!this.isPlaying) {
      // Toggle selected start part between Parte A and Parte B
      this.selectedStartPart = this.selectedStartPart === 'verse' ? 'part_b' : 'verse';
      this.basePartId = this.selectedStartPart;
      this.currentPartId = this.selectedStartPart;
      this.notifyPedalState();
      this.callbacks?.onPartAutoAdvance?.(this.currentPartId);
      return;
    }

    // In Play: Transition from A -> B or B -> A
    if (!this.isTransitioning && !this.isOutroPlaying) {
      if (this.basePartId === 'part_b') {
        // Transition B -> A
        this.triggerTransition('transition_b_a', 'verse');
      } else {
        // Transition A -> B
        this.triggerTransition('transition_a_b', 'part_b');
      }
    }
  }

  // Trigger Fill (Fill A or Fill B) with bar quantization
  public triggerFill(fillId: SongPartId = 'fill_a') {
    if (!this.isPlaying) return;
    this.activeFillId = fillId;
    const subPerBar = this.getStepsPerBar();
    const curSubInBar = this.globalTick % subPerBar;
    // If tapped late in the bar (last 25% of measure), extend fill to next bar
    if (curSubInBar >= Math.floor(subPerBar * 0.75)) {
      this.fillEndTick = this.globalTick + (subPerBar - curSubInBar) + subPerBar;
    } else {
      this.fillEndTick = this.globalTick + (subPerBar - curSubInBar);
    }
    this.notifyPedalState();
  }

  // Trigger Transition (A->B or B->A)
  public triggerTransition(transitionId: SongPartId = 'transition_a_b', targetPart: SongPartId = 'part_b') {
    if (!this.isPlaying) return;
    this.isTransitioning = true;
    this.activeTransitionId = transitionId;
    this.targetPartId = targetPart;
    this.activeFillId = null;
    const subPerBar = this.getStepsPerBar();
    const curSubInBar = this.globalTick % subPerBar;
    if (curSubInBar >= Math.floor(subPerBar * 0.75)) {
      this.transitionEndTick = this.globalTick + (subPerBar - curSubInBar) + subPerBar;
    } else {
      this.transitionEndTick = this.globalTick + (subPerBar - curSubInBar);
    }
    this.notifyPedalState();
  }

  // Trigger Outro (Ending)
  public triggerOutro() {
    if (!this.isPlaying || this.isOutroPlaying) return;
    this.isOutroPlaying = true;
    this.activeFillId = null;
    this.isTransitioning = false;
    this.activeTransitionId = null;
    const subPerBar = this.getStepsPerBar();
    const curSubInBar = this.globalTick % subPerBar;
    // 1 bar outro length
    this.outroEndTick = this.globalTick + (subPerBar - curSubInBar) + subPerBar;
    this.notifyPedalState();
  }

  // Legacy double-tap alias
  public handlePedalDoubleTap() {
    this.triggerOutro();
  }

  public selectPart(partId: SongPartId) {
    this.currentPartId = partId;
    if (partId === 'verse' || partId === 'part_b') {
      this.basePartId = partId;
      this.selectedStartPart = partId;
    }
    this.isIntroPlaying = partId === 'intro';
    this.activeFillId = null;
    this.isTransitioning = false;
    this.activeTransitionId = null;
    this.isOutroPlaying = partId === 'outro';
    this.notifyPedalState();
  }

  public getCurrentPartId(): SongPartId {
    return this.currentPartId;
  }

  public getBasePartId(): SongPartId {
    return this.basePartId;
  }

  public getSelectedStartPart(): SongPartId {
    return this.selectedStartPart;
  }

  public setSelectedStartPart(partId: SongPartId) {
    this.selectedStartPart = partId;
    this.basePartId = partId;
    this.currentPartId = partId;
    this.notifyPedalState();
  }

  public getIntroFullBarSteps(): number {
    const stepsPerBar = this.getStepsPerBar();
    const projBars = this.currentProject?.barsCount || 1;
    const baseSteps = stepsPerBar * projBars;
    const introCounts = this.currentProject?.parts?.intro?.trackStepCounts;
    if (introCounts && Object.values(introCounts).length > 0) {
      const maxCount = Math.max(...Object.values(introCounts));
      const barsNeeded = Math.max(projBars, Math.ceil(maxCount / stepsPerBar));
      return barsNeeded * stepsPerBar;
    }
    return baseSteps;
  }

  // Helper to look up part data with backward compatible aliases
  public getPartData(partId: SongPartId): SongProject['parts'][SongPartId] | undefined {
    if (!this.currentProject?.parts) return undefined;
    const parts = this.currentProject.parts as Record<string, unknown>;
    if (parts[partId]) return parts[partId] as SongProject['parts'][SongPartId];

    // Aliases
    if (partId === 'part_b') {
      return (parts['part_b'] || parts['chorus'] || parts['prechorus']) as SongProject['parts'][SongPartId];
    }
    if (partId === 'fill_a') {
      return (parts['fill_a'] || parts['fill1']) as SongProject['parts'][SongPartId];
    }
    if (partId === 'fill_b') {
      return (parts['fill_b'] || parts['fill2']) as SongProject['parts'][SongPartId];
    }
    if (partId === 'transition_a_b') {
      return (parts['transition_a_b'] || parts['transition']) as SongProject['parts'][SongPartId];
    }
    if (partId === 'transition_b_a') {
      return parts['transition_b_a'] as SongProject['parts'][SongPartId];
    }
    if (partId === 'verse') {
      return (parts['verse'] || parts['part_a']) as SongProject['parts'][SongPartId];
    }
    if (partId === 'intro') {
      return parts['intro'] as SongProject['parts'][SongPartId];
    }
    if (partId === 'outro') {
      return parts['outro'] as SongProject['parts'][SongPartId];
    }

    return parts['verse'] as SongProject['parts'][SongPartId];
  }

  // --- Playback Engine ---
  public async startWithIntro() {
    this.init();
    if (!this.ctx) return;
    if (this.isPlaying) return;

    if (this.ctx.state === 'suspended') {
      await this.unlockAudioContext();
    }

    this.isPlaying = true;
    this.globalTick = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;

    this.currentPartId = 'intro';
    this.isIntroPlaying = true;
    this.introEndTick = this.getIntroFullBarSteps();
    this.basePartId = this.selectedStartPart || 'verse';

    this.callbacks?.onPlaybackStateChange(true);
    this.notifyPedalState();
    this.timerId = window.setInterval(() => {
      this.scheduler();
    }, this.lookaheadMs);
  }

  public async start(forceIntro: boolean = true) {
    this.init();
    if (!this.ctx) return;
    if (this.isPlaying) return;

    if (this.ctx.state === 'suspended') {
      await this.unlockAudioContext();
    }

    this.isPlaying = true;
    this.globalTick = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;

    const hasIntro = this.hasIntroNotes();
    const shouldPlayIntro =
      (forceIntro && this.playIntroOnStart && hasIntro) ||
      (this.currentPartId === 'intro' && hasIntro);

    if (shouldPlayIntro) {
      this.currentPartId = 'intro';
      this.isIntroPlaying = true;
      this.introEndTick = this.getIntroFullBarSteps();
    } else {
      this.currentPartId = this.selectedStartPart || 'verse';
      this.basePartId = this.currentPartId;
      this.isIntroPlaying = false;
      this.introEndTick = null;
    }

    this.callbacks?.onPlaybackStateChange(true);
    this.notifyPedalState();
    this.timerId = window.setInterval(() => {
      this.scheduler();
    }, this.lookaheadMs);
  }

  public stop() {
    this.isPlaying = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.globalTick = 0;
    this.activeFillId = null;
    this.fillEndTick = null;
    this.isTransitioning = false;
    this.activeTransitionId = null;
    this.targetPartId = null;
    this.transitionEndTick = null;
    this.isOutroPlaying = false;
    this.outroEndTick = null;
    this.isIntroPlaying = false;
    this.introEndTick = null;
    this.currentPartId = this.selectedStartPart || 'verse';
    this.basePartId = this.currentPartId;
    this.callbacks?.onPlaybackStateChange(false);
    this.notifyPedalState();
  }

  public togglePlay() {
    if (this.isPlaying) {
      this.stop();
    } else {
      this.start();
    }
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  private notifyPedalState() {
    this.callbacks?.onPedalStateChange({
      currentPart: this.currentPartId,
      basePart: this.basePartId,
      selectedStartPart: this.selectedStartPart,
      activeFill: this.activeFillId,
      isTransitioning: this.isTransitioning,
      activeTransition: this.activeTransitionId,
      targetPart: this.targetPartId,
      isOutro: this.isOutroPlaying,
      isIntro: this.isIntroPlaying,
    });
  }

  private scheduler() {
    if (!this.ctx || !this.isPlaying || !this.currentProject) return;
    if (this.nextStepTime < this.ctx.currentTime) {
      this.nextStepTime = this.ctx.currentTime + 0.03;
    }
    while (this.nextStepTime < this.ctx.currentTime + this.scheduleAheadSec) {
      this.scheduleStep(this.globalTick, this.nextStepTime);
      this.advanceStep();
    }
  }

  private advanceStep() {
    const subPerBeat = this.getSubdivisionsPerBeat();
    const secondsPerStep = 60.0 / this.bpm / subPerBeat;

    const isOddStep = this.globalTick % 2 === 1;
    let stepDelta = secondsPerStep;
    if (this.swing > 0) {
      const swingRatio = (this.swing / 100) * 0.33;
      if (isOddStep) {
        stepDelta += secondsPerStep * swingRatio;
      } else {
        stepDelta -= secondsPerStep * swingRatio;
      }
    }
    this.nextStepTime += Math.max(0.005, stepDelta);
    this.globalTick++;

    // Fill completion
    if (this.activeFillId && this.fillEndTick !== null && this.globalTick >= this.fillEndTick) {
      this.activeFillId = null;
      this.fillEndTick = null;
      this.currentPartId = this.basePartId;
      this.notifyPedalState();
    }

    // Transition completion
    if (this.isTransitioning && this.transitionEndTick !== null && this.globalTick >= this.transitionEndTick) {
      this.isTransitioning = false;
      this.activeTransitionId = null;
      this.transitionEndTick = null;
      if (this.targetPartId) {
        this.currentPartId = this.targetPartId;
        this.basePartId = this.targetPartId;
        this.targetPartId = null;
      }
      this.notifyPedalState();
      this.callbacks?.onPartAutoAdvance?.(this.currentPartId);
    }

    // Intro completion
    if (this.isIntroPlaying && this.introEndTick !== null && this.globalTick >= this.introEndTick) {
      this.isIntroPlaying = false;
      this.introEndTick = null;
      this.currentPartId = this.basePartId || 'verse';
      this.notifyPedalState();
      this.callbacks?.onPartAutoAdvance?.(this.currentPartId);
    }

    // Outro completion
    if (this.isOutroPlaying && this.outroEndTick !== null && this.globalTick >= this.outroEndTick) {
      this.isOutroPlaying = false;
      this.outroEndTick = null;
      this.stop();
    }
  }

  private scheduleStep(tick: number, time: number) {
    if (!this.ctx || !this.synth || !this.masterGain || !this.currentProject) return;

    let effectivePartId: SongPartId = this.basePartId;
    if (this.isOutroPlaying) {
      effectivePartId = 'outro';
    } else if (this.isTransitioning && this.activeTransitionId) {
      effectivePartId = this.activeTransitionId;
    } else if (this.activeFillId) {
      effectivePartId = this.activeFillId;
    } else if (this.isIntroPlaying) {
      effectivePartId = 'intro';
    } else {
      effectivePartId = this.currentPartId;
    }

    const partData = this.getPartData(effectivePartId) || this.getPartData('verse')!;
    if (!partData) return;
    const trackStepsMap: Record<string, number> = {};

    let timeWithHumanize = time;
    if (this.humanize > 0) {
      const jitterMs = ((Math.random() - 0.5) * 2 * (this.humanize / 100) * 18) / 1000;
      timeWithHumanize += jitterMs;
    }

    const subPerBeat = this.getSubdivisionsPerBeat();
    const stepsPerBar = this.getStepsPerBar();
    const isQuarterBeat = tick % subPerBeat === 0;
    const beatIndex = Math.floor((tick % stepsPerBar) / subPerBeat) + 1;
    const barIndex = Math.floor(tick / stepsPerBar) + 1;

    if (this.metronomeEnabled && isQuarterBeat) {
      this.scheduleMetronomeClick(time, beatIndex === 1);
    }

    const anySolo = this.currentProject.tracks.some((t) => t.solo);

    this.currentProject.tracks.forEach((trackDef) => {
      if (trackDef.muted) return;
      if (anySolo && !trackDef.solo) return;

      const trackSteps = partData.trackSteps[trackDef.id] || [];
      const globalCycleSteps = stepsPerBar * (this.currentProject?.barsCount || 1);
      const trackStepCount =
        partData.trackStepCounts?.[trackDef.id] ||
        globalCycleSteps ||
        trackSteps.length ||
        16;

      if (trackStepCount === 0) return;
      const stepIndex = tick % trackStepCount;
      trackStepsMap[trackDef.id] = stepIndex;

      const step =
        trackSteps[stepIndex] ??
        (trackSteps.length > 0 ? trackSteps[stepIndex % trackSteps.length] : undefined);

      if (step && step.active) {
        if (step.probability < 1.0 && Math.random() > step.probability) {
          return;
        }

        const ratchet = Math.max(1, step.ratchet || 1);
        const stepDur = 60.0 / this.bpm / subPerBeat;
        const subInterval = stepDur / ratchet;

        const buffer: AudioBuffer | undefined = this.getTrackAudioBuffer(
          trackDef.customSampleId,
          trackDef.name,
          trackDef.customSampleName
        );

        for (let r = 0; r < ratchet; r++) {
          const hitTime = timeWithHumanize + r * subInterval;
          const hitVelocity = r === 0 ? step.velocity : Math.floor(step.velocity * 0.85);
          const soundParams: SoundParams = {
            velocity: hitVelocity,
            tune: trackDef.tune + (step.pitchOffset || 0),
            decay: trackDef.decay,
            tone: trackDef.tone,
            pan: trackDef.pan,
            volume: trackDef.volume,
            reverse: trackDef.reverse,
          };
          this.synth?.playSound(
            trackDef.soundType,
            this.masterGain!,
            hitTime,
            soundParams,
            buffer,
            trackDef.name,
            trackDef.category
          );
        }
      }
    });

    if (this.callbacks) {
      const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (!this.isPlaying) return;
        this.callbacks?.onStep({
          partId: effectivePartId,
          globalTick: tick,
          beat: beatIndex,
          bar: barIndex,
          subdivision: tick % 4,
          trackSteps: trackStepsMap,
          isFill: Boolean(this.activeFillId),
          isTransition: this.isTransitioning,
        });
      }, delay);
    }
  }

  private scheduleMetronomeClick(time: number, isDownbeat: boolean) {
    if (!this.ctx || !this.masterGain) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1800 : 1200, time);
    gain.gain.setValueAtTime(isDownbeat ? 0.4 : 0.2, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(time);
    osc.stop(time + 0.035);
  }

  // --- Export Loop / Song to WAV Audio File ---
  public async exportToWav(barsToRender: number = 4): Promise<Blob> {
    if (!this.currentProject) throw new Error('No project active');
    const sampleRate = 44100;
    const beatsPerBar = 4;
    const secondsPerBeat = 60 / this.bpm;
    const totalDuration = barsToRender * beatsPerBar * secondsPerBeat + 1.0;
    const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
    const offlineSynth = new PercussionSynthesizer(offlineCtx as unknown as AudioContext);
    const offlineMaster = offlineCtx.createGain();
    offlineMaster.gain.setValueAtTime(0.9, 0);
    offlineMaster.connect(offlineCtx.destination);

    const partData =
      this.currentProject.parts[this.currentPartId] || this.currentProject.parts['verse'];
    const totalTicks = barsToRender * 16;
    const secondsPer16th = 60.0 / this.bpm / 4.0;

    for (let tick = 0; tick < totalTicks; tick++) {
      let tickTime = tick * secondsPer16th;
      if (this.swing > 0 && tick % 2 === 1) {
        tickTime += secondsPer16th * (this.swing / 100) * 0.33;
      }

      this.currentProject.tracks.forEach((trackDef) => {
        if (trackDef.muted) return;
        const steps = partData.trackSteps[trackDef.id] || [];
        const stepCount = partData.trackStepCounts?.[trackDef.id] || steps.length || 16;
        if (stepCount === 0) return;
        const stepIdx = tick % stepCount;
        const step = steps[stepIdx];
        if (step && step.active) {
          const ratchet = Math.max(1, step.ratchet || 1);
          const subInterval = secondsPer16th / ratchet;
          let buffer: AudioBuffer | undefined;
          if (trackDef.customSampleId && this.customSamples.has(trackDef.customSampleId)) {
            buffer = this.customSamples.get(trackDef.customSampleId)?.buffer;
          }
          for (let r = 0; r < ratchet; r++) {
            const hitTime = tickTime + r * subInterval;
            const soundParams: SoundParams = {
              velocity: r === 0 ? step.velocity : Math.floor(step.velocity * 0.85),
              tune: trackDef.tune + (step.pitchOffset || 0),
              decay: trackDef.decay,
              tone: trackDef.tone,
              pan: trackDef.pan,
              volume: trackDef.volume,
              reverse: trackDef.reverse,
            };
            offlineSynth.playSound(
              trackDef.soundType,
              offlineMaster,
              hitTime,
              soundParams,
              buffer
            );
          }
        }
      });
    }

    const renderedBuffer = await offlineCtx.startRendering();
    return audioBufferToWavBlob(renderedBuffer);
  }
}

function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const length = buffer.length * blockAlign;
  const bufferLength = 44 + length;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, length, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export const audioEngine = new AudioEngine();
