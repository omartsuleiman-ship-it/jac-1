// مصدر سرعة واحد يغذي كل من الـ UI (radar.tsx) والـ background task
// (useRadarWatchdog.tsx). أي كود يقرأ من الـ OBD2 (PID 01 0D) ينادي
// setObdSpeedKmh() كل ما توصله قراءة جديدة — من غير أي حاجة تستنى
// (non-blocking تمامًا، مجرد تحديث متغيّر + نداء المستمعين).
type ObdSpeedListener = (kmh: number) => void;

let currentSpeedKmh = 0;
const listeners = new Set<ObdSpeedListener>();

// Dashboard calibration offset: OBD speed is true ground speed; the
// physical dashboard intentionally reads ~5% higher per safety regulations.
// Applying the same offset here makes every display in the app (speedometer,
// radar alert threshold, DTE) consistent with what the driver sees on the
// dashboard instrument cluster.
const DASHBOARD_OFFSET_FACTOR = 1.05;

export const setObdSpeedKmh = (kmh: number) => {
  currentSpeedKmh = kmh * DASHBOARD_OFFSET_FACTOR;
  listeners.forEach((cb) => cb(currentSpeedKmh));
};

export const getObdSpeedKmh = (): number => currentSpeedKmh;

export const subscribeObdSpeed = (cb: ObdSpeedListener) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};