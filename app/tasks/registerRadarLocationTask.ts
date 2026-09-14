import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import { RADAR_LOCATION_TASK, SCANNING_STORAGE_KEY } from './radarTaskConstants';

// Must run at JS-bundle global scope (imported from index.js BEFORE expo-router/entry).
// This file is intentionally tiny: no expo-audio, no POI JSON, no React.
TaskManager.defineTask(RADAR_LOCATION_TASK, async (body) => {
  // #region agent log
  fetch('http://127.0.0.1:7630/ingest/de13606f-ba56-41c9-af73-87b91ac29696',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ab38e3'},body:JSON.stringify({sessionId:'ab38e3',runId:'post-fix',hypothesisId:'D',location:'registerRadarLocationTask.ts',message:'light task invoked',data:{hasError:!!body.error},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
