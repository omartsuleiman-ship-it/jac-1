import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getObdSpeedKmh, subscribeObdSpeed } from '../services/obdSpeedStore';
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
// FORWARD_CONE_DEG (bare angular cone) removed — replaced by the
// along-track/cross-track corridor check further down. A 45° cone at 500m
// tolerates ~354m of lateral spread (500·sin45°), wide enough to catch a
// radar on a road merely crossing underneath (overpass) or nearby but
// unrelated. The corridor check asks the geometrically correct question:
// "how far sideways from my actual line of travel is this point", which
// stays road-width-sized regardless of distance.
const CLOSE_PASS_RADIUS_M = 60; // within this, you've physically driven beside the camera
const PASSED_RADAR_COOLDOWN_MS = 180000; // 3 min — covers a typical ramp/slip-road curve-back
// Bumped past the original 30-60s window on purpose: at 700m, a driver at
// city speeds (~40 km/h) can take 60s+ to cross the whole zone before
// reaching the camera. A 45s cooldown would let the exact loop you're
// trying to prevent happen mid-zone. 90s comfortably covers that crossing
// time at any speed you'd realistically be driving when this fires.
const ALERT_DEBOUNCE_MS = 90000;
const LOCATION_TIME_INTERVAL_MS = 1000; // 1s — was 3000, this was the visible speedometer lag
const LOCATION_DISTANCE_INTERVAL_M = 1; // 1m — was 15, too coarse for real-time speed
// Below this, GPS speed is treated as noise (multipath reflections, drift)
// rather than real motion — without it, a parked car could show ~10+ km/h,
// or even trigger a false "you're speeding" smart alert.
export const SPEED_NOISE_GATE_KMH = 5;

// ── Smart Caching / Pre-fetch ──
// NEARBY_RADIUS_KM above is the render slice; this is the POI source's
// fetch radius. Once the driver has crossed 70% of it since the last fetch
// center, refresh in the background so there's never a blind spot at the edge.
const POI_FETCH_RADIUS_KM = 10;
const PREFETCH_TRIGGER_KM = POI_FETCH_RADIUS_KM * 0.7; // 7km

// ── Smart Idle (CPU/battery throttle) ──
const IDLE_SPEED_THRESHOLD_KMH = SPEED_NOISE_GATE_KMH;
const IDLE_AFTER_MS = 40000; // 40 consecutive seconds stationary before we start skipping work

// ── Storage keys ──
// This one is NOT namespaced to the radar feature on purpose: it must match
// STORAGE_KEY in app/(tabs)/_layout.tsx exactly, because the background task
// below can't read LangContext (no React tree exists when it runs headless)
// — it reads the same key the language toggle already persists to.
const LANGUAGE_STORAGE_KEY = 'app_language';
const SMART_ALERTS_STORAGE_KEY = '@radar_map/smart_alerts_v1';
// Replaces the old per-camera-id debounce map. Instead of remembering every
// camera ever alerted, this remembers only the SINGLE most recent alert
// (which POI, where, and the heading at that moment) — just enough to spot
// "this new candidate is the twin-lane copy of the one I just played",
// without permanently blocking a genuine return-trip camera after a U-turn.
const ALERT_MEMORY_STORAGE_KEY = '@radar_map/last_alert_memory_v1';
const TWIN_RADAR_RADIUS_M = 100; // parallel-lane radars mapped this close are treated as one alert
const U_TURN_HEADING_DELTA_DEG = 90; // heading swing past this = a genuine U-turn, not just a curve

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

// Module-level (not React state) on purpose: the background TaskManager
// task can run headless with no React tree mounted, so this is the only
// thing both it and any mounted screen can share to agree on "are we idle".
let stationarySinceMs: number | null = null;
let radarIsIdle = false;

