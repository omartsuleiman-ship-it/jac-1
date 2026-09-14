export const RADAR_LOCATION_TASK = 'radar-background-location-task';
export const SCANNING_STORAGE_KEY = '@radar_map/is_scanning_v1';
export const LANGUAGE_STORAGE_KEY = 'app_language';
export const SMART_ALERTS_STORAGE_KEY = '@radar_map/smart_alerts_v1';
export const ALERT_MEMORY_STORAGE_KEY = '@radar_map/last_alert_memory_v1';
export const LOCATION_TIME_INTERVAL_MS = 1000;
export const LOCATION_DISTANCE_INTERVAL_M = 1;
export const SPEED_NOISE_GATE_KMH = 5;

let skipBootScanReset = false;

export const markRadarScanIntent = () => {
  skipBootScanReset = true;
};

export const shouldSkipBootScanReset = () => skipBootScanReset;
