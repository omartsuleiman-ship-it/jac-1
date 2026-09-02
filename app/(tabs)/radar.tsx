import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { useRadar } from '../hooks/useRadarWatchdog';
import { RadarPoi, RadarPoiType, saveUserPoi } from '../services/radarService';
import { COLORS, useLang } from './_layout';

const PIN_COLORS: Record<RadarPoiType, string> = {
  radar: '#FF3B30',
  bump: '#FFB020',
  comment: '#5AC8FA',
};

export default function RadarScreen() {
  const { isAr } = useLang();
  const {
    location,
    nearbyPois,
    foregroundPermissionGranted,
    backgroundPermissionGranted,
    smartAlertsEnabled,
    setSmartAlertsEnabled,
    refreshPois,
  } = useRadar();

  const [modalVisible, setModalVisible] = useState(false);
  const [pendingCoords, setPendingCoords] = useState<{ latitude: number; longitude: number } | null>(null);

  const speedKmh =
    location?.coords.speed && location.coords.speed > 0 ? Math.round(location.coords.speed * 3.6) : 0;

  const initialRegion: Region = {
    latitude: location?.coords.latitude ?? 30.0444,
    longitude: location?.coords.longitude ?? 31.2357,
    latitudeDelta: 0.05,
    longitudeDelta: 0.05,
  };

  const handleLongPress = useCallback((e: any) => {
    setPendingCoords(e.nativeEvent.coordinate);
    setModalVisible(true);
  }, []);

  const handleAddPoi = useCallback(
    async (type: RadarPoiType) => {
      if (!pendingCoords) return;
      const poi: RadarPoi = {
        id: `user-${Date.now()}`,
        type,
        latitude: pendingCoords.latitude,
        longitude: pendingCoords.longitude,
        maxspeed: null,
        source: 'user',
      };
      try {
        await saveUserPoi(poi);
        await refreshPois(); // pulls the new pin onto the map immediately
      } catch (error) {
        Alert.alert(isAr ? 'خطأ' : 'Error', isAr ? 'تعذر حفظ النقطة' : 'Failed to save the point');
      }
      setModalVisible(false);
      setPendingCoords(null);
    },
    [pendingCoords, refreshPois, isAr]
  );

  const poiLabel = useCallback(
    (poi: RadarPoi) => {
      if (poi.type === 'radar') {
        return isAr
          ? `رادار${poi.maxspeed ? ` — ${poi.maxspeed} كم/س` : ''}`
          : `Speed camera${poi.maxspeed ? ` — ${poi.maxspeed} km/h` : ''}`;
      }
      if (poi.type === 'bump') return isAr ? 'مطب صناعي' : 'Speed bump';
      return poi.note || (isAr ? 'ملاحظة' : 'Comment');
    },
    [isAr]
  );

  const markers = useMemo(
    () =>
      nearbyPois.map((poi) => (
        <Marker
          key={poi.id}
          coordinate={{ latitude: poi.latitude, longitude: poi.longitude }}
          pinColor={PIN_COLORS[poi.type]}
          title={poiLabel(poi)}
        />
      )),
    [nearbyPois, poiLabel]
  );

  return (
    <View style={styles.container}>
      <MapView
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton
        onLongPress={handleLongPress}
      >
        {markers}
      </MapView>

      {!foregroundPermissionGranted && (
        <View style={styles.permissionBanner}>
          <Text style={styles.permissionText}>
            {isAr
              ? 'يجب السماح بالوصول للموقع لتفعيل تنبيهات الرادار'
              : 'Location permission is required for radar alerts'}
          </Text>
        </View>
      )}
      {foregroundPermissionGranted && !backgroundPermissionGranted && (
        <View style={styles.permissionBanner}>
          <Text style={styles.permissionText}>
            {isAr
              ? 'التنبيهات ستعمل فقط أثناء فتح التطبيق. اسمح بالوصول للموقع "دائماً" من الإعدادات لتعمل والشاشة مقفلة'
              : 'Alerts will only work while the app is open. Allow "Always" location access in Settings for screen-off alerts'}
          </Text>
        </View>
      )}

      <View style={styles.speedometer}>
        <Text style={styles.speedValue}>{speedKmh}</Text>
        <Text style={styles.speedUnit}>{isAr ? 'كم/س' : 'km/h'}</Text>
      </View>

      <View style={styles.toggleCard}>
        <Text style={styles.toggleLabel}>{isAr ? 'تنبيهات ذكية' : 'Smart Alerts'}</Text>
        <Switch
          value={smartAlertsEnabled}
          onValueChange={setSmartAlertsEnabled}
          trackColor={{ false: COLORS.inactive, true: COLORS.active }}
          thumbColor="#FFFFFF"
        />
      </View>

      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{isAr ? 'إضافة نقطة' : 'Add a point'}</Text>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.radar }]}
              onPress={() => handleAddPoi('radar')}
            >
              <Ionicons name="camera" size={20} color={PIN_COLORS.radar} />
              <Text style={styles.modalOptionText}>{isAr ? 'رادار' : 'Radar'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.bump }]}
              onPress={() => handleAddPoi('bump')}
            >
              <Ionicons name="alert-circle" size={20} color={PIN_COLORS.bump} />
              <Text style={styles.modalOptionText}>{isAr ? 'مطب صناعي' : 'Speed Bump'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.comment }]}
              onPress={() => handleAddPoi('comment')}
            >
              <Ionicons name="chatbubble" size={20} color={PIN_COLORS.comment} />
              <Text style={styles.modalOptionText}>{isAr ? 'ملاحظة' : 'Comment'}</Text>
            </Pressable>

            <Pressable style={styles.modalCancel} onPress={() => setModalVisible(false)}>
              <Text style={styles.modalCancelText}>{isAr ? 'إلغاء' : 'Cancel'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  permissionBanner: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  permissionText: { color: '#FFFFFF', textAlign: 'center', fontSize: 13 },
  speedometer: {
    position: 'absolute',
    bottom: 110,
    alignSelf: 'center',
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 60,
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedValue: { color: COLORS.active, fontSize: 32, fontWeight: '800' },
  speedUnit: { color: COLORS.inactive, fontSize: 11, marginTop: -2 },
  toggleCard: {
    position: 'absolute',
    top: 50,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  toggleLabel: { color: '#FFFFFF', fontSize: 13, fontWeight: '600', marginRight: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalCard: {
    width: '80%',
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 14, textAlign: 'center' },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  modalOptionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', marginLeft: 10 },
  modalCancel: { alignItems: 'center', paddingVertical: 10, marginTop: 4 },
  modalCancelText: { color: COLORS.inactive, fontSize: 13 },
});
