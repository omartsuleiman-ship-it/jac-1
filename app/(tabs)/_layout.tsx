import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import React, { createContext, useContext, useState, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── 1. Global Language Context ──
type LangContextType = { lang: 'en' | 'ar'; toggleLang: () => void; isAr: boolean };
const LangContext = createContext<LangContextType>({ lang: 'ar', toggleLang: () => {}, isAr: true });
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

  const toggleLang = async () => {
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
    <LangContext.Provider value={{ lang, toggleLang, isAr }}>
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

const styles = StyleSheet.create({
  iconWrapper: { alignItems: 'center', justifyContent: 'center' },
  iconWrapperActive: { transform: [{ scale: 1.05 }] },
});