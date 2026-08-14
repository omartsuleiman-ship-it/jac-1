import Ionicons from '@expo/vector-icons/Ionicons';
import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ImageBackground,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLang } from './_layout';

const COLORS = {
  accent: '#00D9C6',
  textPrimary: '#FFFFFF',
  textSecondary: '#E0E0E0',
  glassBg: 'rgba(15, 18, 23, 0.5)', 
  glassBorder: 'rgba(255, 255, 255, 0.12)', 
  success: '#00E676',
  warning: '#F2C94C',
};

export default function HomeScreen() {
  const { isAr } = useLang();
  const [greeting, setGreeting] = useState('');
  
  // ── Double Tap Logic ──
  const lastTapRef = useRef<number>(0);

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

  // ── Face ID & Double Tap Handler ──
  const handleDoubleTap = async () => {
    const now = Date.now();
    const DOUBLE_PRESS_DELAY = 400; // 400ms window for double tap
    if (now - lastTapRef.current < DOUBLE_PRESS_DELAY) {
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
          // If simulator or no Face ID setup, bypass gracefully
          router.push('/(tabs)/trip');
        }
      } catch (error) {
        console.warn('Authentication error:', error);
      }
    }
    lastTapRef.current = now;
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
            
            {/* Top Bar: Replaced Menu with Bluetooth Status Pill */}
            <View style={[styles.topBar, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <View style={[styles.btPill, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                <View style={styles.btDot} />
                <Text style={styles.btText}>ARC 103</Text>
              </View>
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

                <View style={[styles.rowWidgets, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  {/* Eco Score */}
                  <View style={[styles.widgetHalf, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
                    <Ionicons name="leaf-outline" size={22} color={COLORS.success} style={{ marginBottom: 6 }} />
                    <Text style={styles.widgetTitle}>{isAr ? 'قيادة موفرة' : 'Eco Score'}</Text>
                    <Text style={styles.widgetValue}>96<Text style={styles.widgetUnit}>/100</Text></Text>
                  </View>

                  {/* Last Parked */}
                  <View style={[styles.widgetHalf, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
                    <Ionicons name="pin-outline" size={22} color={COLORS.accent} style={{ marginBottom: 6 }} />
                    <Text style={styles.widgetTitle}>{isAr ? 'آخر ركنة' : 'Last Parked'}</Text>
                    <Text style={[styles.widgetValue, { fontSize: 13, marginTop: 4 }]} numberOfLines={1}>
                      {isAr ? 'مجاورة 46' : 'Mogawra 46'}
                    </Text>
                  </View>
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
                  {/* Progress Bar */}
                  <View style={styles.progressBarTrack}>
                    <View style={[styles.progressBarFill, { width: '85%' }]} />
                  </View>
                </View>

              </View>

              {/* ── Double Tap Vault Button ── */}
              <View style={{ flex: 1, justifyContent: 'flex-end', width: '100%', paddingBottom: 20 }}>
                <TouchableOpacity 
                  activeOpacity={0.7} 
                  onPress={handleDoubleTap}
                  style={styles.vaultButton}
                >
                  <Ionicons name="lock-closed-outline" size={20} color={COLORS.accent} />
                  <Text style={styles.vaultText}>
                    {isAr ? 'اضغط مرتين لفتح سجل الرحلات' : 'Double tap to unlock Trips'}
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