import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import type { TaskManagerTaskBody } from 'expo-task-manager';
import { getObdSpeedKmh } from '../services/obdSpeedStore';
import {
  type RadarPoi,
  angularDiff,
  bearingDegrees,
  boundingBoxFilter,
  getStaticPois,
  haversineMeters,
  loadUserPois,
} from '../services/radarService';
import {
  ALERT_MEMORY_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  RADAR_LOCATION_TASK,
  SCANNING_STORAGE_KEY,
  SMART_ALERTS_STORAGE_KEY,
  SPEED_NOISE_GATE_KMH,
} from './radarTaskConstants';

export { LOCATION_DISTANCE_INTERVAL_M, LOCATION_TIME_INTERVAL_MS, RADAR_LOCATION_TASK, SCANNING_STORAGE_KEY, SMART_ALERTS_STORAGE_KEY, SPEED_NOISE_GATE_KMH } from './radarTaskConstants';

const BOUNDING_BOX_KM = 2;
const ALERT_RADIUS_M = 500;
const CLOSE_PASS_RADIUS_M = 60;
const PASSED_RADAR_COOLDOWN_MS = 180000;
const ALERT_DEBOUNCE_MS = 90000;
const IDLE_SPEED_THRESHOLD_KMH = SPEED_NOISE_GATE_KMH;
const IDLE_AFTER_MS = 40000;
const TWIN_RADAR_RADIUS_M = 180;
const U_TURN_HEADING_DELTA_DEG = 90;
const TASK_MIN_INTERVAL_MS = 900;
const POI_CACHE_TTL_MS = 60000;
const MAX_RELATIVE_BEARING_DEG = 65;

type LocationListener = (loc: Location.LocationObject) => void;
const uiListeners = new Set<LocationListener>();
export const subscribeToRadarLocation = (cb: LocationListener) => {
  uiListeners.add(cb);
  return () => {
    uiListeners.delete(cb);
  };
};

let stationarySinceMs: number | null = null;
let radarIsIdle = false;

export const updateIdleTracking = (speedKmh: number): boolean => {
  if (speedKmh >= IDLE_SPEED_THRESHOLD_KMH) {
    stationarySinceMs = null;
    radarIsIdle = false;
    return false;
  }
  if (stationarySinceMs === null) stationarySinceMs = Date.now();
  radarIsIdle = Date.now() - stationarySinceMs >= IDLE_AFTER_MS;
  return radarIsIdle;
};

export const isRadarIdle = () => radarIsIdle;

const passedRadarLedger: Record<string, number> = {};
let handlerBusy = false;
let alertCooldownUntil = 0;
let lastTaskRunAt = 0;
let cachedAllPois: RadarPoi[] | null = null;
let cachedAllPoisAt = 0;

const getCachedAllPois = async (): Promise<RadarPoi[]> => {
  const now = Date.now();
  if (cachedAllPois && now - cachedAllPoisAt < POI_CACHE_TTL_MS) return cachedAllPois;
  const userPois = await loadUserPois();
  cachedAllPois = [...getStaticPois(), ...userPois];
  cachedAllPoisAt = now;
  return cachedAllPois;
};

export const invalidatePoiCache = () => {
  cachedAllPois = null;
};

const toRadLocal = (deg: number) => (deg * Math.PI) / 180;

const projectAlongAndCrossTrack = (
  distanceM: number,
  headingDeg: number,
  bearingDeg: number
): { alongTrackM: number; crossTrackM: number } => {
  const relative = toRadLocal(bearingDeg - headingDeg);
  return {
    alongTrackM: distanceM * Math.cos(relative),
    crossTrackM: distanceM * Math.sin(relative),
  };
};

const corridorHalfWidthM = (distanceM: number): number => Math.min(90, 20 + distanceM * 0.12);

interface LastAlertMemory {
  id: string;
  latitude: number;
  longitude: number;
  heading: number;
  timestamp: number;
}

const loadLastAlertMemory = async (): Promise<LastAlertMemory | null> => {
  try {
    const raw = await AsyncStorage.getItem(ALERT_MEMORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LastAlertMemory) : null;
  } catch {
    return null;
  }
};

const saveLastAlertMemory = async (memory: LastAlertMemory | null) => {
  try {
    if (memory) {
      await AsyncStorage.setItem(ALERT_MEMORY_STORAGE_KEY, JSON.stringify(memory));
    } else {
      await AsyncStorage.removeItem(ALERT_MEMORY_STORAGE_KEY);
    }
  } catch {
    // Best-effort
  }
};

const shouldTriggerAlert = (poi: RadarPoi, speedKmh: number, smartAlertsEnabled: boolean): boolean => {
  if (!smartAlertsEnabled) return true;
  const hasLimit = poi.maxspeed !== null && poi.maxspeed !== undefined;
  return hasLimit && speedKmh > (poi.maxspeed as number);
};

export const stopRadarBackgroundTracking = () => Location.stopLocationUpdatesAsync(RADAR_LOCATION_TASK);
export const stopAndRestoreCurrentSound = async (): Promise<void> => {
  // Placeholder: expo-audio sound cleanup (if any) goes here.
  // Currently a no-op — alertPlaybackInFlight is timestamp-based now.
};

