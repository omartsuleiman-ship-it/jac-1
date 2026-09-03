import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  RadarPoi,
  angularDiff,
  bearingDegrees,
  boundingBoxFilter,
  getStaticPois,
  haversineMeters,
  loadUserPois,
} from '../services/radarService';

// ── Tunables ──
const NEARBY_RADIUS_KM = 5; // slice rendered on the map
const BOUNDING_BOX_KM = 2; // cheap pre-filter radius, run BEFORE any trig
const ALERT_RADIUS_M = 500; // Haversine alert threshold
const FORWARD_CONE_DEG = 45; // |heading - bearing| tolerance
const ALERT_DEBOUNCE_MS = 45000; // per-camera-id debounce (within the requested 30-60s window)
const LOCATION_TIME_INTERVAL_MS = 3000;
const LOCATION_DISTANCE_INTERVAL_M = 15;

// ── Storage keys ──
// This one is NOT namespaced to the radar feature on purpose: it must match
// STORAGE_KEY in app/(tabs)/_layout.tsx exactly, because the background task
// below can't read LangContext (no React tree exists when it runs headless)
// — it reads the same key the language toggle already persists to.
const LANGUAGE_STORAGE_KEY = 'app_language';
const SMART_ALERTS_STORAGE_KEY = '@radar_map/smart_alerts_v1';
const ALERT_DEBOUNCE_STORAGE_KEY = '@radar_map/alert_debounce_v1';

export const RADAR_LOCATION_TASK = 'radar-background-location-task';

// ── UI bridge ──
// The background task is the ONLY location subscription in this feature.
// When a screen with the map/speedometer is mounted, it registers a
// listener here so the same fix that drives alerting also drives the UI —
// no second GPS subscription. When there's no mounted UI (headless JS after
// the OS relaunches the app in the background), this set is simply empty;
// alerting below doesn't depend on it.
type LocationListener = (loc: Location.LocationObject) => void;
const uiListeners = new Set<LocationListener>();
const subscribeToRadarLocation = (cb: LocationListener) => {
  uiListeners.add(cb);
  return () => {
    uiListeners.delete(cb);
  };
};

type DebounceMap = Record<string, number>;

const loadDebounceMap = async (): Promise<DebounceMap> => {
  try {
    const raw = await AsyncStorage.getItem(ALERT_DEBOUNCE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DebounceMap) : {};
  } catch {
    return {};
  }
};

const saveDebounceMap = async (map: DebounceMap) => {
  try {
    await AsyncStorage.setItem(ALERT_DEBOUNCE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort — a failed write just risks one camera re-alerting a bit early.
  }
};

// ── Pre-recorded alert audio (expo-av) ──
// TTS couldn't be relied on to keep speaking with the screen off, so alerts
// are now short pre-recorded clips instead. Metro resolves require() paths
// statically at BUILD time — every path below must exist on disk or the
// whole bundle fails to build. Extend this the same way once you've
// recorded more clips; don't reference a limit here until both its files
// (ar + en) actually exist under assets/sounds/.
const RADAR_SOUNDS: Record<'ar' | 'en', Record<number, any>> = {
  en: {
    60: require('../assets/sounds/radar_60_en.mp3'),
    80: require('../assets/sounds/radar_80_en.mp3'),
    90: require('../assets/sounds/radar_90_en.mp3'),
    100: require('../assets/sounds/radar_100_en.mp3'),
    120: require('../assets/sounds/radar_120_en.mp3'),
  },
  ar: {
    60: require('../assets/sounds/radar_60_ar.mp3'),
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

// Runs once at module load — same timing guarantee as TaskManager.defineTask
// below, so playback is configured before the first alert can possibly
// fire, including on a cold headless-JS start with the screen off.
Audio.setAudioModeAsync({
  staysActiveInBackground: true,
  playsInSilentModeIOS: true,
  shouldDuckAndroid: true,
}).catch((err) => console.warn('[Radar] failed to configure audio mode:', err));

let currentSound: Audio.Sound | null = null;

const playRadarSound = async (poi: RadarPoi, isAr: boolean) => {
  const lang: 'ar' | 'en' = isAr ? 'ar' : 'en';
  const asset = (poi.maxspeed !== null && RADAR_SOUNDS[lang][poi.maxspeed]) || GENERIC_RADAR_SOUND[lang];

  try {
    // Only one clip should ever be audible at a time.
    if (currentSound) {
      await currentSound.unloadAsync().catch(() => {});
      currentSound = null;
    }
    const { sound } = await Audio.Sound.createAsync(asset, { shouldPlay: true });
    currentSound = sound;
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        if (currentSound === sound) currentSound = null;
      }
    });
  } catch (err) {
    console.warn('[Radar] failed to play alert sound:', err);
  }
};

