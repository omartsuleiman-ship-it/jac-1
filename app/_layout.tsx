import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  // Set notification handler with sound enabled
  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
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

    // 🔔 IMPORTANT: When scheduling notifications, you MUST add `sound: true`
    // to the `content` object of each `Notifications.scheduleNotificationAsync` call.
    // Example:
    // await Notifications.scheduleNotificationAsync({
    //   content: {
    //     title: "Hello",
    //     body: "World",
    //     sound: true,   // <-- required for iOS sound
    //   },
    //   trigger: null,
    // });
  }, []);

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