import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import type { RadarPoi } from '../services/radarService';

const RADAR_SOUNDS: Record<'ar' | 'en', Record<number, any>> = {
  en: {
    40: require('../assets/sounds/radar_40_en.mp3'),
    50: require('../assets/sounds/radar_50_en.mp3'),
    60: require('../assets/sounds/radar_60_en.mp3'),
    70: require('../assets/sounds/radar_70_en.mp3'),
    80: require('../assets/sounds/radar_80_en.mp3'),
    90: require('../assets/sounds/radar_90_en.mp3'),
    100: require('../assets/sounds/radar_100_en.mp3'),
    120: require('../assets/sounds/radar_120_en.mp3'),
  },
  ar: {
    40: require('../assets/sounds/radar_40_ar.mp3'),
    50: require('../assets/sounds/radar_50_ar.mp3'),
    60: require('../assets/sounds/radar_60_ar.mp3'),
    70: require('../assets/sounds/radar_70_ar.mp3'),
    80: require('../assets/sounds/radar_80_ar.mp3'),
    90: require('../assets/sounds/radar_90_ar.mp3'),
    100: require('../assets/sounds/radar_100_ar.mp3'),
    120: require('../assets/sounds/radar_120_ar.mp3'),
  },
};

const GENERIC_RADAR_SOUND: Record<'ar' | 'en', any> = {
  en: require('../assets/sounds/radar_general_en.mp3'),
  ar: require('../assets/sounds/radar_general_ar.mp3'),
};

let audioModeConfigured = false;
const ensureAudioModeConfigured = async () => {
  if (audioModeConfigured) return;
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'duckOthers',
    shouldPlayInBackground: true,
  });
  audioModeConfigured = true;
};

const ALERT_CLIP_WAIT_MS = 4000;
let currentPlayer: AudioPlayer | null = null;

export const playRadarSound = async (poi: RadarPoi, isAr: boolean) => {
  const lang: 'ar' | 'en' = isAr ? 'ar' : 'en';
  const asset = (poi.maxspeed !== null && RADAR_SOUNDS[lang][poi.maxspeed]) || GENERIC_RADAR_SOUND[lang];

  try {
    await ensureAudioModeConfigured();
    const player = createAudioPlayer(asset);
    currentPlayer = player;
    player.play();
    await new Promise((resolve) => setTimeout(resolve, ALERT_CLIP_WAIT_MS));
  } catch (err) {
    console.warn('[Radar] failed to play alert sound:', err);
  } finally {
    if (currentPlayer) {
      currentPlayer.release();
      currentPlayer = null;
    }
  }
};

export const stopAndRestoreCurrentSound = async () => {
  if (currentPlayer) {
    try {
      currentPlayer.release();
    } catch {
      // Already released or never fully initialized — harmless.
    }
    currentPlayer = null;
  }
};