// Same gating speakBilingual() used to do: smart mode only interrupts the
// driver if they're actually over the limit (staying silent when the limit
// is unknown, rather than guessing); non-smart mode announces every camera.
const shouldTriggerAlert = (poi: RadarPoi, speedKmh: number, smartAlertsEnabled: boolean): boolean => {
  if (!smartAlertsEnabled) return true;
  const hasLimit = poi.maxspeed !== null && poi.maxspeed !== undefined;
  return hasLimit && speedKmh > (poi.maxspeed as number);
};

// ── The background task itself. defineTask() must run at module scope
// (unconditionally, on import) so it's registered before
// startLocationUpdatesAsync references it by name — this is why this file,
// not a component body, is where it lives. ──
TaskManager.defineTask(RADAR_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[Radar] background location task error:', error);
    return;
  }

  const { locations } = (data as { locations: Location.LocationObject[] }) || { locations: [] };
  const loc = locations?.[locations.length - 1];
  if (!loc) return;

  // Feed any mounted screen (map/speedometer) with this same fix.
  uiListeners.forEach((cb) => cb(loc));

  const { latitude, longitude, heading, speed } = loc.coords;
  const speedKmh = speed && speed > 0 ? speed * 3.6 : 0;

  // Read settings fresh every invocation. This task may run in a headless
  // JS instance with nothing else mounted, so it can't read React context —
  // it reads the same AsyncStorage keys the foreground UI writes to.
  const [smartAlertsRaw, langRaw] = await Promise.all([
    AsyncStorage.getItem(SMART_ALERTS_STORAGE_KEY),
    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY),
  ]);
  const smartAlertsEnabled = smartAlertsRaw === 'true';
  const isAr = langRaw !== 'en'; // _layout.tsx also defaults to 'ar' when nothing is saved yet

  const userPois = await loadUserPois();
  const allPois = [...getStaticPois(), ...userPois];

  // Bounding box FIRST — Haversine/bearing only ever run over what's left.
  const candidates = boundingBoxFilter(allPois, latitude, longitude, BOUNDING_BOX_KM);
  if (candidates.length === 0) return;

  const debounceMap = await loadDebounceMap();
  const now = Date.now();
  let debounceDirty = false;

  for (const poi of candidates) {
    if (poi.type !== 'radar') continue; // bumps/comments are map-only, no TTS
    const distance = haversineMeters(latitude, longitude, poi.latitude, poi.longitude);
    if (distance > ALERT_RADIUS_M) continue;

    // heading is -1 (or unset) when the device has no reliable course —
    // typically stationary or a weak fix. Skip the forward-facing check
    // rather than risk never alerting at all.
    if (heading !== null && heading !== undefined && heading >= 0) {
      const bearing = bearingDegrees(latitude, longitude, poi.latitude, poi.longitude);
      if (angularDiff(heading, bearing) >= FORWARD_CONE_DEG) continue;
    }

    const last = debounceMap[poi.id] ?? 0;
    if (now - last < ALERT_DEBOUNCE_MS) continue;

    if (shouldTriggerAlert(poi, speedKmh, smartAlertsEnabled)) {
      await playRadarSound(poi, isAr);
      debounceMap[poi.id] = now;
      debounceDirty = true;
    }
  }

  if (debounceDirty) await saveDebounceMap(debounceMap);
});

// ── Context ──
interface RadarContextValue {
  location: Location.LocationObject | null;
  nearbyPois: RadarPoi[]; // 5km slice, for map rendering
  foregroundPermissionGranted: boolean;
  backgroundPermissionGranted: boolean; // must be true for alerts to survive screen-off
  smartAlertsEnabled: boolean;
  setSmartAlertsEnabled: (val: boolean) => void;
  refreshPois: () => Promise<void>; // call after saving a new user POI
}

const RadarContext = createContext<RadarContextValue | null>(null);

export const useRadar = (): RadarContextValue => {
  const ctx = useContext(RadarContext);
  if (!ctx) throw new Error('useRadar must be used within a RadarProvider');
  return ctx;
};

export const stopRadarBackgroundTracking = () => Location.stopLocationUpdatesAsync(RADAR_LOCATION_TASK);