const updateIdleTracking = (speedKmh: number): boolean => {
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

// ── Close-Pass Ledger (Edge Case 1: "ghost" radar after a curve/slip road) ──
// Geometry-based, NOT tied to whether an alert actually fired — a radar you
// were under the speed limit for (Smart mode, no sound played) still needs
// to be remembered as passed, otherwise a curve/ramp that swings your
// heading back toward it slips through the corridor check and falsely
// re-alerts. Module-level for the same headless-task reason as
// stationarySinceMs/radarIsIdle above.
const passedRadarLedger: Record<string, number> = {};

const toRadLocal = (deg: number) => (deg * Math.PI) / 180;

// ── Along-track / cross-track corridor (Edge Case 2: overpass / crossing
// road) ── Decomposes the vector to a candidate radar into how far AHEAD
// (along my heading) and how far SIDEWAYS (perpendicular to my heading) it
// is. A point on my own road stays within a small, near-constant sideways
// offset as I approach; a point on a different, merely nearby road (classic
// case: a lower road crossing under an overpass) will generally sit well
// outside that corridor except right at the crossing point itself.
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

// Corridor half-width in meters: a couple of lanes plus margin close in,
// widening mildly with distance to absorb GPS heading noise, but capped
// well short of what the old 45° cone allowed at range.
const corridorHalfWidthM = (distanceM: number): number => Math.min(45, 20 + distanceM * 0.03);

interface LastAlertMemory {
  id: string;
  latitude: number;
  longitude: number;
  heading: number; // vehicle heading at the moment this alert fired
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
    // Best-effort — worst case a twin-lane radar isn't muted once, or a stale mute lingers briefly.
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

// Runs once at module load — same timing guarantee as TaskManager.defineTask
// below, so playback is configured before the first alert can possibly
// fire, including on a cold headless-JS start with the screen off.
const DUCKED_AUDIO_MODE = {
  staysActiveInBackground: true,
  playsInSilentModeIOS: true,
  // Duck (lower, not pause) whatever's already playing — Spotify, Apple
  // Music, podcasts, etc. — for the duration of the radar clip, then restore
  // it automatically when playback stops. Both platforms need to be told
  // explicitly; iOS and Android each ignore the other's flag.
  interruptionModeIOS: InterruptionModeIOS.DuckOthers,
  shouldDuckAndroid: true,
  interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
} as const;

// Symmetric with DUCKED_AUDIO_MODE on purpose — every field the duck mode
// sets gets an explicit counterpart here, rather than omitting fields and
// hoping expo-av defaults them back sanely.
const RESTORED_AUDIO_MODE = {
  staysActiveInBackground: true,
  playsInSilentModeIOS: true,
  interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
  // No interruptionModeAndroid here on purpose: your installed expo-av
  // types don't expose a MixWithOthers member for Android, and DoNotMix
  // would be actively wrong (it seizes audio focus instead of releasing
  // it). shouldDuckAndroid: false is what actually does the un-ducking on
  // Android — the interruption-mode enum there only meaningfully
  // distinguishes DoNotMix vs DuckOthers while something IS ducking.
  shouldDuckAndroid: false,
} as const;

Audio.setAudioModeAsync(DUCKED_AUDIO_MODE).catch((err) =>
  console.warn('[Radar] failed to configure audio mode:', err)
);

let currentSound: Audio.Sound | null = null;
// Monotonically increasing token identifying whichever alert most recently
// claimed the duck. This is what makes restoration correct regardless of
// HOW an alert's playback ends (natural finish, interrupted by a newer
// alert, explicit stop, unmount, or createAsync throwing) — the old design
// only restored from inside one specific sound's own didJustFinish
// callback, so any path that ended playback a different way left the
// session permanently ducked with nothing left to ever undo it.
let duckGeneration = 0;

// Idempotent and safe to call from any exit path, any number of times. Only
// actually restores when nothing newer has since claimed the duck — an
// older, now-abandoned sound's eventual "I finished" callback becomes a
// no-op instead of racing a newer alert's in-progress duck.
const restoreAudioMode = async (forGeneration: number) => {
  if (forGeneration !== duckGeneration) return; // a newer alert now owns the eventual restore
  try {
    await Audio.setAudioModeAsync(RESTORED_AUDIO_MODE);
  } catch (err) {
    console.warn('[Radar] failed to restore audio mode:', err);
  }
};

// Unloads whatever's currently playing, if anything, WITHOUT restoring —
// for callers about to immediately duck again for a new sound.
const unloadCurrentSound = async () => {
  const sound = currentSound;
  currentSound = null;
  if (sound) await sound.unloadAsync().catch(() => {});
};

// The one function every "this feature is stopping" path (explicit Stop
// Scan, screen unmount) must call. Stops whatever's audible right now AND
// guarantees the session actually gets un-ducked, even mid-alert.
export const stopAndRestoreCurrentSound = async () => {
  duckGeneration += 1; // invalidate any in-flight restore still tied to the sound we're about to kill
  await unloadCurrentSound();
  await restoreAudioMode(duckGeneration);
};

const playRadarSound = async (poi: RadarPoi, isAr: boolean) => {
  const lang: 'ar' | 'en' = isAr ? 'ar' : 'en';
  const asset = (poi.maxspeed !== null && RADAR_SOUNDS[lang][poi.maxspeed]) || GENERIC_RADAR_SOUND[lang];

  const myGeneration = ++duckGeneration; // this alert now owns the eventual restore

  try {
    // Only one clip should ever be audible at a time. No restore here on
    // purpose — myGeneration is about to duck again immediately below.
    await unloadCurrentSound();

    // Re-assert DuckOthers on every play — a previous alert may have already
    // restored the session on finish, so DuckOthers can't be assumed active.
    // staysActiveInBackground + playsInSilentModeIOS stay on continuously —
    // this is what lets iOS mix the clip into an active phone call route
    // (or play with the ringer switched to silent), same as Google Maps nav.
    await Audio.setAudioModeAsync(DUCKED_AUDIO_MODE);

    const { sound } = await Audio.Sound.createAsync(asset, { shouldPlay: true });
    currentSound = sound;

    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        if (status.error) console.warn('[Radar] alert sound playback error:', status.error);
        return;
      }
      if (status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        if (currentSound === sound) currentSound = null;
        restoreAudioMode(myGeneration);
      }
    });
  } catch (err) {
    console.warn('[Radar] failed to play alert sound:', err);
    // Playback never actually started — this generation has nothing left to
    // finish and fire didJustFinish, so restore immediately instead of
    // leaving the session ducked against a sound that will never complete.
    restoreAudioMode(myGeneration);
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

  const { latitude, longitude, heading } = loc.coords;
  // السرعة مصدرها OBD2 حصريًا (obdSpeedStore)، مش هذا الـ GPS fix — سرعة الـ
  // GPS متأخرة 1-5 ثواني عن الحقيقة، وده مرفوض لتنبيه رادار.
  const rawSpeedKmh = getObdSpeedKmh();
  const speedKmh = rawSpeedKmh < SPEED_NOISE_GATE_KMH ? 0 : rawSpeedKmh;

  // Smart Idle: once parked for 40+ consecutive seconds, skip the heavy
  // proximity math below entirely (bounding box + Haversine + bearing per
  // candidate) — nothing is moving, so there's nothing new to alert on.
  // Speed crossing back above the threshold resumes normal checks on the very next fix.
  if (updateIdleTracking(speedKmh)) return;

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

   let activeAlert = await loadLastAlertMemory();
  let alertMemoryDirty = false;

  for (const poi of candidates) {
    if (poi.type !== 'radar') continue; // bumps/comments are map-only, no TTS
    const distance = haversineMeters(latitude, longitude, poi.latitude, poi.longitude);

    // Close-Pass Ledger: stamped for EVERY radar candidate regardless of
    // distance/corridor/alert-radius, so it also catches cameras that would
    // otherwise be excluded right at the moment you're beside one (relative
    // bearing ~90° while actually passing it).
    if (distance <= CLOSE_PASS_RADIUS_M) {
      passedRadarLedger[poi.id] = Date.now();
    }

    if (distance > ALERT_RADIUS_M) continue;

    // Ghost-radar veto (Edge Case 1): recently driven past, still cooling
    // down — skip outright no matter what the current heading/corridor
    // says. This is what stops a slip-road curve or ramp from re-triggering
    // a camera that's actually behind you on the main road, independent of
    // whether an alert ever fired for it in the first place.
    const passedAt = passedRadarLedger[poi.id];
    if (passedAt !== undefined && Date.now() - passedAt < PASSED_RADAR_COOLDOWN_MS) continue;

    // Strict forward-only: if heading isn't reliable (device stationary or
    // a weak GPS course estimate — heading is -1/null then), do NOT alert.
    // This used to fall through and alert anyway, which is exactly what let
    // cameras on side roads or behind the car through.
    if (heading === null || heading === undefined || heading < 0) continue;
    const bearing = bearingDegrees(latitude, longitude, poi.latitude, poi.longitude);

    // Corridor check (Edge Case 2 — replaces the bare 45° cone): must be
    // genuinely ahead along my heading AND within a road-width-sized
    // sideways offset of my actual line of travel — not just anywhere
    // inside a wide angular cone.
    const { alongTrackM, crossTrackM } = projectAlongAndCrossTrack(distance, heading, bearing);
    if (alongTrackM <= 0) continue; // behind me along my heading — never alert
    if (Math.abs(crossTrackM) > corridorHalfWidthM(distance)) continue; // off to the side — different road

    // Twin-radar mute + U-turn bypass. Distance is measured POI-to-POI
    // (this candidate vs. the last alerted radar's own coordinates) — twin
    // parallel-lane radars sit close to EACH OTHER, not necessarily close
    // to the driver at the moment of this re-check.
    if (activeAlert) {
      const headingSwing = angularDiff(heading, activeAlert.heading);
      const isUTurn = headingSwing > U_TURN_HEADING_DELTA_DEG;
      if (isUTurn) {
        activeAlert = null; // instantly clear — the return-trip radar must be detected
      } else {
        const distanceToActive = haversineMeters(
          poi.latitude,
          poi.longitude,
          activeAlert.latitude,
          activeAlert.longitude
        );
        const stillFresh = Date.now() - activeAlert.timestamp < ALERT_DEBOUNCE_MS;
        if (distanceToActive <= TWIN_RADAR_RADIUS_M && stillFresh) continue; // muted: twin-lane radar
      }
    }

    if (shouldTriggerAlert(poi, speedKmh, smartAlertsEnabled)) {
      await playRadarSound(poi, isAr);
      activeAlert = { id: poi.id, latitude: poi.latitude, longitude: poi.longitude, heading, timestamp: Date.now() };
      alertMemoryDirty = true;
    }
  }

  if (alertMemoryDirty) await saveLastAlertMemory(activeAlert);
});

