import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Tabs } from 'expo-router';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { getExtraSafetyData, getLiveData, isConnected, LiveDataKey, SafetyDataKey } from '../services/bleService';

// The watchdog always monitors this fixed critical set, independent of
// whatever the user has chosen to display on the diagnostics dashboard —
// background danger alerting and the customizable live-data view are
// separate concerns.
// ABS and TPMS were dropped from the watchdog: raw terminal testing showed
// this ELM327 can only reach the Engine (7E0) and Transmission (7E1) ECUs —
// polling 7B0 (ABS) / 7A0 (TPMS) only produced NO DATA / timeouts.
const WATCHDOG_LIVE_KEYS: LiveDataKey[] = ['coolant', 'voltage'];
const WATCHDOG_SAFETY_KEYS: SafetyDataKey[] = ['atfTemp'];

// ضبط إعدادات الإشعارات للتوافق مع الإصدارات الحديثة
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
// ── 1. Global Language Context ──
type LangContextType = { lang: 'en' | 'ar'; toggleLanguage: () => void; isAr: boolean };
const LangContext = createContext<LangContextType>({ lang: 'ar', toggleLanguage: () => {}, isAr: true });
export const useLang = () => useContext(LangContext);

const COLORS = {
  background: '#0B0D10',
  tabBarBg: '#111417',
  tabBarBorder: '#1F2428',
  active: '#00D9C6',
  inactive: '#5A6169',
};

const STORAGE_KEY = 'app_language';

export default function TabLayout() {
  const [lang, setLang] = useState<'en' | 'ar'>('ar');

  // Load saved language on mount
  useEffect(() => {
    const loadLanguage = async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === 'en' || saved === 'ar') {
          setLang(saved);
        }
      } catch (error) {
        console.warn('Failed to load language:', error);
      }
    };
    loadLanguage();
  }, []);

  const toggleLanguage = async () => {
    const newLang = lang === 'en' ? 'ar' : 'en';
    setLang(newLang);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, newLang);
    } catch (error) {
      console.warn('Failed to save language:', error);
    }
  };

  const isAr = lang === 'ar';

 return (
    <LangContext.Provider value={{ lang, toggleLanguage, isAr }}>
      <GlobalSafetyWatchdog />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.tabBarBg },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          headerShown: false,
          tabBarActiveTintColor: COLORS.active,
          tabBarInactiveTintColor: COLORS.inactive,
          tabBarStyle: {
            backgroundColor: COLORS.tabBarBg,
            borderTopColor: COLORS.tabBarBorder,
            borderTopWidth: 1,
            height: 88,
            paddingTop: 8,
            paddingBottom: 28,
            flexDirection: isAr ? 'row-reverse' : 'row',
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: isAr ? 'الرئيسية' : 'Home',
            tabBarStyle: { display: 'none' },
            tabBarIcon: ({ color, size, focused }) => (
              <IconWrapper focused={focused}>
                <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color} />
              </IconWrapper>
            ),
          }}
        />

        <Tabs.Screen
          name="trip"
          options={{
            title: isAr ? 'الرحلات' : 'Trip & Cost',
            tabBarIcon: ({ color, size, focused }) => (
              <IconWrapper focused={focused}>
                <Ionicons name={focused ? 'calculator' : 'calculator-outline'} size={size} color={color} />
              </IconWrapper>
            ),
          }}
        />

        <Tabs.Screen
          name="maintenance"
          options={{
            title: isAr ? 'الصيانة' : 'Maintenance',
            tabBarIcon: ({ color, size, focused }) => (
              <IconWrapper focused={focused}>
                <Ionicons name={focused ? 'construct' : 'construct-outline'} size={size} color={color} />
              </IconWrapper>
            ),
          }}
        />

        <Tabs.Screen
          name="diagnostics"
          options={{
            title: isAr ? 'الأعطال' : 'Diagnostics',
            tabBarIcon: ({ color, size, focused }) => (
              <IconWrapper focused={focused}>
                <Ionicons name={focused ? 'warning' : 'warning-outline'} size={size} color={color} />
              </IconWrapper>
            ),
          }}
        />

        <Tabs.Screen
          name="connection"
          options={{
            title: isAr ? 'البلوتوث' : 'Bluetooth',
            tabBarIcon: ({ color, size, focused }) => (
              <IconWrapper focused={focused}>
                <Ionicons name={focused ? 'bluetooth' : 'bluetooth-outline'} size={size} color={color} />
              </IconWrapper>
            ),
          }}
        />
      </Tabs>
    </LangContext.Provider>
  );
}

