import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import { RADAR_LOCATION_TASK, SCANNING_STORAGE_KEY } from './radarTaskConstants';

// Must run at JS-bundle global scope (imported from index.js BEFORE expo-router/entry).
// This file is intentionally tiny: no expo-audio, no POI JSON, no React.
TaskManager.defineTask(RADAR_LOCATION_TASK, async (body) => {
  try {
    const scanningRaw = await AsyncStorage.getItem(SCANNING_STORAGE_KEY);
    if (scanningRaw !== 'true') {
      const Location = await import('expo-location');
      const running = await Location.hasStartedLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => false);
      if (running) await Location.stopLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => {});
      return;
    }
    const { handleRadarLocationTask } = await import('./radarLocationTask');
    await handleRadarLocationTask(body);
  } catch (err) {
    console.warn('[Radar] light task failed:', err);
  }
});
