import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const REFRESH_REMINDER_ID = 'sideload-refresh-reminder';
const REFRESH_REMINDER_DUE_KEY = '@jac/refresh_reminder_due_v1';
const REFRESH_REMINDER_DAYS = 6;

/**
 * Schedules ONE local notification 6 days after the first open following the previous reminder.
 * Safe to call on every launch: it won't push a pending reminder back.
 */
export const ensureRefreshReminder = async (): Promise<void> => {
  try {
    // Permission (the radar alerts already need it, but don't assume)
    const perm = await Notifications.getPermissionsAsync();
    let granted = perm.granted;
    if (!granted && perm.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return; // try again on the next launch

    const now = Date.now();
    const dueRaw = await AsyncStorage.getItem(REFRESH_REMINDER_DUE_KEY);
    const storedDue = dueRaw ? Number(dueRaw) : 0;
    const stillPending = storedDue > now;

    if (stillPending) {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      if (scheduled.some((n) => n.identifier === REFRESH_REMINDER_ID)) return; // already armed
    }

    const fireAt = stillPending ? storedDue : now + REFRESH_REMINDER_DAYS * 24 * 60 * 60 * 1000;

    await Notifications.scheduleNotificationAsync({
      identifier: REFRESH_REMINDER_ID,
      content: {
        title: 'Refresh the app / جدّد التطبيق',
        body: 'Your sideloaded build expires tomorrow. Re-sign it now so radar alerts keep working.',
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(fireAt),
      },
    });
    await AsyncStorage.setItem(REFRESH_REMINDER_DUE_KEY, String(fireAt));
  } catch (err) {
    console.warn('[RefreshReminder] failed to schedule:', err);
  }
};