// ── Context ──
interface RadarContextValue {
  location: Location.LocationObject | null;
  nearbyPois: RadarPoi[]; // 5km slice, for map rendering
  foregroundPermissionGranted: boolean;
  backgroundPermissionGranted: boolean; // must be true for alerts to survive screen-off
  isScanning: boolean; // whether the background location task is actively running
  startScanning: () => void;
  stopScanning: () => void;
  smartAlertsEnabled: boolean;
  setSmartAlertsEnabled: (val: boolean) => void;
  refreshPois: () => Promise<void>; // call after saving a new user POI
  isIdle: boolean; // true after 40s+ stationary — heavy proximity/UI work is being skipped
  speedKmh: number; // OBD2-sourced vehicle speed — the only speed value the UI/alerts should use
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
  // Scanning is now a deliberate user action, not automatic on tab open —
  // startLocationUpdatesAsync only ever runs while this is true.
  const [isScanning, setIsScanning] = useState(false);

  const allPoisRef = useRef<RadarPoi[]>([]);
  // Last known fix, kept outside React state so refreshPois() (called right
  // after saving a POI) can recompute the visible marker set immediately —
  // without this, a newly-saved POI wouldn't render until the next GPS tick,
  // which could be many seconds away or not come at all while stationary.
  const lastLocationRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // Center point of the last POI fetch — compared against the live fix to
  // decide when a pre-fetch is due (see PREFETCH_TRIGGER_KM).
  const lastFetchCenterRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const [isIdle, setIsIdle] = useState(false);
  const isIdleRef = useRef(false);
  // مصدرها OBD2 (obdSpeedStore) — بتتعرض عن طريق الـ context عشان الـ UI
  // ومنطق التنبيه ميستخدموش location.coords.speed تاني خالص.
  const [speedKmh, setSpeedKmh] = useState(0);

