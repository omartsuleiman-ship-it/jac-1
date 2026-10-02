export const RADAR_LOCATION_TASK = 'radar-background-location-task';
export const SCANNING_STORAGE_KEY = '@radar_map/is_scanning_v1';
export const LANGUAGE_STORAGE_KEY = 'app_language';
export const SMART_ALERTS_STORAGE_KEY = '@radar_map/smart_alerts_v1';
export const ALERT_MEMORY_STORAGE_KEY = '@radar_map/last_alert_memory_v1';
export const LOCATION_TIME_INTERVAL_MS = 1000;
export const LOCATION_DISTANCE_INTERVAL_M = 1;
export const SPEED_NOISE_GATE_KMH = 5;
export const ANNOUNCED_RADARS_STORAGE_KEY = '@radar_map/announced_radars_v1';
export const CLUSTER_RADIUS_M = 250;          // one warning covers all radars within this radius of the fired one
export const REARM_DISTANCE_M = 1000;         // radar re-arms once you are this far away from it
export const ANNOUNCED_TTL_MS = 600000;       // 10 min fallback re-arm
export const NAG_INTERVAL_MS = 5000;          // overspeed nag spacing (time)
export const NAG_MIN_TRAVEL_M = 150;          // overspeed nag spacing (distance), whichever comes first
export const POST_ALERT_MIN_TRAVEL_M = 150;   // distance-based replacement for the 4s cooldown

let skipBootScanReset = false;

export const markRadarScanIntent = () => {
  skipBootScanReset = true;
};

export const shouldSkipBootScanReset = () => skipBootScanReset;
