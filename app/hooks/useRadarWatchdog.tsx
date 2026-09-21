import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { InteractionManager } from 'react-native';
import { subscribeObdSpeed } from '../services/obdSpeedStore';
import { boundingBoxFilter, getStaticPois, haversineMeters, loadUserPois, type RadarPoi } from '../services/radarService';
import {
  invalidatePoiCache,
  isRadarIdle,
  LOCATION_DISTANCE_INTERVAL_M,
  LOCATION_TIME_INTERVAL_MS,
  RADAR_LOCATION_TASK,
  SCANNING_STORAGE_KEY,
  SMART_ALERTS_STORAGE_KEY,
  stopAndRestoreCurrentSound,
  stopRadarBackgroundTracking,
  subscribeToRadarLocation,
  updateIdleTracking,
} from '../tasks/radarLocationTask';
import { markRadarScanIntent } from '../tasks/radarTaskConstants';

export {
  LOCATION_TIME_INTERVAL_MS,
  RADAR_LOCATION_TASK,
  SPEED_NOISE_GATE_KMH,
  stopAndRestoreCurrentSound,
  stopRadarBackgroundTracking
} from '../tasks/radarLocationTask';

const NEARBY_RADIUS_KM = 5;
const POI_FETCH_RADIUS_KM = 10;
const PREFETCH_TRIGGER_KM = POI_FETCH_RADIUS_KM * 0.7;



interface RadarContextValue {
  location: Location.LocationObject | null;
  nearbyPois: RadarPoi[];
  foregroundPermissionGranted: boolean;
  isScanning: boolean;
  startScanning: () => void;
  stopScanning: () => void;
  smartAlertsEnabled: boolean;
  setSmartAlertsEnabled: (val: boolean) => void;
  refreshPois: () => Promise<void>;
  isIdle: boolean;
  speedKmh: number;
}

const RadarContext = createContext<RadarContextValue | null>(null);

export const useRadar = (): RadarContextValue => {
  const ctx = useContext(RadarContext);
  if (!ctx) throw new Error('useRadar must be used within a RadarProvider');
  return ctx;
};

function useRadarEngine() {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [nearbyPois, setNearbyPois] = useState<RadarPoi[]>([]);
  const [foregroundPermissionGranted, setForegroundPermissionGranted] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  const allPoisRef = useRef<RadarPoi[]>([]);
  const lastLocationRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const lastFetchCenterRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const [isIdle, setIsIdle] = useState(false);
  const isIdleRef = useRef(false);
  const [speedKmh, setSpeedKmh] = useState(0);

  const refreshPois = useCallback(async (center?: { latitude: number; longitude: number }) => {
    invalidatePoiCache();
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
    const handle = InteractionManager.runAfterInteractions(() => {
      (async () => {

        await refreshPois();
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
          // Best-effort
        }
      })();
    });

    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [refreshPois]);

  useEffect(() => {
    const unsubscribe = subscribeObdSpeed((kmh) => {
      setSpeedKmh(kmh);
      const idleNow = updateIdleTracking(kmh);
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
      if (isRadarIdle()) return;

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
    if (!isScanning) return;

    let cancelled = false;

    (async () => {
      let fgStatus = (await Location.getForegroundPermissionsAsync()).status;
      if (fgStatus !== 'granted') {
        fgStatus = (await Location.requestForegroundPermissionsAsync()).status;
      }
      if (cancelled) return;
      setForegroundPermissionGranted(fgStatus === 'granted');
      if (fgStatus !== 'granted') return;

      const { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
      if (bgStatus !== 'granted') {
        await Location.requestBackgroundPermissionsAsync();
      }
      if (cancelled) return;

      const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => false);
      if (alreadyRunning || cancelled) return;

      await Location.startLocationUpdatesAsync(RADAR_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: LOCATION_TIME_INTERVAL_MS,
        distanceInterval: LOCATION_DISTANCE_INTERVAL_M,
        activityType: Location.ActivityType.AutomotiveNavigation,
        showsBackgroundLocationIndicator: true,
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: 'Radar alerts / تنبيهات الرادار',
          notificationBody: 'Tracking your location for speed camera alerts.',
        },
      });
    })();

    return () => {
      cancelled = true;
      stopRadarBackgroundTracking().catch(() => {});
      stopAndRestoreCurrentSound().catch(() => {});
    };
  }, [isScanning]);

  const startScanning = useCallback(() => {
    markRadarScanIntent();
    setIsScanning(true);
    AsyncStorage.setItem(SCANNING_STORAGE_KEY, 'true').catch(() => {});
  }, []);

  const stopScanning = useCallback(async () => {
    setIsScanning(false);
    await AsyncStorage.setItem(SCANNING_STORAGE_KEY, 'false').catch(() => {});
    await stopAndRestoreCurrentSound();
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
