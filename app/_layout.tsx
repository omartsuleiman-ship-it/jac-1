import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter } from 'expo-router'; // 👈 ضفنا الـ useRouter هنا
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter(); // 👈 تفعيل الراوتر

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