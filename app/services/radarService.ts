import AsyncStorage from '@react-native-async-storage/async-storage';
// Adjust this path to wherever your OSM export actually lives in the project
// (e.g. assets/data/RadarDB.json). It's the GeoJSON FeatureCollection you
// pulled from Overpass — see the export.geojson sample you shared.
import RadarGeoJSON from '../assets/data/RadarDB.json';

export type RadarPoiType = 'radar' | 'bump' | 'comment';
export type RadarPoiSource = 'osm' | 'user';

export interface RadarPoi {
  id: string;
  type: RadarPoiType;
  latitude: number;
  longitude: number;
  maxspeed: number | null;
  note?: string;
  source: RadarPoiSource;
}

const USER_POI_STORAGE_KEY = '@radar_map/user_pois_v1';

// ── Static OSM DB: parsed ONCE at module load (not on every location tick).
// This is the whole reason the watchdog can afford to re-run its filters on
// every GPS fix without touching disk or re-walking raw GeoJSON each time. ──
let staticPoisCache: RadarPoi[] | null = null;

export const getStaticPois = (): RadarPoi[] => {
  if (staticPoisCache) return staticPoisCache;

  const features = (RadarGeoJSON as any)?.features ?? [];
  staticPoisCache = features
    .filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f.geometry?.coordinates))
    .map((f: any): RadarPoi => {
      const [lon, lat] = f.geometry.coordinates;
      const rawSpeed = f.properties?.maxspeed;
      const parsedSpeed = rawSpeed ? parseInt(String(rawSpeed).replace(/\D/g, ''), 10) : NaN;
      return {
        id: f.properties?.['@id'] || f.id || `osm-${lat}-${lon}`,
        type: 'radar',
        latitude: lat,
        longitude: lon,
        maxspeed: Number.isFinite(parsedSpeed) ? parsedSpeed : null,
        source: 'osm',
      };
    });

  return staticPoisCache!;
};

// ── User-added POIs (Radar / Speed Bump / Comment), persisted locally ──
export const loadUserPois = async (): Promise<RadarPoi[]> => {
  try {
    const raw = await AsyncStorage.getItem(USER_POI_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RadarPoi[]) : [];
  } catch {
    return [];
  }
};

export const saveUserPoi = async (poi: RadarPoi): Promise<RadarPoi[]> => {
  const existing = await loadUserPois();
  const updated = [...existing, poi];
  await AsyncStorage.setItem(USER_POI_STORAGE_KEY, JSON.stringify(updated));
  return updated;
};

export const deleteUserPoi = async (id: string): Promise<RadarPoi[]> => {
  const existing = await loadUserPois();
  const updated = existing.filter((p) => p.id !== id);
  await AsyncStorage.setItem(USER_POI_STORAGE_KEY, JSON.stringify(updated));
  return updated;
};

// ── Geo math ──
const EARTH_RADIUS_M = 6371000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
};

export const bearingDegrees = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
};

// Smallest angular difference between two compass bearings (0-180).
// Used to test whether a POI's bearing falls inside the user's forward cone.
export const angularDiff = (a: number, b: number): number => {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
};

// ── Cheap bounding-box pre-filter in plain degrees, done BEFORE any
// Haversine/bearing (trig) call. This is what keeps the per-tick cost low:
// the expensive math only ever runs over whatever's left inside the box,
// never the full country-wide POI list. ──
export const boundingBoxFilter = (
  pois: RadarPoi[],
  centerLat: number,
  centerLon: number,
  radiusKm: number
): RadarPoi[] => {
  const latDelta = radiusKm / 111; // ~111km per degree of latitude, everywhere
  const lonDelta = radiusKm / (111 * Math.cos(toRad(centerLat)) || 1);
  const minLat = centerLat - latDelta;
  const maxLat = centerLat + latDelta;
  const minLon = centerLon - lonDelta;
  const maxLon = centerLon + lonDelta;

  return pois.filter(
    (p) => p.latitude >= minLat && p.latitude <= maxLat && p.longitude >= minLon && p.longitude <= maxLon
  );
};
// ── Viewport clustering for the map screen ──
export interface RadarCluster {
  id: string;
  latitude: number;
  longitude: number;
  count: number;
  poi?: RadarPoi; // موجودة بس لما count === 1
}

export const clusterPois = (
  pois: RadarPoi[],
  region: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number }
): RadarCluster[] => {
  const margin = 0.25;
  const minLat = region.latitude - (region.latitudeDelta / 2) * (1 + margin);
  const maxLat = region.latitude + (region.latitudeDelta / 2) * (1 + margin);
  const minLon = region.longitude - (region.longitudeDelta / 2) * (1 + margin);
  const maxLon = region.longitude + (region.longitudeDelta / 2) * (1 + margin);

  const visible = pois.filter(
    (p) => p.latitude >= minLat && p.latitude <= maxLat && p.longitude >= minLon && p.longitude <= maxLon
  );

  const cellSize = region.latitudeDelta / 20;
  if (!cellSize || cellSize <= 0) {
    return visible.map((p) => ({ id: p.id, latitude: p.latitude, longitude: p.longitude, count: 1, poi: p }));
  }

  const cells = new Map<string, RadarPoi[]>();
  for (const p of visible) {
    const key = `${Math.floor(p.latitude / cellSize)}:${Math.floor(p.longitude / cellSize)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(p);
    else cells.set(key, [p]);
  }

  const clusters: RadarCluster[] = [];
  cells.forEach((bucket, key) => {
    if (bucket.length === 1) {
      const p = bucket[0];
      clusters.push({ id: p.id, latitude: p.latitude, longitude: p.longitude, count: 1, poi: p });
    } else {
      const avgLat = bucket.reduce((sum, p) => sum + p.latitude, 0) / bucket.length;
      const avgLon = bucket.reduce((sum, p) => sum + p.longitude, 0) / bucket.length;
      clusters.push({ id: `cluster-${key}`, latitude: avgLat, longitude: avgLon, count: bucket.length });
    }
  });

  return clusters;
};