export const handleRadarLocationTask = async ({ data, error }: TaskManagerTaskBody) => {
  if (error) { console.warn('[Radar] background location task error:', error); return; }
  if (handlerBusy) return;

  const nowMs = Date.now();
  if (nowMs - lastTaskRunAt < TASK_MIN_INTERVAL_MS) return;
  lastTaskRunAt = nowMs;

  handlerBusy = true;

  try {
    const { locations } = (data as { locations: Location.LocationObject[] }) || { locations: [] };
    const loc = locations?.[locations.length - 1];
    if (!loc) return;

    const scanningRaw = await AsyncStorage.getItem(SCANNING_STORAGE_KEY);
    if (scanningRaw !== 'true') return;

    uiListeners.forEach((cb) => cb(loc));

    const { latitude, longitude, heading } = loc.coords;

    // OBD Speed Fallback: if getObdSpeedKmh() returns 0 or is missing, fall back to GPS speed
    let speedKmh = getObdSpeedKmh();
    if (!speedKmh) {
      speedKmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
    }

    if (updateIdleTracking(speedKmh)) return;
    if (Date.now() < alertCooldownUntil) return;

    const [smartAlertsRaw, langRaw] = await Promise.all([
      AsyncStorage.getItem(SMART_ALERTS_STORAGE_KEY),
      AsyncStorage.getItem(LANGUAGE_STORAGE_KEY),
    ]);
    const smartAlertsEnabled = smartAlertsRaw === 'true';
    const isAr = langRaw !== 'en';

    const allPois = await getCachedAllPois();
    const candidates = boundingBoxFilter(allPois, latitude, longitude, BOUNDING_BOX_KM).sort(
      (a, b) =>
        haversineMeters(latitude, longitude, a.latitude, a.longitude) -
        haversineMeters(latitude, longitude, b.latitude, b.longitude)
    );
    if (candidates.length === 0) return;

    let activeAlert = await loadLastAlertMemory();

    for (const poi of candidates) {
      if (poi.type !== 'radar') continue;
      const distance = haversineMeters(latitude, longitude, poi.latitude, poi.longitude);

      if (distance <= CLOSE_PASS_RADIUS_M) {
        passedRadarLedger[poi.id] = Date.now();
      }

      if (distance > ALERT_RADIUS_M) continue;

      const passedAt = passedRadarLedger[poi.id];
      if (passedAt !== undefined && Date.now() - passedAt < PASSED_RADAR_COOLDOWN_MS) continue;

      if (heading === null || heading === undefined || heading < 0) continue;
      const bearing = bearingDegrees(latitude, longitude, poi.latitude, poi.longitude);

      if (angularDiff(heading, bearing) > MAX_RELATIVE_BEARING_DEG) continue;

      const { alongTrackM, crossTrackM } = projectAlongAndCrossTrack(distance, heading, bearing);
      if (alongTrackM <= 0) continue;
      if (Math.abs(crossTrackM) > corridorHalfWidthM(distance)) continue;

      if (activeAlert) {
        const headingSwing = angularDiff(heading, activeAlert.heading);
        const isUTurn = headingSwing > U_TURN_HEADING_DELTA_DEG;
        if (isUTurn) {
          activeAlert = null;
        } else {
          const distanceToActive = haversineMeters(
            poi.latitude,
            poi.longitude,
            activeAlert.latitude,
            activeAlert.longitude
          );
          const stillFresh = Date.now() - activeAlert.timestamp < ALERT_DEBOUNCE_MS;
          if (distanceToActive <= TWIN_RADAR_RADIUS_M && stillFresh) continue;
        }
      }

      if (shouldTriggerAlert(poi, speedKmh, smartAlertsEnabled)) {
        activeAlert = { id: poi.id, latitude: poi.latitude, longitude: poi.longitude, heading, timestamp: Date.now() };

        const lang = isAr ? 'ar' : 'en';
        const SUPPORTED = [40, 50, 60, 70, 80, 90, 100, 120];
        const maxspeed = poi.maxspeed as number;
        const speed = maxspeed && SUPPORTED.includes(maxspeed) ? maxspeed : null;
        const sound = speed ? `radar_${speed}_${lang}.wav` : `radar_general_${lang}.wav`;

        const label = speed
          ? (lang === 'ar' ? `رادار ${speed} كم/س` : `Speed Camera ${speed} km/h`)
          : (lang === 'ar' ? 'رادار أمامك' : 'Speed Camera Ahead');

        await Notifications.scheduleNotificationAsync({
          content: {
            title: label,
            body: ' ',
            sound: sound,
            priority: Notifications.AndroidNotificationPriority.MAX,
          },
          trigger: null,
        });

        alertCooldownUntil = Date.now() + 4000; // replaces the 4-second sleep
        await saveLastAlertMemory(activeAlert);
        break; // one alert per pass
      }
    }
  } catch (err) {
    console.error("Radar Task Error:", err);
  } finally {
    handlerBusy = false;
  }
};