function useRadarEngine() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [nearbyPois, setNearbyPois] = useState<RadarPoi[]>([]);
  const [foregroundPermissionGranted, setForegroundPermissionGranted] = useState(false);
  const [backgroundPermissionGranted, setBackgroundPermissionGranted] = useState(false);

  const allPoisRef = useRef<RadarPoi[]>([]);
  // Last known fix, kept outside React state so refreshPois() (called right
  // after saving a POI) can recompute the visible marker set immediately —
  // without this, a newly-saved POI wouldn't render until the next GPS tick,
  // which could be many seconds away or not come at all while stationary.
  const lastLocationRef = useRef<{ latitude: number; longitude: number } | null>(null);

  const refreshPois = useCallback(async () => {
    const userPois = await loadUserPois();
    allPoisRef.current = [...getStaticPois(), ...userPois];
    if (lastLocationRef.current) {
      setNearbyPois(
        boundingBoxFilter(allPoisRef.current, lastLocationRef.current.latitude, lastLocationRef.current.longitude, NEARBY_RADIUS_KM)
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await refreshPois(); // populate allPoisRef first so the filter below has something to filter

      // Instant-load path: use whatever fix the OS already has cached (or a
      // quick low-accuracy fix) so the map centers and markers render right
      // away, instead of waiting 20-30s for the first BestForNavigation fix
      // from startLocationUpdatesAsync below. If permission isn't granted
      // yet, both calls just throw — caught and ignored; the normal
      // high-accuracy watcher will populate location once it's granted.
      try {
        let quick = await Location.getLastKnownPositionAsync({
          maxAge: 5 * 60 * 1000,
          requiredAccuracy: 5000,
        });
        if (!quick) {
          quick = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
        }
        if (cancelled || !quick) return;
        setLocation(quick);
        lastLocationRef.current = { latitude: quick.coords.latitude, longitude: quick.coords.longitude };
        setNearbyPois(
          boundingBoxFilter(allPoisRef.current, quick.coords.latitude, quick.coords.longitude, NEARBY_RADIUS_KM)
        );
      } catch {
        // Best-effort — see comment above.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshPois]);

  // Drives the map/speedometer only — alerting lives entirely in the
  // TaskManager task above, so it behaves identically whether this screen
  // is mounted or not.
  useEffect(() => {
    const unsubscribe = subscribeToRadarLocation((loc) => {
      setLocation(loc);
      lastLocationRef.current = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
      setNearbyPois(
        boundingBoxFilter(allPoisRef.current, loc.coords.latitude, loc.coords.longitude, NEARBY_RADIUS_KM)
      );
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Check BEFORE requesting on both permissions. On iOS in particular,
      // calling request*PermissionsAsync() when the permission is already
      // granted at "Always" can stall or behave unreliably instead of just
      // resolving immediately — checking first sidesteps that entirely and
      // is also just correct behavior (never re-prompt for what you already have).
      let fgStatus = (await Location.getForegroundPermissionsAsync()).status;
      if (fgStatus !== 'granted') {
        fgStatus = (await Location.requestForegroundPermissionsAsync()).status;
      }
      if (cancelled) return;
      setForegroundPermissionGranted(fgStatus === 'granted');
      if (fgStatus !== 'granted') return;

      // Background permission is a SEPARATE grant from foreground on both
      // platforms (iOS: "Change to Always Allow" follow-up; Android 10+: a
      // second system dialog). Must be granted for updates to keep arriving
      // with the screen off / app backgrounded. Same check-before-request pattern.
      let bgStatus = (await Location.getBackgroundPermissionsAsync()).status;
      if (bgStatus !== 'granted') {
        bgStatus = (await Location.requestBackgroundPermissionsAsync()).status;
      }
      if (cancelled) return;
      setBackgroundPermissionGranted(bgStatus === 'granted');

      const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => false);
      if (alreadyRunning) return;

     await Location.startLocationUpdatesAsync(RADAR_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: LOCATION_TIME_INTERVAL_MS,
      distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true, // iOS: blue status-bar pill while tracking in bg
      foregroundService: {
        // Android: mandatory - this is the persistent notification that
        // keeps the OS from killing the process while backgrounded.
        notificationTitle: 'Radar alerts / تنبيهات الرادار',
        notificationBody: 'Tracking your location for speed camera alerts.',
      },
    });
    })();

    // Deliberately NOT stopping updates on unmount — the entire point of
    // this feature is to keep running when the radar screen (or the app)
    // isn't in the foreground. Call stopRadarBackgroundTracking() yourself
    // from wherever you want an explicit "stop tracking" control.
    return () => {
      cancelled = true;
    };
  }, []);

  return { location, nearbyPois, foregroundPermissionGranted, backgroundPermissionGranted, refreshPois };
}

export function RadarProvider({ children }: { children: React.ReactNode }) {
  const [smartAlertsEnabled, setSmartAlertsEnabledState] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SMART_ALERTS_STORAGE_KEY).then((saved) => {
      if (saved === 'true') setSmartAlertsEnabledState(true);
    });
  }, []);

  const setSmartAlertsEnabled = useCallback((val: boolean) => {
    setSmartAlertsEnabledState(val);
    AsyncStorage.setItem(SMART_ALERTS_STORAGE_KEY, val ? 'true' : 'false').catch(() => {});
  }, []);

  const engine = useRadarEngine();

  return (
    <RadarContext.Provider value={{ ...engine, smartAlertsEnabled, setSmartAlertsEnabled }}>
      {children}
    </RadarContext.Provider>
  );
}