  const refreshPois = useCallback(async (center?: { latitude: number; longitude: number }) => {
    const userPois = await loadUserPois();
    allPoisRef.current = [...getStaticPois(), ...userPois];
    const fetchCenter = center ?? lastLocationRef.current;
    if (fetchCenter) {
      lastFetchCenterRef.current = fetchCenter;
      setNearbyPois(
        boundingBoxFilter(allPoisRef.current, fetchCenter.latitude, fetchCenter.longitude, NEARBY_RADIUS_KM)
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await refreshPois(); // populate allPoisRef first so the filter below has something to filter

      // Instant-centering path: read ONLY the OS's already-cached fix
      // (getLastKnownPositionAsync) — this never activates the GPS radio,
      // so it costs nothing in battery and, just as importantly, never
      // lights up the location indicator before the user has pressed Start
      // Scan. The getCurrentPositionAsync() fallback that used to be here
      // was removed on purpose: it actively requests a fresh fix from
      // hardware, which is exactly what was firing GPS on every app open
      // regardless of isScanning. If there's no cached fix yet (fresh
      // install, simulator, GPS radio never used before), the map simply
      // stays on its default fallback region until scanning starts — that
      // trade-off is correct now that zero unsolicited GPS activity is the
      // actual requirement, not "center the map as fast as possible."
      try {
        const quick = await Location.getLastKnownPositionAsync({
          maxAge: 5 * 60 * 1000,
          requiredAccuracy: 5000,
        });
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
  // السرعة بقت بتيجي حصريًا من OBD2 (obdSpeedStore) مش GPS — سرعة الـ GPS
  // متأخرة 1-5 ثواني عن الحقيقة، مرفوض لتنبيه رادار. الـ effect ده مستقل عن
  // نبضات الـ GPS، فالسبيدوميتر وحساب الـ idle بيستجيبوا بسرعة الـ OBD نفسها،
  // مش لما يجي أقرب GPS fix بالصدفة.
  useEffect(() => {
    const unsubscribe = subscribeObdSpeed((rawKmh) => {
      const gatedKmh = rawKmh < SPEED_NOISE_GATE_KMH ? 0 : rawKmh;
      setSpeedKmh(gatedKmh);

      const idleNow = updateIdleTracking(gatedKmh);
      if (idleNow !== isIdleRef.current) {
        isIdleRef.current = idleNow;
        setIsIdle(idleNow);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToRadarLocation((loc) => {
      setLocation(loc);
      const { latitude, longitude } = loc.coords;
      lastLocationRef.current = { latitude, longitude };

      // Smart Idle: حالة الـ idle بقت متحكم فيها من سرعة الـ OBD (الـ effect
      // اللي فوق) — هنا بس بنقرأ العلم المشترك.
      if (isRadarIdle()) return;

      // Smart Caching / Pre-fetch: only re-hit the POI source once the
      // driver has drifted 7km (70% of the 10km fetch radius) from where
      // the last batch was centered, instead of on every single GPS tick.
      const center = lastFetchCenterRef.current;
      const driftedKm = center
        ? haversineMeters(center.latitude, center.longitude, latitude, longitude) / 1000
        : Infinity;

      if (driftedKm >= PREFETCH_TRIGGER_KM) {
        refreshPois({ latitude, longitude }).catch(() => {});
      } else {
        setNearbyPois(boundingBoxFilter(allPoisRef.current, latitude, longitude, NEARBY_RADIUS_KM));
      }
    });
    return unsubscribe;
  }, [refreshPois]);

  useEffect(() => {
    // Manual scan toggle: don't touch permissions or start anything until
    // the user explicitly presses "Start Scan". Re-runs every time
    // isScanning flips, in either direction.
    if (!isScanning) return;

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
      if (alreadyRunning || cancelled) return;

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

    // Aggressive cleanup, on purpose: fires both when isScanning flips back
    // to false (Stop Scan) and on unmount. Explicitly stopping the task —
    // not just letting it dangle — is what actually clears iOS's blue
    // location pill immediately and stops the battery drain, instead of
    // leaving a background task running silently after the user thinks
    // they've turned it off.
    return () => {
      cancelled = true;
      stopRadarBackgroundTracking().catch(() => {});
      stopAndRestoreCurrentSound().catch(() => {});
    };
  }, [isScanning]);

  const startScanning = useCallback(() => setIsScanning(true), []);
  // إيقاف صريح ومنتظر (awaited) — مش مجرد قلب الفلاج والانتظار إن الـ effect
  // cleanup يتصرف في وقته. ده اللي بيخلي الدايرة الزرقاء في iOS تختفي فورًا
  // لما المستخدم يدوس "إيقاف المسح"، بدل ما تفضل معلقة لحد ما React يشغّل
  // الـ cleanup.
  const stopScanning = useCallback(async () => {
    setIsScanning(false);
    await stopAndRestoreCurrentSound(); // guarantees ducking recovers even if Stop is pressed mid-alert
    try {
      const stillRunning = await Location.hasStartedLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => false);
      if (stillRunning) {
        await Location.stopLocationUpdatesAsync(RADAR_LOCATION_TASK);
      }
    } catch (err) {
      console.warn('[Radar] failed to stop background tracking:', err);
    }
  }, []);

  return {
    location,
    nearbyPois,
    foregroundPermissionGranted,
    backgroundPermissionGranted,
    isScanning,
    startScanning,
    stopScanning,
    refreshPois,
    isIdle,
    speedKmh,
  };
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
