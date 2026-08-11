import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ImageBackground,
  Modal,
  PanResponder,
  Platform,
  Pressable,
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
  glassBg: 'rgba(15, 18, 23, 0.4)', 
  glassBorder: 'rgba(255, 255, 255, 0.15)', 
  menuBg: '#0B0D10',
};

export default function HomeScreen() {
  const { toggleLang, isAr } = useLang();
  const [menuVisible, setMenuVisible] = useState(false);
  const [greeting, setGreeting] = useState('');

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

  const navigateTo = (path: any) => {
    setMenuVisible(false);
    router.push(path);
  };

  // ── مستشعر السحب ──
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (evt, gestureState) => {
      return Math.abs(gestureState.dx) > 20 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy);
    },
    onPanResponderRelease: (evt, gestureState) => {
      if (!isAr) {
        if (gestureState.dx > 40) setMenuVisible(true); 
        if (gestureState.dx < -40) setMenuVisible(false);
      } else {
        if (gestureState.dx < -40) setMenuVisible(true);
        if (gestureState.dx > 40) setMenuVisible(false);
      }
    },
  }), [isAr]);

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <ImageBackground
        source={require('../../assets/images/jac.jpg')} 
        style={styles.background}
        resizeMode="cover"
      >
        <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
        
        <View style={styles.overlay}>
          <SafeAreaView style={styles.safeArea}>
            
            <View style={[styles.topBar, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <TouchableOpacity onPress={() => setMenuVisible(true)} style={styles.iconBtn}>
                <Ionicons name="menu" size={32} color={COLORS.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={[styles.mainContent, { alignItems: isAr ? 'flex-end' : 'flex-start' }]}>
              <Text style={[isAr ? styles.greetingTextAr : styles.greetingTextEn, { textAlign: isAr ? 'right' : 'left' }]}>
                {greeting}
              </Text>
              
              <Text style={[isAr ? styles.subtitleTextAr : styles.subtitleTextEn, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? 'عربيتك جاك في انتظار أوامرك..' : 'YOUR JAC IS AWAITING COMMANDS..'}
              </Text>

              <View style={[styles.weatherCard, { flexDirection: isAr ? 'row-reverse' : 'row', marginTop: 20 }]}>
                <View style={[styles.weatherRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  <Ionicons name="location" size={16} color={COLORS.accent} />
                  <Text style={isAr ? styles.weatherTextAr : styles.weatherTextEn}>
                    {isAr ? 'العاشر من رمضان' : '10th of Ramadan'}
                  </Text>
                </View>
                <View style={styles.weatherDivider} />
                <View style={[styles.weatherRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                  <Ionicons name="partly-sunny" size={16} color="#F2C94C" />
                  <Text style={isAr ? styles.weatherTextAr : styles.weatherTextEn}>
                    {isAr ? '٢٩° - صافي' : '29°C - Clear'}
                  </Text>
                </View>
              </View>
            </View>
          </SafeAreaView>
        </View>
      </ImageBackground>

      <Modal visible={menuVisible} animationType="fade" transparent={true} onRequestClose={() => setMenuVisible(false)}>
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBgClose} onPress={() => setMenuVisible(false)} />
          
          <View style={[styles.drawerContainer, isAr ? { right: 0 } : { left: 0 }]}>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={styles.drawerHeader}>
                <View style={styles.drawerAvatar}>
                  <Text style={styles.drawerAvatarText}>OM</Text>
                </View>
                <TouchableOpacity onPress={() => setMenuVisible(false)}>
                  <Ionicons name="close" size={28} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.drawerLinks}>
                <TouchableOpacity style={[styles.drawerLink, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => navigateTo('/(tabs)/trip')}>
                  <Ionicons name="map-outline" size={24} color={COLORS.accent} />
                  <Text style={isAr ? styles.drawerLinkTextAr : styles.drawerLinkTextEn}>
                    {isAr ? 'الرحلات والتكلفة' : 'Trip & Cost'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.drawerLink, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => navigateTo('/(tabs)/diagnostics')}>
                  <Ionicons name="pulse-outline" size={24} color="#FF6B5E" />
                  <Text style={isAr ? styles.drawerLinkTextAr : styles.drawerLinkTextEn}>
                    {isAr ? 'فحص الأعطال' : 'Diagnostics'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.drawerLink, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => navigateTo('/(tabs)/maintenance')}>
                  <Ionicons name="build-outline" size={24} color="#FFB74D" />
                  <Text style={isAr ? styles.drawerLinkTextAr : styles.drawerLinkTextEn}>
                    {isAr ? 'سجل الصيانة' : 'Maintenance'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.drawerLink, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => navigateTo('/(tabs)/connection')}>
                  <Ionicons name="bluetooth-outline" size={24} color="#3498DB" />
                  <Text style={isAr ? styles.drawerLinkTextAr : styles.drawerLinkTextEn}>
                    {isAr ? 'إعدادات البلوتوث' : 'Bluetooth Settings'}
                  </Text>
                </TouchableOpacity>

                <View style={styles.drawerDivider} />

                <TouchableOpacity style={[styles.drawerLink, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={toggleLang}>
                  <Ionicons name="language-outline" size={24} color={COLORS.textPrimary} />
                  <Text style={isAr ? styles.drawerLinkTextAr : styles.drawerLinkTextEn}>
                    {isAr ? 'English' : 'اللغة العربية'}
                  </Text>
                </TouchableOpacity>
              </View>
            </SafeAreaView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  background: { flex: 1, width: '100%', height: '100%' },
  overlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.4)', justifyContent: 'flex-start' },
  safeArea: { flex: 1 },
  
  topBar: { paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 10 : 40, justifyContent: 'space-between', alignItems: 'center', marginBottom: 40 },
  iconBtn: { padding: 5 },

  mainContent: { paddingHorizontal: 24, flex: 1, justifyContent: 'flex-start' },
  
  greetingTextAr: { color: COLORS.textPrimary, fontSize: 36, fontWeight: '900', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 6 },
  subtitleTextAr: { color: COLORS.accent, fontSize: 18, fontWeight: '800', marginTop: 8, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  
  greetingTextEn: { color: COLORS.textPrimary, fontSize: 40, fontWeight: '900', fontStyle: 'italic', textTransform: 'uppercase', textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 4, letterSpacing: 1 },
  subtitleTextEn: { color: COLORS.accent, fontSize: 16, fontWeight: '800', fontStyle: 'italic', marginTop: 8, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 3, letterSpacing: 2 },
  
  weatherCard: { backgroundColor: COLORS.glassBg, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, borderWidth: 1, borderColor: COLORS.glassBorder, alignItems: 'center', gap: 12 },
  weatherRow: { alignItems: 'center', gap: 6 },
  weatherDivider: { width: 1, height: 20, backgroundColor: COLORS.glassBorder, marginHorizontal: 4 },
  weatherTextAr: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700' },
  weatherTextEn: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700', fontStyle: 'italic' },

  modalOverlay: { flex: 1, flexDirection: 'row' },
  modalBgClose: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  drawerContainer: { position: 'absolute', top: 0, bottom: 0, width: '75%', backgroundColor: COLORS.menuBg, padding: 24, borderRightWidth: 1, borderLeftWidth: 1, borderColor: '#1F2428' },
  drawerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 40, marginTop: Platform.OS === 'ios' ? 10 : 30 },
  drawerAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0, 217, 198, 0.15)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.accent },
  drawerAvatarText: { color: COLORS.accent, fontSize: 18, fontWeight: 'bold' },
  
  drawerLinks: { gap: 24 },
  drawerLink: { alignItems: 'center', gap: 16 },
  drawerLinkTextAr: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '700' },
  drawerLinkTextEn: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '800', fontStyle: 'italic', letterSpacing: 1 },
  drawerDivider: { height: 1, backgroundColor: '#1F2428', width: '100%', marginVertical: 8 },
});