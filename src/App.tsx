/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { BeatBuddyDisplay } from './components/BeatBuddyDisplay';
import { PedalController } from './components/PedalController';
import { SongPartsBar } from './components/SongPartsBar';
import { MasterToolbar } from './components/MasterToolbar';
import { SequencerGrid } from './components/SequencerGrid';
import { SampleManagerModal } from './components/SampleManagerModal';
import { AddInstrumentModal } from './components/AddInstrumentModal';
import { CreateRhythmModal } from './components/CreateRhythmModal';
import { DeleteRhythmModal } from './components/DeleteRhythmModal';
import { CopyPartModal } from './components/CopyPartModal';
import { FootswitchConfigModal } from './components/FootswitchConfigModal';
import { SamplesLibraryView } from './components/SamplesLibraryView';
import { AudioVisualizer } from './components/AudioVisualizer';
import { MobileAndPedalGuideModal } from './components/MobileAndPedalGuideModal';
import { ShareMobileModal } from './components/ShareMobileModal';
import { Volume2 } from 'lucide-react';
import { audioEngine } from './audio/AudioEngine';
import {
  sambaPreset,
  availablePresets,
  createEmptySteps,
  createNewCustomRhythm,
  StarterKitType,
} from './presets/groovePresets';
import {
  SongPartId,
  SongProject,
  StepData,
  TimeSignature,
  TrackDefinition,
  RhythmicResolution,
} from './types/rhythm';
import {
  syncSamplesFromServer,
  fetchRhythmsFromServer,
  saveRhythmsToServer,
  fetchActiveRhythmFromServer,
  saveActiveRhythmToServer,
} from './audio/sampleStorage';
import { footswitchManager } from './audio/midiAndPedalManager';
import { firebaseSyncService } from './services/firebaseSyncService';
import type { User } from './firebase';