function IconWrapper({ children, focused }: { children: React.ReactNode; focused: boolean }) {
  return <View style={[styles.iconWrapper, focused && styles.iconWrapperActive]}>{children}</View>;
}

// ── Global Safety Watchdog (Smart Background Notifications) ──
function GlobalSafetyWatchdog() {
  const { isAr } = useLang();
  const previousStates = useRef<Record<string, string>>({});

  const sendAlert = async (title: string, body: string, tone: 'warning' | 'danger') => {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: tone === 'danger' ? 'default' : 'default',
      },
      trigger: null,
    });
  };

  useEffect(() => {
    // Foreground/background is tracked explicitly rather than pretending the
    // interval below keeps a fixed cadence everywhere — iOS throttles JS
    // timers once backgrounded regardless of the bluetooth-central
    // entitlement, so ticks may slow or stop while locked. What
    // bluetooth-central + BLE state restoration (bleService.ts) actually
    // guarantees is that the CONNECTION survives and this loop picks back up
    // immediately on foreground — not that it runs at 10s cadence with the
    // screen off.
    const appStateRef = { current: AppState.currentState };
    const appStateSub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
    });

    const checkMetric = (
      key: string,
      val: number | null,
      statusFn: any,
      nameAr: string,
      nameEn: string,
      valStr: string
    ) => {
      if (val === null) return;
      const currentTone = statusFn(val).tone;
      const oldTone = previousStates.current[key] || 'success';

      if (currentTone !== oldTone) {
        if (currentTone === 'warning' && oldTone === 'success') {
          sendAlert(
            isAr ? `🟡 تنبيه فحص: ${nameAr}` : `🟡 Check Warning: ${nameEn}`,
            isAr ? `القراءة تتطلب الانتباه: ${valStr}` : `Reading needs attention: ${valStr}`,
            'warning'
          );
        } else if (currentTone === 'danger' && oldTone !== 'danger') {
          sendAlert(
            isAr ? `🔴 خطر توقف فوراً: ${nameAr}` : `🔴 DANGER STOP: ${nameEn}`,
            isAr ? `القراءة وصلت لمستوى خطير: ${valStr}` : `Critical level reached: ${valStr}`,
            'danger'
          );
        }
        previousStates.current[key] = currentTone;
      }
    };

    const runCheck = async () => {
      if (!isConnected()) return;
      try {
        const live = await getLiveData(WATCHDOG_LIVE_KEYS);
        const extra = await getExtraSafetyData(WATCHDOG_SAFETY_KEYS);

        checkMetric('coolant', live.coolant, (v: number) => (v > 115 ? { tone: 'danger' } : v >= 106 ? { tone: 'warning' } : { tone: 'success' }), 'حرارة المحرك', 'Engine Temp', `${live.coolant}°C`);
        checkMetric('atf', extra.atfTemp, (v: number) => (v > 110 ? { tone: 'danger' } : v > 90 ? { tone: 'warning' } : { tone: 'success' }), 'حرارة الفتيس', 'Trans Temp', `${extra.atfTemp}°C`);
        checkMetric('volt', live.voltage, (v: number) => (v < 11.5 || v > 15.0 ? { tone: 'danger' } : v < 13.3 ? { tone: 'warning' } : { tone: 'success' }), 'جهد البطارية', 'Battery Voltage', `${live.voltage}V`);
      } catch (e) {}
    };

    const interval = setInterval(runCheck, 10000);
    // Re-check immediately whenever the app returns to foreground, since the
    // interval may have missed ticks (or all of them) while backgrounded
    const foregroundSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') runCheck();
    });

    return () => {
      clearInterval(interval);
      appStateSub.remove();
      foregroundSub.remove();
    };
  }, [isAr]);

  return null;
}

const styles = StyleSheet.create({
  iconWrapper: { alignItems: 'center', justifyContent: 'center' },
  iconWrapperActive: { transform: [{ scale: 1.05 }] },
});