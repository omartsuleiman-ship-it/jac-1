import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router'; // 👈 ضفنا الـ useRouter هنا
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { InteractionManager } from 'react-native';
import 'react-native-reanimated';

// 👇 ضفنا مكتبة سينتري هنا
import * as Sentry from '@sentry/react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { RADAR_LOCATION_TASK, SCANNING_STORAGE_KEY, shouldSkipBootScanReset } from './tasks/radarTaskConstants';

// 👇 ضفنا كود تهيئة سينتري هنا قبل أي شغل تاني في التطبيق
Sentry.init({
  dsn: 'https://ed09c627d733300e5c3664b3b5a3631d@o4512085217968128.ingest.us.sentry.io/4512085378596864', // ⚠️ لازم تحط اللينك بتاع مشروعك من Sentry هنا
  debug: true,
  enableNative: false, // ضفنا دي عشان لو Sideloadly بيعلق مع الجزء الـ Native بتاع Sentry
});

// 🔔 Global Notification Handler - MUST be top-level for cold launch reliability
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // We check category or sound name to identify radar alerts
    // Radar alerts should NOT show a banner (sound only), others should.
    const content = notification.request.content;
    const isRadar = content.categoryIdentifier === 'RADAR_ALERT' || 
                   (typeof content.sound === 'string' && content.sound.startsWith('radar_'));
    
    return {
      shouldShowAlert: !isRadar,
      shouldShowBanner: !isRadar,
      shouldShowList: !isRadar,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

export const unstable_settings = {
  anchor: '(tabs)',
};
export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter(); // 👈 تفعيل الراوتر

  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => {
      void (async () => {
        if (shouldSkipBootScanReset()) return;
        await AsyncStorage.setItem(SCANNING_STORAGE_KEY, 'false').catch(() => {});
        try {
          const Location = await import('expo-location');
          const running = await Location.hasStartedLocationUpdatesAsync(RADAR_LOCATION_TASK).catch(() => false);
          if (running && !shouldSkipBootScanReset()) {
            await Location.stopLocationUpdatesAsync(RADAR_LOCATION_TASK);
          }
        } catch {
          // Ghost task already gone.
        }
      })();
    });
    return () => handle.cancel();
  }, []);

  // Unified effect for permissions and notification listeners
  useEffect(() => {
    // Request permissions with sound (required for iOS)
    const requestPermissions = async () => {
      // 1. Check current foreground permissions
      const settings = await Notifications.getPermissionsAsync();
      let status = settings.status;

      // 2. If not granted, request them
      if (status !== 'granted') {
        const result = await Notifications.requestPermissionsAsync({
          ios: {
            allowSound: true,
            allowAlert: true,
            allowBadge: true,
            allowCriticalAlerts: true,
          },
        });
        status = result.status;
      }

      if (status !== 'granted') {
        console.warn('Notification permissions not granted');
        return;
      }

      // 3. For background alerts (Radar) on iOS, we ideally need Location 'Always'
      // which is handled by expo-location elsewhere, but for notifications specifically
      // we've now ensured Alerts and Sounds are enabled.
    };
    requestPermissions();

    // 🚀 NEW: نظام الاستماع الذكي لإشعارات العداد وتوجيهها
    const responseSub = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      if (data?.action === 'update_odometer') {
        // بنعمل تأخير بسيط (نص ثانية) عشان نتأكد إن شجرة التطبيق حملت قبل ما نفتح الشاشة
        setTimeout(() => {
          router.push({ pathname: '/(tabs)/maintenance', params: { action: 'update_odometer' } });
        }, 500);
      }
    });

    return () => {
      responseSub.remove();
    };
  }, [router]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}