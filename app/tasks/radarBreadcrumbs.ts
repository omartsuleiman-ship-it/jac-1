import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@radar_map/breadcrumbs_v1';
const lastAt: Record<string, number> = {};
let chain: Promise<void> = Promise.resolve();

// Fire-and-forget. Same reason is stored at most once per 15 s. Never throws.
export const logBreadcrumb = (reason: string, detail = ''): void => {
  const now = Date.now();
  if (now - (lastAt[reason] ?? 0) < 15000) return;
  lastAt[reason] = now;
  const d = new Date(now);
  const t = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  const line = `${t} ${reason} ${detail}`.trim();
  chain = chain.then(async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const arr: string[] = raw ? JSON.parse(raw) : [];
      arr.push(line);
      await AsyncStorage.setItem(KEY, JSON.stringify(arr.slice(-40)));
    } catch {
      // best-effort
    }
  });
};

export const readBreadcrumbs = async (): Promise<string[]> => {
  try {
    await chain;
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

export const clearBreadcrumbs = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // best-effort
  }
};