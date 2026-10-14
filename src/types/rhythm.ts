/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TimeSignature = '2/4' | '4/4' | '3/4' | '6/8' | '7/8' | '5/4' | '12/8';

export type SongPartId =
  | 'intro' // Intro
  | 'verse' // Parte A
  | 'part_b' // Parte B
  | 'prechorus'
  | 'chorus'
  | 'bridge'
  | 'fill1'
  | 'fill2'
  | 'fill3'
  | 'fill_a' // Fill A
  | 'fill_b' // Fill B
  | 'transition'
  | 'transition_a_b' // Transição A -> B
  | 'transition_b_a' // Transição B -> A
  | 'transition_b_c'
  | 'transition_c_b'
  | 'transition_c_a'
  | 'outro' // End
  | (string & {});

export type InstrumentCategory =
  | 'kick'
  | 'snare'
  | 'hihat'
  | 'latin'
  | 'brazilian'
  | 'percussion'
  | 'cymbals'
  | 'custom';

export interface StepData {
  active: boolean;
  velocity: number; // 1-127 (accent: 120+, normal: 90, soft: 50)
  probability: number; // 0.0 - 1.0 (default 1.0)
  ratchet: number; // 1 (single), 2 (flam/double), 3 (triplet roll), 4 (quad roll)
  pitchOffset?: number; // -12 to +12 semitones
}

export interface TrackDefinition {
  id: string;
  name: string;
  category: InstrumentCategory;
  soundType: string;
  color: string;
  volume: number; // 0.0 to 1.0
  pan: number; // -1.0 to 1.0
  tune: number; // -12 to 12
  decay: number; // 0.1 to 3.0
  tone: number; // 0.0 to 1.0 (filter brightness)
  muted: boolean;
  solo: boolean;
  reverse?: boolean;
  customSampleName?: string;
  customSampleId?: string; // key in audio sample registry
}

export interface Track extends TrackDefinition {
  steps: StepData[];
  stepCount: number; // Allows polyrhythms / polymeter
}

export interface SongPartData {
  id: SongPartId;
  name: string;
  description: string;
  trackSteps: Record<string, StepData[]>; // trackId -> steps
  trackStepCounts?: Record<string, number>; // trackId -> custom length
}

export type RhythmicResolution = '1/4' | '1/8' | '1/8T' | '1/16' | '1/16T' | '1/32' | '1/64';

export interface SongProject {
  id: string;
  name: string;
  genre: string;
  bpm: number;
  timeSignature: TimeSignature;
  resolution?: RhythmicResolution;
  barsCount?: number;
  swing: number; // 0% to 50%
  humanize: number; // 0 to 100% micro-timing offset
  accentSound: string; // instrument sound for accent pedal
  tracks: TrackDefinition[];
  parts: Record<string, SongPartData>;
  defaultStepCount: number;
}

export type PlaybackStatus = 'stopped' | 'playing' | 'paused';
export type PedalStatus = 'idle' | 'main' | 'fill' | 'transition' | 'outro';
