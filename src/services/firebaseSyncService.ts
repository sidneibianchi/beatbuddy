/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Firebase Auth & Cloud Firestore synchronization service for BeatBuddy Studio.
 * Synchronizes custom rhythms and percussion audio samples between PC and Mobile devices.
 */

import {
  auth,
  db,
  googleProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
  doc,
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  handleFirestoreError,
  OperationType,
  testConnection,
} from '../firebase';
import { SongProject } from '../types/rhythm';
import {
  StoredSampleRecord,
  saveSampleToStorage,
  getAllStoredSamples,
  blobToBase64,
} from '../audio/sampleStorage';
import { audioEngine } from '../audio/AudioEngine';
import { userCreatedSambaProject } from '../presets/groovePresets';

export interface FirebaseSyncStatus {
  user: User | null;
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  error: string | null;
}

export interface CloudSampleDoc {
  id: string;
  userId: string;
  name: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  audioBase64?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

const CORE_STUDIO_SAMPLES = [
  { id: 'sample_1791928977387_ssxqu', name: 'pandeiro grave.wav', fileName: 'sample_1791928977387_ssxqu.wav' },
  { id: 'sample_1791928977720_5b722', name: 'pandeiro tapa.wav', fileName: 'sample_1791928977720_5b722.wav' },
  { id: 'sample_1791929097159_2w8rm', name: 'ganza.wav', fileName: 'sample_1791929097159_2w8rm.wav' },
  { id: 'sample_1791929185450_q4cv7', name: 'tamborim grave.wav', fileName: 'sample_1791929185450_q4cv7.wav' },
  { id: 'sample_1791929249766_4ddn2', name: 'ovinho agudo.wav', fileName: 'sample_1791929249766_4ddn2.wav' },
  { id: 'sample_1791929293573_w07zv', name: 'kickdrum9.wav', fileName: 'sample_1791929293573_w07zv.wav' },
  { id: 'sample_1791929472468_l6qxe', name: 'GRAVE SD.wav', fileName: 'sample_1791929472468_l6qxe.wav' },
  { id: 'sample_1791929483367_ii2ay', name: 'GRAVE 2 SD.wav', fileName: 'sample_1791929483367_ii2ay.wav' },
];

// Helper to convert base64 data to Blob
export function base64ToBlob(base64: string, mimeType = 'audio/wav'): Blob {
  const cleanBase64 = base64.replace(/^data:audio\/[^;]+;base64,/, '');
  const byteCharacters = atob(cleanBase64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

export class FirebaseSyncService {
  private currentUser: User | null = null;
  private listeners: Array<(status: FirebaseSyncStatus) => void> = [];
  private isLoading = true;
  private isSyncing = false;
  private lastSyncedAt: number | null = null;
  private lastError: string | null = null;

  constructor() {
    this.init();
  }

  private async init() {
    try {
      await testConnection();
    } catch (e) {
      console.warn('Initial connection check note:', e);
    }

    onAuthStateChanged(auth, async (user) => {
      this.currentUser = user;
      this.isLoading = false;
      this.notify();

      if (user) {
        // Auto-sync upon login
        try {
          await this.syncAll(user);
        } catch (err) {
          console.error('Error during auto-sync:', err);
        }
      }
    });
  }

  public subscribe(cb: (status: FirebaseSyncStatus) => void): () => void {
    this.listeners.push(cb);
    cb(this.getStatus());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private notify() {
    const status = this.getStatus();
    this.listeners.forEach((cb) => cb(status));
  }

  public getStatus(): FirebaseSyncStatus {
    return {
      user: this.currentUser,
      isLoading: this.isLoading,
      isSyncing: this.isSyncing,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
    };
  }

  public async loginWithGoogle(): Promise<User> {
    this.lastError = null;
    try {
      const res = await signInWithPopup(auth, googleProvider);
      const user = res.user;

      // Update user document in Firestore
      const userPath = `users/${user.uid}`;
      try {
        await setDoc(
          doc(db, 'users', user.uid),
          {
            id: user.uid,
            email: user.email || '',
            displayName: user.displayName || 'Musician',
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, userPath);
      }

      await this.syncAll(user);
      return user;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Falha ao conectar com o Google';
      this.notify();
      throw err;
    }
  }

  public async logout(): Promise<void> {
    try {
      await signOut(auth);
      this.currentUser = null;
      this.notify();
    } catch (err) {
      console.error('Logout error:', err);
      throw err;
    }
  }

  /**
   * Syncs the Global Studio Library from Firestore (Accessible by all devices without login)
   * This guarantees that mobile, desktop and tablet always have the EXACT same audio samples and rhythms!
   */
  public async syncStudioLibrary(): Promise<{ samplesCount: number; rhythmsCount: number }> {
    this.isSyncing = true;
    this.lastError = null;
    this.notify();

    let samplesCount = 0;
    let rhythmsCount = 0;

    try {
      // 1. Fetch all Studio Samples from Firestore
      const studioSamplesCol = collection(db, 'studio_samples');
      const studioSamplesSnap = await getDocs(studioSamplesCol);
      const cloudSampleDocs: CloudSampleDoc[] = [];

      studioSamplesSnap.forEach((d) => {
        cloudSampleDocs.push(d.data() as CloudSampleDoc);
      });

      const localSamples = await getAllStoredSamples();
      const localSampleIds = new Set(localSamples.map((s) => s.id));
      const localSampleNames = new Set(localSamples.map((s) => s.name));

      // Restore samples from Cloud Firestore to device IndexedDB & AudioEngine
      for (const cs of cloudSampleDocs) {
        if (cs.audioBase64) {
          try {
            const blob = base64ToBlob(cs.audioBase64, cs.mimeType || 'audio/wav');
            if (!localSampleIds.has(cs.id)) {
              await saveSampleToStorage(cs.id, cs.name, blob);
            }
            await audioEngine.loadSampleFromBlob(blob, cs.name, cs.id);
          } catch (e) {
            console.warn(`Failed to restore studio sample "${cs.name}":`, e);
          }
        }
      }

      // Check if any of the core percussion samples (pandeiro, ganza, surdo, etc.) need to be seeded to Firestore
      const cloudSampleIds = new Set(cloudSampleDocs.map((s) => s.id));
      for (const core of CORE_STUDIO_SAMPLES) {
        if (!cloudSampleIds.has(core.id)) {
          try {
            const resp = await fetch(`/samples/${encodeURIComponent(core.fileName)}`);
            if (resp.ok) {
              const blob = await resp.blob();
              const base64 = await blobToBase64(blob);
              await setDoc(
                doc(db, 'studio_samples', core.id),
                {
                  id: core.id,
                  userId: 'studio',
                  name: core.name,
                  filename: core.fileName,
                  mimeType: 'audio/wav',
                  size: blob.size,
                  audioBase64: base64,
                  url: `/samples/${core.fileName}`,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
              // Also ensure loaded locally
              if (!localSampleIds.has(core.id)) {
                await saveSampleToStorage(core.id, core.name, blob);
              }
              await audioEngine.loadSampleFromBlob(blob, core.name, core.id);
            }
          } catch (e) {
            console.warn(`Could not seed core sample ${core.name} to Firestore:`, e);
          }
        }
      }

      // Also upload any locally created sample that Cloud does not have yet
      for (const ls of localSamples) {
        if (!cloudSampleIds.has(ls.id)) {
          try {
            await this.saveSampleRecord(ls, null);
          } catch (e) {
            console.warn(`Failed to upload local sample ${ls.name} to Firestore studio_samples:`, e);
          }
        }
      }

      samplesCount = Math.max(cloudSampleDocs.length, localSamples.length);

      // 2. Fetch all Studio Rhythms from Firestore
      const studioRhythmsCol = collection(db, 'studio_rhythms');
      const studioRhythmsSnap = await getDocs(studioRhythmsCol);
      const cloudRhythms: SongProject[] = [];

      studioRhythmsSnap.forEach((d) => {
        cloudRhythms.push(d.data() as SongProject);
      });

      // If cloud is missing Samba preset, seed it
      if (cloudRhythms.length === 0 && userCreatedSambaProject) {
        await this.saveRhythm(userCreatedSambaProject, null);
        cloudRhythms.push(userCreatedSambaProject);
      }

      // Merge rhythms into localStorage
      let localRhythms: SongProject[] = [];
      try {
        const stored = localStorage.getItem('beatbuddy_rhythms');
        if (stored) localRhythms = JSON.parse(stored);
      } catch {}

      const rhythmMap = new Map<string, SongProject>();
      for (const cr of cloudRhythms) {
        rhythmMap.set(cr.id, cr);
      }
      for (const lr of localRhythms) {
        if (!rhythmMap.has(lr.id)) {
          rhythmMap.set(lr.id, lr);
          await this.saveRhythm(lr, null);
        }
      }

      const merged = Array.from(rhythmMap.values());
      rhythmsCount = merged.length;
      if (merged.length > 0) {
        localStorage.setItem('beatbuddy_rhythms', JSON.stringify(merged));
      }

      this.lastSyncedAt = Date.now();
    } catch (err) {
      console.warn('Studio library sync error:', err);
    } finally {
      this.isSyncing = false;
      this.notify();
    }

    return { samplesCount, rhythmsCount };
  }

  /**
   * Complete bidirectional sync between Firestore cloud and device storage (PC or Mobile)
   */
  public async syncAll(user = this.currentUser): Promise<{
    rhythmsCount: number;
    samplesCount: number;
  }> {
    // First sync the shared studio library
    await this.syncStudioLibrary();

    if (!user) return { rhythmsCount: 0, samplesCount: 0 };

    this.isSyncing = true;
    this.lastError = null;
    this.notify();

    let rhythmsCount = 0;
    let samplesCount = 0;

    try {
      // 1. SYNC USER RHYTHMS
      const rhythmsColPath = `users/${user.uid}/rhythms`;
      let cloudRhythms: SongProject[] = [];
      try {
        const querySnapshot = await getDocs(collection(db, 'users', user.uid, 'rhythms'));
        querySnapshot.forEach((d) => {
          cloudRhythms.push(d.data() as SongProject);
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, rhythmsColPath);
      }

      let localRhythms: SongProject[] = [];
      try {
        const stored = localStorage.getItem('beatbuddy_rhythms');
        if (stored) localRhythms = JSON.parse(stored);
      } catch {}

      const rhythmMap = new Map<string, SongProject>();
      for (const r of cloudRhythms) {
        rhythmMap.set(r.id, r);
      }

      for (const lr of localRhythms) {
        if (!rhythmMap.has(lr.id)) {
          rhythmMap.set(lr.id, lr);
          await this.saveRhythm(lr, user);
        }
      }

      const mergedRhythms = Array.from(rhythmMap.values());
      rhythmsCount = mergedRhythms.length;
      if (mergedRhythms.length > 0) {
        localStorage.setItem('beatbuddy_rhythms', JSON.stringify(mergedRhythms));
      }

      // 2. SYNC USER SAMPLES
      const samplesColPath = `users/${user.uid}/samples`;
      const cloudSamples: CloudSampleDoc[] = [];
      try {
        const querySnapshot = await getDocs(collection(db, 'users', user.uid, 'samples'));
        querySnapshot.forEach((d) => {
          cloudSamples.push(d.data() as CloudSampleDoc);
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.LIST, samplesColPath);
      }

      const localSamples = await getAllStoredSamples();
      const localSampleIds = new Set(localSamples.map((s) => s.id));

      for (const cs of cloudSamples) {
        if (!localSampleIds.has(cs.id) && cs.audioBase64) {
          try {
            const blob = base64ToBlob(cs.audioBase64, cs.mimeType || 'audio/wav');
            await saveSampleToStorage(cs.id, cs.name, blob);
            await audioEngine.loadSampleFromBlob(blob, cs.name, cs.id);
          } catch (e) {
            console.warn(`Failed to restore sample ${cs.name} from Firestore:`, e);
          }
        }
      }

      const cloudSampleIds = new Set(cloudSamples.map((s) => s.id));
      for (const ls of localSamples) {
        if (!cloudSampleIds.has(ls.id)) {
          try {
            await this.saveSampleRecord(ls, user);
          } catch (e) {
            console.warn(`Failed to upload local sample ${ls.name} to Firestore:`, e);
          }
        }
      }

      samplesCount = Math.max(cloudSamples.length, localSamples.length);
      await audioEngine.initPersistentSamples();
      this.lastSyncedAt = Date.now();
    } catch (err) {
      console.error('Firebase sync error:', err);
      this.lastError = err instanceof Error ? err.message : 'Erro na sincronização';
    } finally {
      this.isSyncing = false;
      this.notify();
    }

    return { rhythmsCount, samplesCount };
  }

  /**
   * Save a rhythm to Firestore (Both Global studio_rhythms and User space)
   */
  public async saveRhythm(rhythm: SongProject, user = this.currentUser): Promise<void> {
    const payload = {
      id: rhythm.id,
      userId: user?.uid || 'studio',
      name: rhythm.name,
      bpm: rhythm.bpm,
      swing: rhythm.swing || 0,
      timeSignature: rhythm.timeSignature || '4/4',
      steps: rhythm.defaultStepCount || 16,
      isFactory: false,
      tracks: rhythm.tracks || [],
      tags: [rhythm.genre || 'Percussion'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      parts: rhythm.parts,
      genre: rhythm.genre,
      resolution: rhythm.resolution,
      barsCount: rhythm.barsCount,
      humanize: rhythm.humanize,
      accentSound: rhythm.accentSound,
    };

    // 1. Always save to studio_rhythms for instant cross-device sharing (PC <-> Mobile)
    try {
      await setDoc(doc(db, 'studio_rhythms', rhythm.id), payload, { merge: true });
    } catch (e) {
      console.warn('Failed to save to studio_rhythms in Firestore:', e);
    }

    // 2. If user is signed in, save to user document as well
    if (user) {
      const rhythmPath = `users/${user.uid}/rhythms/${rhythm.id}`;
      try {
        await setDoc(doc(db, 'users', user.uid, 'rhythms', rhythm.id), payload, { merge: true });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, rhythmPath);
      }
    }
  }

  /**
   * Save a sample record to Firestore (Both Global studio_samples and User space)
   */
  public async saveSampleRecord(
    record: StoredSampleRecord,
    user = this.currentUser
  ): Promise<void> {
    try {
      const base64 = await blobToBase64(record.blob);
      if (base64.length > 950000) {
        console.warn(`Sample ${record.name} exceeds Firestore doc limit (${base64.length} chars)`);
        return;
      }

      const payload = {
        id: record.id,
        userId: user?.uid || 'studio',
        name: record.name,
        filename: `${record.id}.wav`,
        mimeType: record.mimeType || 'audio/wav',
        size: record.blob.size,
        audioBase64: base64,
        url: `/samples/${record.id}.wav`,
        createdAt: new Date(record.createdAt || Date.now()).toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. Always save to studio_samples for instant cross-device access
      try {
        await setDoc(doc(db, 'studio_samples', record.id), payload, { merge: true });
      } catch (e) {
        console.warn('Failed to save to studio_samples in Firestore:', e);
      }

      // 2. If user is signed in, also save to user collection
      if (user) {
        const samplePath = `users/${user.uid}/samples/${record.id}`;
        try {
          await setDoc(doc(db, 'users', user.uid, 'samples', record.id), payload, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, samplePath);
        }
      }
    } catch (err) {
      console.warn('Error saving sample record to Firestore:', err);
    }
  }

  /**
   * Delete a sample from Firestore
   */
  public async deleteSample(sampleId: string, user = this.currentUser): Promise<void> {
    try {
      await deleteDoc(doc(db, 'studio_samples', sampleId));
    } catch (e) {
      console.warn('Failed to delete from studio_samples:', e);
    }

    if (user) {
      const samplePath = `users/${user.uid}/samples/${sampleId}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'samples', sampleId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, samplePath);
      }
    }
  }

  /**
   * Delete a rhythm from Firestore
   */
  public async deleteRhythm(rhythmId: string, user = this.currentUser): Promise<void> {
    try {
      await deleteDoc(doc(db, 'studio_rhythms', rhythmId));
    } catch (e) {
      console.warn('Failed to delete from studio_rhythms:', e);
    }

    if (user) {
      const rhythmPath = `users/${user.uid}/rhythms/${rhythmId}`;
      try {
        await deleteDoc(doc(db, 'users', user.uid, 'rhythms', rhythmId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, rhythmPath);
      }
    }
  }
}

export const firebaseSyncService = new FirebaseSyncService();
