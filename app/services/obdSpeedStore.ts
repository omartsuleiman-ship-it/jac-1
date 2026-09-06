// مصدر سرعة واحد يغذي كل من الـ UI (radar.tsx) والـ background task
// (useRadarWatchdog.tsx). أي كود يقرأ من الـ OBD2 (PID 01 0D) ينادي
// setObdSpeedKmh() كل ما توصله قراءة جديدة — من غير أي حاجة تستنى
// (non-blocking تمامًا، مجرد تحديث متغيّر + نداء المستمعين).
type ObdSpeedListener = (kmh: number) => void;

let currentSpeedKmh = 0;
const listeners = new Set<ObdSpeedListener>();

export const setObdSpeedKmh = (kmh: number) => {
  currentSpeedKmh = kmh;
  listeners.forEach((cb) => cb(kmh));
};

export const getObdSpeedKmh = (): number => currentSpeedKmh;

export const subscribeObdSpeed = (cb: ObdSpeedListener) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};