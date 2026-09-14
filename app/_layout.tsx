import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router'; // 👈 ضفنا الـ useRouter هنا
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { InteractionManager } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { RADAR_LOCATION_TASK, SCANNING_STORAGE_KEY, shouldSkipBootScanReset } from './tasks/radarTaskConstants';

export const unstable_settings = {
  anchor: '(tabs)',
};

// #region agent log
fetch('http://127.0.0.1:7630/ingest/de13606f-ba56-41c9-af73-87b91ac29696',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ab38e3'},body:JSON.stringify({sessionId:'ab38e3',runId:'boot',hypothesisId:'A',location:'app/_layout.tsx:module',message:'root layout module evaluated',data:{},timestamp:Date.now()})}).catch(()=>{});
// #endregion

export default function RootLayout() {
  // #region agent log
  fetch('http://127.0.0.1:7630/ingest/de13606f-ba56-41c9-af73-87b91ac29696',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ab38e3'},body:JSON.stringify({sessionId:'ab38e3',runId:'boot',hypothesisId:'A',location:'app/_layout.tsx:RootLayout',message:'root layout render',data:{},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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

  // Set notification handler with sound enabled
  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,   // ✅ required for sound to play
        shouldSetBadge: false,
      }),
    });

    // Request permissions with sound (required for iOS)
    const requestPermissions = async () => {
      const { status } = await Notifications.requestPermissionsAsync({
        ios: {
          allowSound: true,
          allowAlert: true,
          allowBadge: true,
        },
      });
      if (status !== 'granted') {
        console.warn('Notification permissions not granted');
      }
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