export default function App() {
  // Firebase User & Cloud Database Authentication
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isFirebaseLoading, setIsFirebaseLoading] = useState(false);

  // Persistent Rhythms Library
  const [rhythms, setRhythms] = useState<SongProject[]>(() => {
    try {
      const saved = localStorage.getItem('beatbuddy_rhythms');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((p: SongProject) => ({
            ...p,
            barsCount: p.barsCount === 2 ? 1 : (p.barsCount || 1),
            resolution: p.resolution === '1/16' ? '1/32' : (p.resolution || '1/32'),
          }));
        }
      }
    } catch (e) {
      console.error('Failed to load rhythms from localStorage', e);
    }
    return availablePresets;
  });

  const [project, setProject] = useState<SongProject>(() => {
    const p = rhythms[0] || sambaPreset;
    return {
      ...p,
      barsCount: p.barsCount === 2 ? 1 : (p.barsCount || 1),
      resolution: p.resolution === '1/16' ? '1/32' : (p.resolution || '1/32'),
    };
  });

  const [isMobileScreen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return (
      window.innerWidth < 768 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
  });

  const [activeView, setActiveView] = useState<'sequencer' | 'pedal' | 'samples'>(() => {
    if (typeof window !== 'undefined') {
      const isMobile =
        window.innerWidth < 768 ||
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      if (isMobile) return 'pedal';
    }
    return 'sequencer';
  });
  const [activePartId, setActivePartId] = useState<SongPartId>('verse');
  const [playingPartId, setPlayingPartId] = useState<SongPartId>('verse');
  const [isPlaying, setIsPlaying] = useState(false);

  // Playhead & Clock state
  const [currentTick, setCurrentTick] = useState(0);
  const [currentBeat, setCurrentBeat] = useState(1);
  const [currentBar, setCurrentBar] = useState(1);
  const [subdivision, setSubdivision] = useState(0);
  const [activeTrackSteps, setActiveTrackSteps] = useState<Record<string, number>>({});

  // BeatBuddy dynamic state (Pedal 1 & Pedal 2)
  const [basePartId, setBasePartId] = useState<SongPartId>('verse');
  const [selectedStartPart, setSelectedStartPart] = useState<SongPartId>('verse');
  const [isFill, setIsFill] = useState(false);
  const [activeFillId, setActiveFillId] = useState<SongPartId | null>(null);
  const [isTransition, setIsTransition] = useState(false);
  const [activeTransitionId, setActiveTransitionId] = useState<SongPartId | null>(null);
  const [isOutro, setIsOutro] = useState(false);
  const [isIntro, setIsIntro] = useState(false);
  const [playIntroOnStart, setPlayIntroOnStart] = useState(true);

  // Cloud sync state
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [isSavedRecently, setIsSavedRecently] = useState(false);
  const isServerLoadedRef = useRef(false);

  // Pedal toast notification & physical states
  const [pedalToast, setPedalToast] = useState<{ msg: string; timestamp: number } | null>(null);
  const [isExternalPedal1Pressed, setIsExternalPedal1Pressed] = useState(false);
  const [isExternalPedal2Pressed, setIsExternalPedal2Pressed] = useState(false);

  // Master controls
  const [masterVolume, setMasterVolume] = useState(0.85);
  const [metronomeOn, setMetronomeOn] = useState(false);

  // Modals
  const [editingTrack, setEditingTrack] = useState<TrackDefinition | null>(null);
  const [isAddTrackOpen, setIsAddTrackOpen] = useState(false);
  const [isCreateRhythmOpen, setIsCreateRhythmOpen] = useState(false);
  const [isDeleteRhythmOpen, setIsDeleteRhythmOpen] = useState(false);
  const [isCopyPartOpen, setIsCopyPartOpen] = useState(false);
  const [isFootswitchConfigOpen, setIsFootswitchConfigOpen] = useState(false);
  const [isMobileGuideOpen, setIsMobileGuideOpen] = useState(false);
  const [isShareMobileOpen, setIsShareMobileOpen] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [customSamplesList, setCustomSamplesList] = useState<Array<{ id: string; name: string }>>(() =>
    audioEngine.getCustomSamplesList()
  );

  // Stable refs for global pedal actions
  const stateRef = useRef({
    isPlaying,
    isIntro,
    isFill,
    isTransition,
    isOutro,
    currentPartId: playingPartId,
    basePartId,
    selectedStartPart,
  });

  useEffect(() => {
    stateRef.current = {
      isPlaying,
      isIntro,
      isFill,
      isTransition,
      isOutro,
      currentPartId: playingPartId,
      basePartId,
      selectedStartPart,
    };
  }, [isPlaying, isIntro, isFill, isTransition, isOutro, playingPartId, basePartId, selectedStartPart]);

  // Show a momentary pedal toast
  const triggerPedalToast = (msg: string) => {
    setPedalToast({ msg, timestamp: Date.now() });
    setTimeout(() => {
      setPedalToast((prev) => (prev && Date.now() - prev.timestamp >= 2200 ? null : prev));
    }, 2300);
  };

  // Subscribe to Firebase Auth and Cloud Database state
  useEffect(() => {
    const unsub = firebaseSyncService.subscribe((status) => {
      setCurrentUser(status.user);
      setIsFirebaseLoading(status.isLoading);
      if (status.lastSyncedAt) {
        setLastSyncTime(status.lastSyncedAt);
      }
    });
    return unsub;
  }, []);

  // --- Initial Cloud & Sample Synchronization (PC <-> Celular <-> Firebase) ---
  const performCloudSync = async () => {
    setIsSyncing(true);
    try {
      // 1. Fetch Cloud Studio Library (Samples + Rhythms) from Firestore
      // This immediately restores custom percussion samples (pandeiro, ganza, etc.) onto mobile & PC
      try {
        await firebaseSyncService.syncStudioLibrary();
      } catch (fbErr) {
        console.warn('Initial studio library sync attempt:', fbErr);
      }

      // 2. Fetch rhythms from server so target rhythm (e.g. Samba) and its tracks are loaded
      const remoteRhythms = await fetchRhythmsFromServer();
      const activeRhythmId = await fetchActiveRhythmFromServer();

      if (remoteRhythms && Array.isArray(remoteRhythms) && remoteRhythms.length > 0) {
        const typedRhythms = remoteRhythms as SongProject[];
        setRhythms(typedRhythms);
        localStorage.setItem('beatbuddy_rhythms', JSON.stringify(typedRhythms));

        // Prioritize: 1) server active rhythm, 2) local active rhythm, 3) custom rhythm (e.g. Samba), 4) first
        const localActiveId = localStorage.getItem('beatbuddy_active_rhythm_id');
        const targetId = activeRhythmId || localActiveId;
        const targetRhythm =
          typedRhythms.find((r) => r.id === targetId) ||
          typedRhythms.find((r) => !r.id.startsWith('preset_')) ||
          typedRhythms[0];

        if (targetRhythm) {
          setProject(targetRhythm);
          audioEngine.updateProject(targetRhythm);
        }
      } else {
        // First time initialization only: upload local presets to server
        await saveRhythmsToServer(rhythms);
      }

      // 3. If user is logged in with Google/Firebase, run personal Firestore sync
      if (currentUser) {
        try {
          await firebaseSyncService.syncAll(currentUser);
          const savedInDb = localStorage.getItem('beatbuddy_rhythms');
          if (savedInDb) {
            const parsed = JSON.parse(savedInDb);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setRhythms(parsed);
              const targetRhythm = parsed.find((r: SongProject) => r.id === project.id) || parsed[0];
              if (targetRhythm) {
                setProject(targetRhythm);
                audioEngine.updateProject(targetRhythm);
              }
            }
          }
        } catch (e) {
          console.warn('Firebase sync warning:', e);
        }
      }

      // 4. Pre-load all samples directly into audio buffers for immediate mobile playback
      await audioEngine.preloadAllServerSamples();

      // 5. Sync audio samples from server to local IndexedDB (and vice-versa)
      await syncSamplesFromServer();

      // 6. Refresh samples in AudioEngine
      await audioEngine.initPersistentSamples();
      setCustomSamplesList(audioEngine.getCustomSamplesList());

      isServerLoadedRef.current = true;
      setLastSyncTime(Date.now());
    } catch (err) {
      console.warn('Sync attempt finished with warnings:', err);
      isServerLoadedRef.current = true;
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    performCloudSync();

    // Mobile audio unlocking listener on first touch or pedal click
    const unlockAudio = async () => {
      await audioEngine.unlockAudioContext();
      setIsAudioUnlocked(true);
    };
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('click', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });
    return () => {
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  // Sync project changes with audio engine & persistent storage + Cloud
  useEffect(() => {
    audioEngine.updateProject(project);

    // Save project changes to rhythms library and localStorage
    setRhythms((prevList) => {
      const idx = prevList.findIndex((r) => r.id === project.id);
      if (idx >= 0 && prevList[idx] === project) return prevList;
      const nextList = idx >= 0
        ? prevList.map((r, i) => (i === idx ? project : r))
        : [...prevList, project];
      try {
        localStorage.setItem('beatbuddy_rhythms', JSON.stringify(nextList));
        localStorage.setItem('beatbuddy_active_rhythm_id', project.id);
        // Only save to server once initial load has completed to avoid overwriting with defaults
        if (isServerLoadedRef.current) {
          saveRhythmsToServer(nextList).catch(() => {});
          saveActiveRhythmToServer(project.id).catch(() => {});
        }
        if (currentUser) {
          firebaseSyncService.saveRhythm(project, currentUser).catch(() => {});
        }
      } catch (e) {
        console.error('Failed to save rhythms to localStorage', e);
      }
      return nextList;
    });
  }, [project, currentUser]);

  // Primary action: Save rhythm directly to App & Cloud
  const handleSaveProjectToApp = async () => {
    try {
      const nextList = rhythms.some((r) => r.id === project.id)
        ? rhythms.map((r) => (r.id === project.id ? project : r))
        : [project, ...rhythms];

      setRhythms(nextList);
      localStorage.setItem('beatbuddy_rhythms', JSON.stringify(nextList));
      localStorage.setItem('beatbuddy_active_rhythm_id', project.id);

      // Persist to server
      await saveRhythmsToServer(nextList);
      await saveActiveRhythmToServer(project.id);
      await syncSamplesFromServer();

      // Also persist to Firebase Firestore database (studio_rhythms + user rhythms)
      try {
        await firebaseSyncService.saveRhythm(project, currentUser);
      } catch (e) {
        console.warn('Could not save to Firebase:', e);
      }

      setIsSavedRecently(true);
      triggerPedalToast(
        currentUser
          ? `💾 Ritmo "${project.name}" salvo no App e na Nuvem Firebase! Disponível no seu celular.`
          : `💾 Ritmo "${project.name}" salvo no App! Já disponível no celular.`
      );
      setTimeout(() => setIsSavedRecently(false), 2500);
    } catch (err) {
      console.error('Failed to save rhythm to app:', err);
    }
  };

  const handleLoginFirebase = async () => {
    try {
      setIsSyncing(true);
      triggerPedalToast('Conectando ao banco de dados Firebase...');
      const user = await firebaseSyncService.loginWithGoogle();
      setCurrentUser(user);
      triggerPedalToast(`💾 Conectado como ${user.displayName || user.email}! Ritmos e samples salvos na nuvem.`);
      await performCloudSync();
    } catch (err) {
      console.error('Firebase login error:', err);
      triggerPedalToast('Não foi possível conectar com o Google no momento.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleLogoutFirebase = async () => {
    try {
      await firebaseSyncService.logout();
      setCurrentUser(null);
      triggerPedalToast('Conta Google desconectada.');
    } catch (err) {
      console.error('Firebase logout error:', err);
    }
  };

  // Setup audio engine callback listener
  useEffect(() => {
    audioEngine.setCallbacks({
      onStep: ({
        partId,
        globalTick,
        beat,
        bar,
        subdivision: sub,
        trackSteps,
        isFill: fillActive,
        isTransition: transActive,
      }) => {
        setPlayingPartId(partId);
        setCurrentTick(globalTick);
        setCurrentBeat(beat);
        setCurrentBar(bar);
        setSubdivision(sub);
        setActiveTrackSteps(trackSteps);
        setIsFill(fillActive);
        setIsTransition(transActive);
      },
      onPedalStateChange: ({
        currentPart,
        basePart,
        selectedStartPart: startPart,
        activeFill,
        isTransitioning,
        activeTransition,
        isOutro: outroActive,
        isIntro: introActive,
      }) => {
        setPlayingPartId(currentPart);
        setActivePartId(currentPart);
        if (basePart) setBasePartId(basePart);
        if (startPart) setSelectedStartPart(startPart);
        setIsFill(Boolean(activeFill));
        setActiveFillId(activeFill || null);
        setIsTransition(isTransitioning);
        setActiveTransitionId(activeTransition || null);
        setIsOutro(outroActive);
        setIsIntro(Boolean(introActive));
      },
      onPlaybackStateChange: (playing) => {
        setIsPlaying(playing);
        if (!playing) {
          setActiveTrackSteps({});
          setIsIntro(false);
          setIsFill(false);
          setActiveFillId(null);
          setIsTransition(false);
          setActiveTransitionId(null);
          setIsOutro(false);
        }
      },
      onPartAutoAdvance: (nextPartId) => {
        setActivePartId(nextPartId);
        setPlayingPartId(nextPartId);
        if (nextPartId === 'verse' || nextPartId === 'part_b') {
          setBasePartId(nextPartId);
        }
        setIsIntro(false);
      },
      onSamplesUpdated: (samples) => {
        setCustomSamplesList(samples);
      },
    });
  }, []);

  // --- GLOBAL FOOSWITCH & CUVAVE / M-VAVE KEYBOARD LISTENER ---
  // Operates continuously across ALL views (Sequencer, Pedal, Samples)
  useEffect(() => {
    let pressTimer: number | null = null;
    let isHolding = false;

    // PEDAL 1:
    // IN STOP: TAP -> INTRO
    // IN PLAY: TAP -> FILL A / FILL B
    // HOLD: ENDING
    const handlePedal1Down = () => {
      setIsExternalPedal1Pressed(true);
      isHolding = false;

      // Hold threshold: >= 400ms triggers Ending if playing
      pressTimer = window.setTimeout(() => {
        isHolding = true;
        if (stateRef.current.isPlaying) {
          audioEngine.handlePedal1HoldStart();
          triggerPedalToast('🦶 Pedal 1 Segurado: Finalizando Música (Ending)');
        }
      }, 400);
    };

    const handlePedal1Up = () => {
      setIsExternalPedal1Pressed(false);
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      if (!isHolding) {
        if (!stateRef.current.isPlaying) {
          audioEngine.handlePedal1Tap();
          triggerPedalToast('🦶 Pedal 1: Iniciar com Intro');
        } else if (stateRef.current.isIntro) {
          audioEngine.handlePedal1Tap();
          triggerPedalToast('🦶 Pedal 1: Pular Intro -> Parte A');
        } else {
          audioEngine.handlePedal1Tap();
          const targetFill = stateRef.current.basePartId === 'part_b' ? 'Fill B' : 'Fill A';
          triggerPedalToast(`🦶 Pedal 1: Virada (${targetFill}) Disparada!`);
        }
      }
      isHolding = false;
    };

    // PEDAL 2:
    // IN STOP: TAP -> Alterna PARTE A / PARTE B
    // IN PLAY: TAP -> TRANSIÇÃO A -> B / TRANSIÇÃO B -> A
    const handlePedal2Down = () => {
      setIsExternalPedal2Pressed(true);
      if (!stateRef.current.isPlaying) {
        audioEngine.handlePedal2Tap();
        const nextPart = stateRef.current.selectedStartPart === 'verse' ? 'Parte B' : 'Parte A';
        triggerPedalToast(`🦶 Pedal 2: Selecionada ${nextPart} para iniciar`);
      } else {
        audioEngine.handlePedal2Tap();
        const transLabel = stateRef.current.basePartId === 'part_b' ? 'Transição B ➔ A' : 'Transição A ➔ B';
        triggerPedalToast(`🦶 Pedal 2: ${transLabel} Disparada!`);
      }
    };

    const handlePedal2Up = () => {
      setIsExternalPedal2Pressed(false);
    };

    // Connect footswitchManager callbacks
    footswitchManager.setCallbacks({
      onPedal1: () => {
        handlePedal1Down();
        setTimeout(handlePedal1Up, 150);
      },
      onPedal2: () => {
        handlePedal2Down();
        setTimeout(handlePedal2Up, 150);
      },
      onActivity: (signal) => {
        triggerPedalToast(`🦶 Sinal Cube Turner: ${signal.value}`);
      },
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in text inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Unmute audio immediately if locked on mobile
      if (!isAudioUnlocked) {
        audioEngine.unlockAudioContext();
        setIsAudioUnlocked(true);
      }

      // If user is inside footswitch config learning a key, let the modal handle it
      if (footswitchManager.getLearningTarget() !== null) {
        footswitchManager.handleKeyEventForLearning(e);
        return;
      }

      if (footswitchManager.isPedal1Event(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          handlePedal1Down();
        }
      } else if (footswitchManager.isPedal2Event(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          handlePedal2Down();
        }
      } else if (!e.repeat && (e.key.length === 1 || e.key.startsWith('Arrow') || e.key.startsWith('Page') || e.key === ' ' || e.key === 'Enter')) {
        // Real-time notification for unmapped pedal signal
        const keyName = e.key === ' ' ? 'Espaço' : (e.key || e.code || `KeyCode #${e.keyCode}`);
        footswitchManager.notifyActivity({
          type: 'key',
          value: `Sinal "${keyName}" (Pressione "Configurar Pedal" no topo para calibrar)`
        });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (footswitchManager.getLearningTarget() !== null) return;

      if (footswitchManager.isPedal1Event(e)) {
        e.preventDefault();
        e.stopPropagation();
        handlePedal1Up();
      } else if (footswitchManager.isPedal2Event(e)) {
        e.preventDefault();
        e.stopPropagation();
        handlePedal2Up();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true, passive: false });
    window.addEventListener('keyup', handleKeyUp, { capture: true, passive: false });
    document.addEventListener('keydown', handleKeyDown, { capture: true, passive: false });
    document.addEventListener('keyup', handleKeyUp, { capture: true, passive: false });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      document.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, []);

  // --- Transport & Project Handlers ---
  const handleTogglePlay = () => {
    audioEngine.togglePlay();
  };

  const handleStop = () => {
    audioEngine.stop();
  };

  const handleBpmChange = (bpm: number) => {
    setProject((prev) => ({ ...prev, bpm }));
    audioEngine.setBpm(bpm);
  };

  const handleSwingChange = (swing: number) => {
    setProject((prev) => ({ ...prev, swing }));
    audioEngine.setSwing(swing);
  };

  const handleHumanizeChange = (humanize: number) => {
    setProject((prev) => ({ ...prev, humanize }));
    audioEngine.setHumanize(humanize);
  };

  const handleTimeSignatureChange = (timeSignature: TimeSignature) => {
    setProject((prev) => ({ ...prev, timeSignature }));
  };

  const handleResolutionChange = (resolution: RhythmicResolution) => {
    setProject((prev) => {
      const subPerBeat =
        resolution === '1/8' ? 2 : resolution === '1/8T' ? 3 : resolution === '1/16' ? 4 : resolution === '1/16T' ? 6 : 8;
      const targetSteps = Math.min(32, Math.max(16, subPerBeat * 4 * (prev.barsCount || 1)));
      const updatedParts = { ...prev.parts };
      Object.keys(updatedParts).forEach((pKey) => {
        const pId = pKey as SongPartId;
        const trackSteps = { ...(updatedParts[pId]?.trackSteps || {}) };
        prev.tracks.forEach((t) => {
          const existing = trackSteps[t.id] || [];
          if (existing.length < targetSteps) {
            trackSteps[t.id] = [
              ...existing,
              ...createEmptySteps(targetSteps - existing.length),
            ];
          }
        });
        updatedParts[pId] = {
          ...updatedParts[pId],
          trackSteps,
        };
      });
      return {
        ...prev,
        resolution,
        parts: updatedParts,
      };
    });
  };

  const handleBarsCountChange = (barsCount: number) => {
    setProject((prev) => {
      const subPerBeat =
        prev.resolution === '1/8' ? 2 : prev.resolution === '1/8T' ? 3 : prev.resolution === '1/16' ? 4 : prev.resolution === '1/16T' ? 6 : 8;
      const targetSteps = Math.min(32, Math.max(16, subPerBeat * 4 * barsCount));
      const updatedParts = { ...prev.parts };
      Object.keys(updatedParts).forEach((pKey) => {
        const pId = pKey as SongPartId;
        const trackSteps = { ...(updatedParts[pId]?.trackSteps || {}) };
        prev.tracks.forEach((t) => {
          const existing = trackSteps[t.id] || [];
          if (existing.length < targetSteps) {
            trackSteps[t.id] = [
              ...existing,
              ...createEmptySteps(targetSteps - existing.length),
            ];
          }
        });
        updatedParts[pId] = {
          ...updatedParts[pId],
          trackSteps,
        };
      });
      return {
        ...prev,
        barsCount,
        parts: updatedParts,
      };
    });
  };

  const handleMasterVolumeChange = (vol: number) => {
    setMasterVolume(vol);
    audioEngine.setMasterVolume(vol);
  };

  const handleToggleMetronome = () => {
    const next = !metronomeOn;
    setMetronomeOn(next);
    audioEngine.setMetronome(next);
  };

  const handleTogglePlayIntroOnStart = () => {
    const next = !playIntroOnStart;
    setPlayIntroOnStart(next);
    audioEngine.setPlayIntroOnStart(next);
  };

  const handleSelectPreset = (preset: SongProject) => {
    audioEngine.stop();
    setProject(preset);
    setActivePartId('verse');
    setPlayingPartId('verse');
    localStorage.setItem('beatbuddy_active_rhythm_id', preset.id);
    saveActiveRhythmToServer(preset.id).catch(() => {});
  };

  const handleSelectPart = (partId: SongPartId) => {
    setActivePartId(partId);
    setPlayingPartId(partId);
    if (partId === 'verse' || partId === 'part_b') {
      setSelectedStartPart(partId);
      setBasePartId(partId);
    }
    audioEngine.selectPart(partId);
  };

  // --- Rhythm Creation & Deletion ---
  const handleCreateNewRhythm = (params: {
    name: string;
    genre: string;
    bpm: number;
    timeSignature: TimeSignature;
    starterKit: StarterKitType;
    resolution?: RhythmicResolution;
    barsCount?: number;
  }) => {
    audioEngine.stop();
    const newProject = createNewCustomRhythm(params);
    const updatedList = [...rhythms, newProject];
    setRhythms(updatedList);
    try {
      localStorage.setItem('beatbuddy_rhythms', JSON.stringify(updatedList));
      saveRhythmsToServer(updatedList).catch(() => {});
    } catch (e) {
      console.error(e);
    }
    setProject(newProject);
    setActivePartId('verse');
    setPlayingPartId('verse');
    triggerPedalToast(`Ritmo "${newProject.name}" salvo na nuvem!`);
  };

  const handleDeleteRhythm = (rhythmId: string) => {
    if (rhythms.length <= 1) return;
    audioEngine.stop();
    const nextList = rhythms.filter((r) => r.id !== rhythmId);
    setRhythms(nextList);
    try {
      localStorage.setItem('beatbuddy_rhythms', JSON.stringify(nextList));
      saveRhythmsToServer(nextList).catch(() => {});
    } catch (e) {
      console.error(e);
    }
    const nextActive = nextList[0] || sambaPreset;
    setProject(nextActive);
    setActivePartId('verse');
    setPlayingPartId('verse');
  };

  // --- Step & Sequencer Manipulation ---
  const handleToggleStep = (trackId: string, stepIndex: number) => {
    setProject((prev) => {
      const part = prev.parts[activePartId] || prev.parts['verse'];
      const currentTrackSteps = [...(part.trackSteps[trackId] || createEmptySteps(32))];

      while (currentTrackSteps.length <= stepIndex) {
        currentTrackSteps.push({
          active: false,
          velocity: 90,
          probability: 1.0,
          ratchet: 1,
        });
      }

      const step = currentTrackSteps[stepIndex] || {
        active: false,
        velocity: 90,
        probability: 1.0,
        ratchet: 1,
      };

      // 4-stage cycle: Off -> Normal (90) -> Accent (125) -> Ghost (50) -> Off
      let nextStep: StepData;
      if (!step.active) {
        nextStep = { ...step, active: true, velocity: 90 };
      } else if (step.velocity < 115 && step.velocity > 65) {
        nextStep = { ...step, active: true, velocity: 125 };
      } else if (step.velocity >= 115) {
        nextStep = { ...step, active: true, velocity: 50 };
      } else {
        nextStep = { ...step, active: false, velocity: 90 };
      }

      currentTrackSteps[stepIndex] = nextStep;
      return {
        ...prev,
        parts: {
          ...prev.parts,
          [activePartId]: {
            ...part,
            trackSteps: {
              ...part.trackSteps,
              [trackId]: currentTrackSteps,
            },
          },
        },
      };
    });
  };

  const handleUpdateStep = (
    trackId: string,
    stepIndex: number,
    stepData: Partial<StepData>
  ) => {
    setProject((prev) => {
      const part = prev.parts[activePartId] || prev.parts['verse'];
      const currentTrackSteps = [...(part.trackSteps[trackId] || createEmptySteps(32))];
      while (currentTrackSteps.length <= stepIndex) {
        currentTrackSteps.push({
          active: false,
          velocity: 90,
          probability: 1.0,
          ratchet: 1,
        });
      }
      const step = currentTrackSteps[stepIndex];
      currentTrackSteps[stepIndex] = { ...step, ...stepData };
      return {
        ...prev,
        parts: {
          ...prev.parts,
          [activePartId]: {
            ...part,
            trackSteps: {
              ...part.trackSteps,
              [trackId]: currentTrackSteps,
            },
          },
        },
      };
    });
  };

  const handleUpdateTrackLength = (trackId: string, newLength: number) => {
    setProject((prev) => {
      const part = prev.parts[activePartId] || prev.parts['verse'];
      const counts = { ...(part.trackStepCounts || {}) };
      counts[trackId] = newLength;
      const currentSteps = part.trackSteps[trackId] || [];
      const updatedTrackSteps = { ...part.trackSteps };
      if (currentSteps.length < newLength) {
        updatedTrackSteps[trackId] = [
          ...currentSteps,
          ...createEmptySteps(newLength - currentSteps.length),
        ];
      }
      return {
        ...prev,
        parts: {
          ...prev.parts,
          [activePartId]: {
            ...part,
            trackSteps: updatedTrackSteps,
            trackStepCounts: counts,
          },
        },
      };
    });
  };

  const handleUpdateTrackParams = (
    trackId: string,
    updates: Partial<TrackDefinition>
  ) => {
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, ...updates } : t)),
    }));
  };

  const handleToggleTrackMute = (trackId: string) => {
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id === trackId ? { ...t, muted: !t.muted } : t
      ),
    }));
  };

  const handleToggleTrackSolo = (trackId: string) => {
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id === trackId ? { ...t, solo: !t.solo } : t
      ),
    }));
  };

  const handleTriggerTrack = (track: TrackDefinition) => {
    audioEngine.triggerInstrument(
      track.soundType,
      {
        velocity: 110,
        tune: track.tune,
        decay: track.decay,
        tone: track.tone,
        pan: track.pan,
        volume: track.volume,
        reverse: track.reverse,
      },
      track.customSampleId
    );
  };

  const handleDeleteTrack = (trackId: string) => {
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.filter((t) => t.id !== trackId),
    }));
  };

  const handleRemoveTrackSample = (trackId: string) => {
    handleUpdateTrackParams(trackId, {
      customSampleId: undefined,
      customSampleName: undefined,
      soundType: 'kick',
    });
  };

  const handleDeleteSample = (sampleId: string) => {
    audioEngine.deleteCustomSample(sampleId);
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.customSampleId === sampleId
          ? {
              ...t,
              customSampleId: undefined,
              customSampleName: undefined,
              soundType: 'kick',
            }
          : t
      ),
    }));
  };

  const handleRenameSample = (sampleId: string, newName: string) => {
    audioEngine.renameCustomSample(sampleId, newName);
    setProject((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.customSampleId === sampleId ? { ...t, customSampleName: newName } : t
      ),
    }));
  };

  const handleAddTrack = (trackDef: Omit<TrackDefinition, 'id'>) => {
    const id = `track_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newTrack: TrackDefinition = { ...trackDef, id };
    setProject((prev) => {
      const updatedParts = { ...prev.parts };
      Object.keys(updatedParts).forEach((pKey) => {
        const pId = pKey as SongPartId;
        const currentSteps = updatedParts[pId]?.trackSteps || {};
        updatedParts[pId] = {
          ...updatedParts[pId],
          trackSteps: {
            ...currentSteps,
            [id]: createEmptySteps(64),
          },
        };
      });
      return {
        ...prev,
        tracks: [...prev.tracks, newTrack],
        parts: updatedParts,
      };
    });
  };

  const handleAddTrackWithSample = (sampleId: string, sampleName: string) => {
    handleAddTrack({
      name: sampleName,
      category: 'custom',
      soundType: 'custom',
      color: '#f59e0b',
      volume: 0.85,
      pan: 0,
      tune: 0,
      decay: 1.0,
      tone: 0.8,
      muted: false,
      solo: false,
      customSampleId: sampleId,
      customSampleName: sampleName,
    });
    setActiveView('sequencer');
  };

  const handleCopyPart = (
    source: SongPartId,
    targets: SongPartId[],
    switchToTarget?: boolean
  ) => {
    setProject((prev) => {
      const srcPart = prev.parts[source];
      if (!srcPart) return prev;
      const updatedParts = { ...prev.parts };
      targets.forEach((target) => {
        const clonedSteps: Record<string, StepData[]> = {};
        Object.entries(srcPart.trackSteps).forEach(([tId, steps]) => {
          clonedSteps[tId] = steps.map((s) => ({ ...s }));
        });
        updatedParts[target] = {
          ...updatedParts[target],
          trackSteps: clonedSteps,
          trackStepCounts: { ...(srcPart.trackStepCounts || {}) },
        };
      });
      return {
        ...prev,
        parts: updatedParts,
      };
    });
    if (switchToTarget && targets.length > 0) {
      setActivePartId(targets[0]);
    }
  };

  const handleClearPart = (partId: SongPartId) => {
    setProject((prev) => {
      const currentPart = prev.parts[partId];
      if (!currentPart) return prev;
      const cleared: Record<string, StepData[]> = {};
      prev.tracks.forEach((t) => {
        cleared[t.id] = createEmptySteps(32);
      });
      return {
        ...prev,
        parts: {
          ...prev.parts,
          [partId]: {
            ...currentPart,
            trackSteps: cleared,
          },
        },
      };
    });
  };

  // Export Project JSON
  const handleExportProjectJson = () => {
    const dataStr =
      'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(project, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute(
      'download',
      `${project.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_project.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleImportProjectJson = (imported: SongProject) => {
    setProject(imported);
    setActivePartId('verse');
    audioEngine.stop();
  };

  // Pedal Virtual Actions (Pedal 1 & Pedal 2)
  const handlePedal1Tap = () => {
    audioEngine.handlePedal1Tap();
  };

  const handlePedal1HoldStart = () => {
    audioEngine.handlePedal1HoldStart();
  };

  const handlePedal2Tap = () => {
    audioEngine.handlePedal2Tap();
  };

  const currentPartData = project.parts[activePartId] || project.parts['verse'];
  const playingPartData = project.parts[playingPartId] || project.parts['verse'];

  return (
    <div className="min-h-screen flex flex-col bg-[#090d16] text-slate-100 font-sans selection:bg-amber-400 selection:text-slate-950">
      {/* Header */}
      <Header
        activeView={activeView}
        onSelectView={setActiveView}
        onOpenCreateModal={() => setIsCreateRhythmOpen(true)}
        onOpenFootswitchModal={() => setIsFootswitchConfigOpen(true)}
        onOpenMobileGuide={() => setIsMobileGuideOpen(true)}
        onOpenShareMobile={() => setIsShareMobileOpen(true)}
        isSyncing={isSyncing}
        lastSyncTime={lastSyncTime}
        onManualSync={performCloudSync}
        currentUser={currentUser}
        isFirebaseLoading={isFirebaseLoading}
        onLoginFirebase={handleLoginFirebase}
        onLogoutFirebase={handleLogoutFirebase}
      />

      {/* Mobile Audio Activation Banner (shown until first user touch/click) */}
      {!isAudioUnlocked && (
        <div
          onClick={() => {
            audioEngine.unlockAudioContext();
            audioEngine.preloadAllServerSamples();
            setIsAudioUnlocked(true);
          }}
          className="bg-amber-400/20 border-b border-amber-400/50 px-4 py-2 text-center text-xs font-bold text-amber-300 flex items-center justify-center gap-2 cursor-pointer hover:bg-amber-400/30 transition-colors"
        >
          <Volume2 className="w-4 h-4 text-amber-400 shrink-0 animate-bounce" />
          <span>📱 Modo Celular: Toque aqui para ativar o áudio e conectar o pedal</span>
        </div>
      )}

      {/* Floating Real-time Pedal Toast Notification */}
      {pedalToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900/95 border-2 border-amber-400/80 text-white px-4 py-2.5 rounded-xl shadow-[0_0_25px_rgba(245,158,11,0.4)] flex items-center gap-2.5 animate-in slide-in-from-bottom-2 fade-in duration-150">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
          <span className="text-xs font-bold font-mono tracking-wide text-amber-200">
            {pedalToast.msg}
          </span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col">
        {/* Master Toolbar */}
        <MasterToolbar
          project={project}
          rhythms={rhythms}
          isPlaying={isPlaying}
          masterVolume={masterVolume}
          metronomeOn={metronomeOn}
          playIntroOnStart={playIntroOnStart}
          canDeleteRhythm={rhythms.length > 1}
          isSavedRecently={isSavedRecently}
          onSaveProjectToApp={handleSaveProjectToApp}
          onTogglePlay={handleTogglePlay}
          onBpmChange={handleBpmChange}
          onSwingChange={handleSwingChange}
          onHumanizeChange={handleHumanizeChange}
          onTimeSignatureChange={handleTimeSignatureChange}
          onResolutionChange={handleResolutionChange}
          onBarsCountChange={handleBarsCountChange}
          onMasterVolumeChange={handleMasterVolumeChange}
          onToggleMetronome={handleToggleMetronome}
          onTogglePlayIntroOnStart={handleTogglePlayIntroOnStart}
          onSelectPreset={handleSelectPreset}
          onOpenCreateModal={() => setIsCreateRhythmOpen(true)}
          onOpenDeleteModal={() => setIsDeleteRhythmOpen(true)}
          onExportProject={handleExportProjectJson}
          onImportProject={handleImportProjectJson}
        />

        {/* View 1: Studio Sequencer Matrix View */}
        {activeView === 'sequencer' && (
          <div className="flex-1 flex flex-col">
            {isMobileScreen && (
              <div className="bg-amber-950/70 border-b border-amber-500/60 px-4 py-2.5 flex items-center justify-between text-xs text-amber-200">
                <span>🖥️ Sequenciador Matrix (recomendado para PC/Computador)</span>
                <button
                  type="button"
                  onClick={() => setActiveView('pedal')}
                  className="px-2.5 py-1 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold rounded-lg cursor-pointer"
                >
                  Voltar ao Pedal Live
                </button>
              </div>
            )}

            {/* BeatBuddy Hardware LCD Banner */}
            <div className="bg-[#0b101d] px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-[320px]">
                <BeatBuddyDisplay
                  songName={project.name}
                  partName={playingPartData.name}
                  partId={playingPartId}
                  basePartId={basePartId}
                  selectedStartPart={selectedStartPart}
                  activeFillId={activeFillId}
                  activeTransitionId={activeTransitionId}
                  bpm={project.bpm}
                  timeSignature={project.timeSignature}
                  currentBeat={currentBeat}
                  currentBar={currentBar}
                  subdivision={subdivision}
                  isPlaying={isPlaying}
                  isFill={isFill}
                  isTransition={isTransition}
                  isOutro={isOutro}
                  isIntro={isIntro}
                />
              </div>

              {/* Master VU & Quick Pedal Widget */}
              <div className="flex items-center gap-3">
                <AudioVisualizer />
                <button
                  type="button"
                  onClick={handlePedal1Tap}
                  className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                    isPlaying
                      ? isIntro
                        ? 'bg-emerald-500 text-slate-950 border-emerald-300 shadow-sm'
                        : isFill
                        ? 'bg-amber-500 text-slate-950 border-amber-300'
                        : 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/30'
                      : 'bg-emerald-600/30 text-emerald-300 border-emerald-500/50 hover:bg-emerald-600/50'
                  }`}
                >
                  {isPlaying
                    ? isIntro
                      ? 'Pular Intro'
                      : basePartId === 'part_b'
                      ? 'Pedal 1: Virada (Fill B)'
                      : 'Pedal 1: Virada (Fill A)'
                    : 'Pedal 1: Tocar Intro'}
                </button>
                <button
                  type="button"
                  onClick={handlePedal2Tap}
                  className="px-3 py-2 rounded-xl text-xs font-bold bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 transition-all cursor-pointer"
                >
                  {isPlaying
                    ? basePartId === 'part_b'
                      ? 'Pedal 2: Transição B ➔ A'
                      : 'Pedal 2: Transição A ➔ B'
                    : selectedStartPart === 'part_b'
                    ? 'Pedal 2: Ir p/ Parte A'
                    : 'Pedal 2: Ir p/ Parte B'}
                </button>
              </div>
            </div>

            {/* Song Parts Navigation Bar */}
            <SongPartsBar
              project={project}
              activePartId={activePartId}
              playingPartId={playingPartId}
              selectedStartPart={selectedStartPart}
              basePartId={basePartId}
              isPlaying={isPlaying}
              onSelectPart={handleSelectPart}
              onOpenCopyModal={() => setIsCopyPartOpen(true)}
              onClearPart={handleClearPart}
            />

            {/* Multi-Track Step Sequencer Matrix */}
            <SequencerGrid
              tracks={project.tracks}
              partSteps={currentPartData.trackSteps}
              partStepCounts={currentPartData.trackStepCounts}
              activePartId={activePartId}
              playingTick={currentTick}
              activeTrackSteps={activeTrackSteps}
              isPlaying={isPlaying}
              resolution={project.resolution || '1/16'}
              barsCount={project.barsCount || 1}
              timeSignature={project.timeSignature}
              onResolutionChange={handleResolutionChange}
              onBarsCountChange={handleBarsCountChange}
              onToggleStep={handleToggleStep}
              onUpdateStep={handleUpdateStep}
              onUpdateTrackLength={handleUpdateTrackLength}
              onUpdateTrackVolume={(tId, vol) => handleUpdateTrackParams(tId, { volume: vol })}
              onUpdateTrackPan={(tId, pan) => handleUpdateTrackParams(tId, { pan })}
              onToggleTrackMute={handleToggleTrackMute}
              onToggleTrackSolo={handleToggleTrackSolo}
              onTriggerTrack={handleTriggerTrack}
              onOpenTrackSettings={setEditingTrack}
              onDeleteTrack={handleDeleteTrack}
              onRemoveTrackSample={handleRemoveTrackSample}
              onAddTrackClick={() => setIsAddTrackOpen(true)}
            />
          </div>
        )}

        {/* View 2: BeatBuddy Pedal Live View */}
        {activeView === 'pedal' && (
          <div className="flex-1 p-3 sm:p-6 flex flex-col justify-start items-center gap-4 max-w-4xl mx-auto w-full">
            {/* Quick Song Selector & Live Controls */}
            <div className="w-full bg-[#0b101d] p-3 sm:p-4 rounded-2xl border border-slate-800 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-400">Ritmo Atual:</span>
                <select
                  value={project.id}
                  onChange={(e) => {
                    const sel = rhythms.find((r) => r.id === e.target.value);
                    if (sel) {
                      setProject(sel);
                      audioEngine.updateProject(sel);
                    }
                  }}
                  className="bg-slate-900 border border-slate-700 text-white font-bold text-xs sm:text-sm px-3 py-1.5 rounded-lg focus:outline-hidden focus:border-amber-400 cursor-pointer"
                >
                  {rhythms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.bpm} BPM - {r.timeSignature})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setIsCreateRhythmOpen(true)}
                  className="px-2.5 py-1.5 text-xs font-semibold bg-amber-400/20 hover:bg-amber-400/30 text-amber-300 border border-amber-400/30 rounded-lg cursor-pointer transition-colors"
                >
                  + Novo Ritmo
                </button>
              </div>

              {/* Quick BPM stepper */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-400">BPM:</span>
                <button
                  type="button"
                  onClick={() => handleBpmChange(Math.max(40, project.bpm - 5))}
                  className="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded cursor-pointer"
                >
                  -5
                </button>
                <button
                  type="button"
                  onClick={() => handleBpmChange(Math.max(40, project.bpm - 1))}
                  className="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded cursor-pointer"
                >
                  -1
                </button>
                <span className="font-mono font-extrabold text-amber-400 text-sm px-1.5">
                  {project.bpm}
                </span>
                <button
                  type="button"
                  onClick={() => handleBpmChange(Math.min(260, project.bpm + 1))}
                  className="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded cursor-pointer"
                >
                  +1
                </button>
                <button
                  type="button"
                  onClick={() => handleBpmChange(Math.min(260, project.bpm + 5))}
                  className="w-7 h-7 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded cursor-pointer"
                >
                  +5
                </button>
              </div>
            </div>

            {/* Song Parts Bar on Pedal view */}
            <div className="w-full">
              <SongPartsBar
                project={project}
                activePartId={activePartId}
                playingPartId={playingPartId}
                selectedStartPart={selectedStartPart}
                basePartId={basePartId}
                isPlaying={isPlaying}
                onSelectPart={handleSelectPart}
                onOpenCopyModal={() => setIsCopyPartOpen(true)}
                onClearPart={handleClearPart}
              />
            </div>

            {/* Unmute prompt for Mobile */}
            {!isAudioUnlocked && (
              <button
                type="button"
                onClick={() => {
                  audioEngine.unlockAudioContext();
                  audioEngine.preloadAllServerSamples();
                  setIsAudioUnlocked(true);
                }}
                className="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-extrabold px-4 py-2.5 rounded-xl text-center cursor-pointer shadow-lg animate-bounce text-xs sm:text-sm"
              >
                🔊 Toque aqui para ativar o áudio no celular (Sons 100% Fiéis)
              </button>
            )}

            <div className="w-full">
              <BeatBuddyDisplay
                songName={project.name}
                partName={playingPartData.name}
                partId={playingPartId}
                basePartId={basePartId}
                selectedStartPart={selectedStartPart}
                activeFillId={activeFillId}
                activeTransitionId={activeTransitionId}
                bpm={project.bpm}
                timeSignature={project.timeSignature}
                currentBeat={currentBeat}
                currentBar={currentBar}
                subdivision={subdivision}
                isPlaying={isPlaying}
                isFill={isFill}
                isTransition={isTransition}
                isOutro={isOutro}
                isIntro={isIntro}
              />
            </div>

            <div className="w-full">
              <PedalController
                isPlaying={isPlaying}
                currentPartId={playingPartId}
                basePartId={basePartId}
                selectedStartPart={selectedStartPart}
                isFill={isFill}
                isTransition={isTransition}
                isOutro={isOutro}
                isIntro={isIntro}
                activeFillId={activeFillId}
                activeTransitionId={activeTransitionId}
                isExternalPedal1Pressed={isExternalPedal1Pressed}
                isExternalPedal2Pressed={isExternalPedal2Pressed}
                onPedal1Tap={handlePedal1Tap}
                onPedal1HoldStart={handlePedal1HoldStart}
                onPedal2Tap={handlePedal2Tap}
                onStop={handleStop}
                onOpenFootswitchConfig={() => setIsFootswitchConfigOpen(true)}
              />
            </div>
          </div>
        )}

        {/* View 3: My Samples & Audio Recording */}
        {activeView === 'samples' && (
          <SamplesLibraryView
            onAddTrackWithSample={handleAddTrackWithSample}
            onDeleteSample={handleDeleteSample}
            onRenameSample={handleRenameSample}
            customSamplesList={customSamplesList}
          />
        )}
      </main>

      {/* Track Sound & Custom Sample Modal */}
      {editingTrack && (
        <SampleManagerModal
          track={editingTrack}
          onClose={() => setEditingTrack(null)}
          onUpdateTrackParams={handleUpdateTrackParams}
        />
      )}

      {/* Add New Instrument Modal */}
      {isAddTrackOpen && (
        <AddInstrumentModal
          onClose={() => setIsAddTrackOpen(false)}
          onAddTrack={handleAddTrack}
          onDeleteSample={handleDeleteSample}
        />
      )}

      {/* Create New Rhythm Modal */}
      {isCreateRhythmOpen && (
        <CreateRhythmModal
          onClose={() => setIsCreateRhythmOpen(false)}
          onCreate={handleCreateNewRhythm}
        />
      )}

      {/* Delete Rhythm Confirmation Modal */}
      {isDeleteRhythmOpen && (
        <DeleteRhythmModal
          rhythm={project}
          canDelete={rhythms.length > 1}
          onClose={() => setIsDeleteRhythmOpen(false)}
          onConfirmDelete={handleDeleteRhythm}
        />
      )}

      {/* Copy Part Modal */}
      {isCopyPartOpen && (
        <CopyPartModal
          project={project}
          currentActivePartId={activePartId}
          onClose={() => setIsCopyPartOpen(false)}
          onCopyPart={handleCopyPart}
        />
      )}

      {/* Footswitch / Cuvave Pedal & MIDI Config Modal */}
      {isFootswitchConfigOpen && (
        <FootswitchConfigModal
          onClose={() => setIsFootswitchConfigOpen(false)}
        />
      )}

      {/* Mobile PWA, APK Android and iPhone Guide Modal */}
      {isMobileGuideOpen && (
        <MobileAndPedalGuideModal
          onClose={() => setIsMobileGuideOpen(false)}
          onOpenPedalSettings={() => setIsFootswitchConfigOpen(true)}
        />
      )}

      {/* Share / Open on Mobile Modal */}
      <ShareMobileModal
        isOpen={isShareMobileOpen}
        onClose={() => setIsShareMobileOpen(false)}
        currentProject={project}
        samplesCount={customSamplesList.length}
      />
    </div>
  );
}
