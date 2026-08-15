import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  Alert,
  ImageBackground,
  Linking,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { STORAGE_KEY_LAST_PARKED } from '../services/bleService';
import { useLang } from './_layout';

const COLORS = {
  accent: '#00D9C6',
  textPrimary: '#FFFFFF',
  textSecondary: '#E0E0E0',
  glassBg: 'rgba(15, 18, 23, 0.5)', 
  glassBorder: 'rgba(255, 255, 255, 0.12)', 
  success: '#00E676',
  warning: '#F2C94C',
  danger: '#FF6B5E',
};

export default function HomeScreen() {
  const { isAr, toggleLanguage } = useLang();
  const [greeting, setGreeting] = useState('');
  
  // ── Live Trip State ──
  const [isTripActive, setIsTripActive] = useState(false);
  const [liveTripCost, setLiveTripCost] = useState('0.00');

  useEffect(() => {
    const currentHour = new Date().getHours();
    if (isAr) {
      if (currentHour < 12) setGreeting('صباح الفخامة يا عمر ✨');
      else if (currentHour < 18) setGreeting('مساء السعادة يا عمر ✨');
      else setGreeting('مساء الخير يا عمر ✨');
    } else {
      if (currentHour < 12) setGreeting('GOOD MORNING, OMAR ✨');
      else if (currentHour < 18) setGreeting('GOOD AFTERNOON, OMAR ✨');
      else setGreeting('GOOD EVENING, OMAR ✨');
    }
  }, [isAr]);

  // ── Polling for Live Trip Cost ──
  useEffect(() => {
    const pollTripData = async () => {
      try {
        const active = await AsyncStorage.getItem('@trip_active');
        if (active === 'true') {
          setIsTripActive(true);
          const cost = await AsyncStorage.getItem('@live_trip_cost');
          setLiveTripCost(cost || '0.00');
        } else {
          setIsTripActive(false);
        }
      } catch (e) {}
    };
    pollTripData();
    const interval = setInterval(pollTripData, 2000);
    return () => clearInterval(interval);
  }, []);

  // ── Single Tap Vault Handler ──
  const handleUnlockTrips = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      
      if (hasHardware && isEnrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: isAr ? 'افتح قفل لوحة الرحلات والتكلفة' : 'Unlock Trip & Cost Panel',
          fallbackLabel: isAr ? 'استخدام الرمز السري' : 'Use Passcode',
          cancelLabel: isAr ? 'إلغاء' : 'Cancel',
        });
        
        if (result.success) {
          router.push('/(tabs)/trip');
        }
      } else {
        router.push('/(tabs)/trip');
      }
    } catch (error) {
      console.warn('Authentication error:', error);
    }
  };

  // ── Last Parked -> Google Maps Handler ──
  const handleLastParkedPress = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      
      if (hasHardware && isEnrolled) {
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: isAr ? 'افتح قفل الموقع للتوجه للسيارة' : 'Unlock to view parked location',
          fallbackLabel: isAr ? 'استخدام الرمز السري' : 'Use Passcode',
          cancelLabel: isAr ? 'إلغاء' : 'Cancel',
        });
        if (!result.success) return; // المستخدم ألغى البصمة
      }

      const stored = await AsyncStorage.getItem(STORAGE_KEY_LAST_PARKED);
      if (!stored) {
        Alert.alert(
          isAr ? 'مفيش موقع محفوظ' : 'No Location Saved',
          isAr
            ? 'لسه ما تسجلش موقع ركنة. هيتسجل تلقائياً أول ما جهاز الـ OBD يفصل من العربية.'
            : 'No parked location has been recorded yet. It will be saved automatically the next time the OBD dongle disconnects.'
        );
        return;
      }

      const parked = JSON.parse(stored) as { latitude: number; longitude: number; timestamp: number };

      // توجيه مباشر لجوجل مابس (بيفتح التطبيق لو متسطب أو المتصفح لو لأ)
      const url = `https://www.google.com/maps/dir/?api=1&destination=${parked.latitude},${parked.longitude}&travelmode=walking`;
      Linking.openURL(url).catch(() => {});
    } catch (e) {
      console.warn(e);
    }
  };

  return (
    <View style={styles.container}>
      <ImageBackground
        source={require('../../assets/images/jac.jpg')} 
        style={styles.background}
        resizeMode="cover"
      >
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        
        <View style={styles.overlay}>
          <SafeAreaView style={styles.safeArea}>
            
            <View style={[styles.topBar, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <View style={[styles.btPill, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                <View style={styles.btDot} />
                <Text style={styles.btText}>ARC 103</Text>
              </View>
              
              {/* زرار تغيير اللغة */}
              <TouchableOpacity 
                style={[styles.langButton, { flexDirection: isAr ? 'row-reverse' : 'row' }]} 
                onPress={toggleLanguage}
                activeOpacity={0.7}
              >
                <Ionicons name="language-outline" size={16} color={COLORS.textPrimary} />
                <Text style={styles.langText}>{isAr ? 'EN' : 'عربي'}</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.mainContent, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
              <Text style={[isAr ? styles.greetingTextAr : styles.greetingTextEn, { textAlign: isAr ? 'right' : 'left' }]}>
                {greeting}
              </Text>
              
              <Text style={[isAr ? styles.subtitleTextAr : styles.subtitleTextEn, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? 'عربيتك جاك في انتظار أوامرك..' : 'YOUR JAC IS AWAITING COMMANDS..'}
              </Text>

              {/* Weather Widget */}
              <View style={[styles.weatherCard, { flexDirection: isAr ? 'row-reverse' : 'row', marginTop: 16 }]}>
                <View style={[styles.weatherRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  <Ionicons name="location" size={16} color={COLORS.accent} />
                  <Text style={isAr ? styles.weatherTextAr : styles.weatherTextEn}>
                    {isAr ? 'العاشر من رمضان' : '10th of Ramadan'}
                  </Text>
                </View>
                <View style={styles.weatherDivider} />
                <View style={[styles.weatherRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  <Ionicons name="partly-sunny" size={16} color={COLORS.warning} />
                  <Text style={isAr ? styles.weatherTextAr : styles.weatherTextEn}>
                    {isAr ? '٢٩° - صافي' : '29°C - Clear'}
                  </Text>
                </View>
              </View>

              {/* ── COCKPIT WIDGETS ── */}
              <View style={styles.widgetsGrid}>
                
                {/* Health Pill */}
                <View style={[styles.widgetFull, styles.healthWidget, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  <View style={[styles.healthIconWrap, { backgroundColor: 'rgba(0, 230, 118, 0.15)' }]}>
                    <Ionicons name="shield-checkmark" size={20} color={COLORS.success} />
                  </View>
                  <View style={{ flex: 1, alignItems: isAr ? 'flex-end' : 'flex-start' }}>
                    <Text style={styles.widgetTitle}>{isAr ? 'حالة السيارة' : 'Vehicle Health'}</Text>
                    <Text style={[styles.widgetValue, { color: COLORS.success }]}>{isAr ? 'جميع الأنظمة سليمة' : 'All Systems Go'}</Text>
                  </View>
                </View>

                {/* Live Trip Cost (Appears ONLY when trip is running) */}
                {isTripActive && (
                  <View style={[styles.widgetFull, { flexDirection: isAr ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'flex-start', borderColor: COLORS.accent, backgroundColor: 'rgba(0, 217, 198, 0.05)', gap: 12 }]}>
                    <View style={[styles.healthIconWrap, { backgroundColor: 'rgba(0, 217, 198, 0.15)' }]}>
                      <Ionicons name="cash-outline" size={20} color={COLORS.accent} />
                    </View>
                    <View style={{ flex: 1, alignItems: isAr ? 'flex-end' : 'flex-start' }}>
                      <Text style={styles.widgetTitle}>{isAr ? 'تكلفة الرحلة الحالية' : 'Live Trip Cost'}</Text>
                      <Text style={[styles.widgetValue, { color: COLORS.accent }]}>{liveTripCost} <Text style={styles.widgetUnit}>{isAr ? 'جنيه' : 'EGP'}</Text></Text>
                    </View>
                  </View>
                )}

                <View style={[styles.rowWidgets, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  {/* Eco Score */}
                  <View style={[styles.widgetHalf, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
                    <Ionicons name="leaf-outline" size={22} color={COLORS.success} style={{ marginBottom: 6 }} />
                    <Text style={styles.widgetTitle}>{isAr ? 'قيادة موفرة' : 'Eco Score'}</Text>
                    <Text style={styles.widgetValue}>96<Text style={styles.widgetUnit}>/100</Text></Text>
                  </View>

                  {/* Last Parked (Now a Button with Face ID) */}
                  <TouchableOpacity 
                    style={[styles.widgetHalf, { alignItems: isAr ? 'flex-end' : 'flex-start', borderColor: 'rgba(255, 107, 94, 0.3)' }]} 
                    activeOpacity={0.7} 
                    onPress={handleLastParkedPress}
                  >
                    <Ionicons name="pin-outline" size={22} color={COLORS.danger} style={{ marginBottom: 6 }} />
                    <Text style={styles.widgetTitle}>{isAr ? 'آخر ركنة' : 'Last Parked'}</Text>
                    <Text style={[styles.widgetValue, { fontSize: 13, marginTop: 4 }]} numberOfLines={1}>
                      {isAr ? 'مجاورة 46' : 'Mogawra 46'}
                    </Text>
                  </TouchableOpacity>
                </View>

                {/* Maintenance Progress */}
                <View style={[styles.widgetFull, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
                  <View style={[styles.maintenanceHeader, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                    <Ionicons name="build-outline" size={16} color={COLORS.warning} />
                    <Text style={styles.widgetTitle}>{isAr ? 'الصيانة القادمة (150 ألف)' : 'Next Service (150k)'}</Text>
                  </View>
                  <Text style={[styles.widgetValue, { fontSize: 15, marginBottom: 8 }]}>
                    {isAr ? 'باقي ٤,٥٠٠ كم' : '4,500 km remaining'}
                  </Text>
                  <View style={styles.progressBarTrack}>
                    <View style={[styles.progressBarFill, { width: '85%' }]} />
                  </View>
                </View>

              </View>

              {/* ── Single Tap Vault Button ── */}
              <View style={{ flex: 1, justifyContent: 'flex-end', width: '100%', paddingBottom: 20 }}>
                <TouchableOpacity 
                  activeOpacity={0.8} 
                  onPress={handleUnlockTrips}
                  style={styles.vaultButton}
                >
                  <Ionicons name="lock-closed-outline" size={20} color={COLORS.accent} />
                  <Text style={styles.vaultText}>
                    {isAr ? 'اضغط لفتح سجل الرحلات' : 'Tap to unlock Trips'}
                  </Text>
                </TouchableOpacity>
              </View>

            </View>
          </SafeAreaView>
        </View>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  background: { flex: 1, width: '100%', height: '100%' },
  overlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.45)', justifyContent: 'flex-start' },
  safeArea: { flex: 1 },
  
  topBar: { paddingHorizontal: 24, paddingTop: Platform.OS === 'ios' ? 10 : 40, justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  btPill: { backgroundColor: 'rgba(0, 217, 198, 0.15)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: 'rgba(0, 217, 198, 0.3)' },
 btDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.accent },
  btText: { color: COLORS.accent, fontSize: 12, fontWeight: 'bold' },
  
  langButton: { backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  langText: { color: COLORS.textPrimary, fontSize: 12, fontWeight: 'bold' },

  mainContent: { paddingHorizontal: 24, flex: 1, justifyContent: 'flex-start' },
  
  greetingTextAr: { color: COLORS.textPrimary, fontSize: 32, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
  subtitleTextAr: { color: COLORS.accent, fontSize: 16, fontWeight: '800', marginTop: 8, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  
  greetingTextEn: { color: COLORS.textPrimary, fontSize: 34, fontWeight: '900', fontStyle: 'italic', textTransform: 'uppercase', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 4, letterSpacing: 1 },
  subtitleTextEn: { color: COLORS.accent, fontSize: 14, fontWeight: '800', fontStyle: 'italic', marginTop: 8, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3, letterSpacing: 2 },
  
  weatherCard: { backgroundColor: COLORS.glassBg, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, borderWidth: 1, borderColor: COLORS.glassBorder, alignItems: 'center', gap: 12 },
  weatherRow: { alignItems: 'center', gap: 6 },
  weatherDivider: { width: 1, height: 20, backgroundColor: COLORS.glassBorder, marginHorizontal: 4 },
  weatherTextAr: { color: COLORS.textPrimary, fontSize: 13, fontWeight: '700' },
  weatherTextEn: { color: COLORS.textPrimary, fontSize: 13, fontWeight: '700', fontStyle: 'italic' },

  widgetsGrid: { width: '100%', marginTop: 24, gap: 12 },
  widgetFull: { width: '100%', backgroundColor: COLORS.glassBg, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: COLORS.glassBorder },
  rowWidgets: { width: '100%', justifyContent: 'space-between', gap: 12 },
  widgetHalf: { flex: 1, backgroundColor: COLORS.glassBg, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: COLORS.glassBorder },
  
  healthWidget: { alignItems: 'center', gap: 16 },
  healthIconWrap: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  
  widgetTitle: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  widgetValue: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '800' },
  widgetUnit: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },

  maintenanceHeader: { alignItems: 'center', gap: 6, marginBottom: 8 },
  progressBarTrack: { width: '100%', height: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: COLORS.warning, borderRadius: 3 },

  vaultButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(0, 217, 198, 0.3)' },
  vaultText: { color: COLORS.accent, fontSize: 13, fontWeight: 'bold' },
});