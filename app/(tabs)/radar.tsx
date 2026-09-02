import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { useRadar } from '../hooks/useRadarWatchdog';
import {
  RadarPoi,
  RadarPoiType,
  clusterPois,
  deleteUserPoi,
  getStaticPois,
  loadUserPois,
  saveUserPoi
} from '../services/radarService';
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
    foregroundPermissionGranted,
    backgroundPermissionGranted,
    smartAlertsEnabled,
    setSmartAlertsEnabled,
    refreshPois,
  } = useRadar();

  const [modalVisible, setModalVisible] = useState(false);
  const [commentModalVisible, setCommentModalVisible] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [pendingCoords, setPendingCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const mapRef = useRef<MapView>(null);

  const [allPois, setAllPois] = useState<RadarPoi[]>([]);
  const [region, setRegion] = useState<Region>({
    latitude: location?.coords.latitude ?? 30.0444,
    longitude: location?.coords.longitude ?? 31.2357,
    latitudeDelta: 0.05,
    longitudeDelta: 0.05,
  });

  const loadAllPois = useCallback(async () => {
    const userPois = await loadUserPois();
    setAllPois([...getStaticPois(), ...userPois]);
  }, []);

  useEffect(() => {
    loadAllPois();
  }, [loadAllPois]);

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
    async (type: RadarPoiType, note?: string) => {
      if (!pendingCoords) return;
      const poi: RadarPoi = {
        id: `user-${Date.now()}`,
        type,
        latitude: pendingCoords.latitude,
        longitude: pendingCoords.longitude,
        maxspeed: null,
        note,
        source: 'user',
      };
      try {
        await saveUserPoi(poi);
        await refreshPois(); // pulls the new pin onto the map immediately
        await loadAllPois();
      } catch (error) {
        Alert.alert(isAr ? 'خطأ' : 'Error', isAr ? 'تعذر حفظ النقطة' : 'Failed to save the point');
      }
      setModalVisible(false);
      setCommentModalVisible(false);
      setCommentText('');
      setPendingCoords(null);
    },
    [pendingCoords, refreshPois, loadAllPois, isAr]
  );

  const handleOpenCommentInput = useCallback(() => {
    setModalVisible(false);
    setCommentModalVisible(true);
  }, []);

  const handleSaveComment = useCallback(() => {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    handleAddPoi('comment', trimmed);
  }, [commentText, handleAddPoi]);

  const handleDeletePoi = useCallback(
    (poi: RadarPoi) => {
      if (poi.source !== 'user') return; // static OSM POIs are strictly read-only
      Alert.alert(
        isAr ? 'حذف النقطة' : 'Delete marker',
        isAr ? 'هل تريد حذف هذه النقطة؟' : 'Delete this marker?',
        [
          { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
          {
            text: isAr ? 'حذف' : 'Delete',
            style: 'destructive',
            onPress: async () => {
              await deleteUserPoi(poi.id);
              await refreshPois();
              await loadAllPois();
            },
          },
        ]
      );
    },
    [isAr, refreshPois, loadAllPois]
  );

  const handleRecenter = useCallback(() => {
    if (!location || !mapRef.current) return;
    mapRef.current.animateCamera({
      center: { latitude: location.coords.latitude, longitude: location.coords.longitude },
      // heading is -1 when the device has no reliable course (stationary /
      // weak fix) — animateCamera would otherwise snap to north unexpectedly.
      heading: location.coords.heading != null && location.coords.heading >= 0 ? location.coords.heading : undefined,
    });
  }, [location]);

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

  const clusters = useMemo(() => clusterPois(allPois, region), [allPois, region]);

  const markers = useMemo(
    () =>
      clusters.map((c) =>
        c.count > 1 ? (
          <Marker key={c.id} coordinate={{ latitude: c.latitude, longitude: c.longitude }} tracksViewChanges={false}>
            <View style={styles.clusterBadge}>
              <Text style={styles.clusterText}>{c.count}</Text>
            </View>
          </Marker>
        ) : (
          <Marker
            key={c.id}
            coordinate={{ latitude: c.poi!.latitude, longitude: c.poi!.longitude }}
            pinColor={PIN_COLORS[c.poi!.type]}
            title={poiLabel(c.poi!)}
            onCalloutPress={() => handleDeletePoi(c.poi!)}
          />
        )
      ),
    [clusters, poiLabel, handleDeletePoi]
  );

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={initialRegion}
        mapType="hybrid"
        showsUserLocation={false}
        showsMyLocationButton
        showsCompass
        onLongPress={handleLongPress}
        onRegionChangeComplete={setRegion}
      >
        {markers}
        {location && (
          <Marker
            coordinate={{ latitude: location.coords.latitude, longitude: location.coords.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={location.coords.heading != null && location.coords.heading >= 0 ? location.coords.heading : 0}
            tracksViewChanges={false}
          >
            <Ionicons name="navigate" size={30} color="#00D9C6" />
          </Marker>
        )}
      </MapView>

      <Pressable style={styles.recenterButton} onPress={handleRecenter}>
        <Ionicons name="locate" size={22} color="#FFFFFF" />
      </Pressable>

      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.toggleCard}>
            <Text style={styles.toggleLabel}>
            {smartAlertsEnabled
              ? isAr
                ? 'تنبيه عند تجاوز السرعة فقط'
                : 'Alert only if speeding'
              : isAr
              ? 'تنبيه لكل الرادارات'
              : 'Alert for all radars'}
          </Text>
          <Switch
            value={smartAlertsEnabled}
            onValueChange={setSmartAlertsEnabled}
            trackColor={{ false: COLORS.inactive, true: COLORS.active }}
            thumbColor="#FFFFFF"
          />
        </View>

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
      </View>

      <View style={styles.speedometer}>
        <Text style={styles.speedValue}>{speedKmh}</Text>
        <Text style={styles.speedUnit}>{isAr ? 'كم/س' : 'km/h'}</Text>
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
              onPress={handleOpenCommentInput}
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

      <Modal
        visible={commentModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCommentModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{isAr ? 'اكتب ملاحظتك' : 'Write your comment'}</Text>
            <TextInput
              style={styles.commentInput}
              value={commentText}
              onChangeText={setCommentText}
              placeholder={isAr ? 'مثال: بوابة تفتيش' : 'e.g. Checkpoint gate'}
              placeholderTextColor={COLORS.inactive}
              multiline
              autoFocus
            />
            <Pressable style={[styles.modalOption, { borderColor: PIN_COLORS.comment }]} onPress={handleSaveComment}>
              <Ionicons name="checkmark" size={20} color={PIN_COLORS.comment} />
              <Text style={styles.modalOptionText}>{isAr ? 'حفظ' : 'Save'}</Text>
            </Pressable>
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setCommentModalVisible(false);
                setCommentText('');
              }}
            >
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
  topOverlay: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'column',
  },
  permissionBanner: {
    alignSelf: 'stretch',
    marginTop: 8,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  permissionText: { color: '#FFFFFF', textAlign: 'center', fontSize: 13 },
  speedometer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 45,
    width: 90,
    height: 90,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedValue: { color: COLORS.active, fontSize: 28, fontWeight: '800' },
  speedUnit: { color: COLORS.inactive, fontSize: 10, marginTop: -2 },
  toggleCard: {
    alignSelf: 'flex-end',
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
  commentInput: {
    borderWidth: 1,
    borderColor: COLORS.tabBarBorder,
    borderRadius: 10,
    color: '#FFFFFF',
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  recenterButton: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  clusterText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 13,
  },
});
