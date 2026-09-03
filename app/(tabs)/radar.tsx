import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { useRadar } from '../hooks/useRadarWatchdog';
import {
  RadarPoi,
  RadarPoiType,
  boundingBoxFilter,
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
    nearbyPois,
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
  // لما ده يبقى فيه قيمة، الماب بتعرض ردارات منطقة معينة (بحث أو نقطة
  // long-press) بدل الردارات القريبة من موقعك الحالي. بيترجع null (يعني
  // رجوع للوضع العادي) لما تعمل بحث جديد، أو طلب "ردارات محيطة" جديد،
  // أو تدوس زرار الموقع، أو تقفل الشاشة (بيتصفّر تلقائي مع كل mount جديد).
  const [customView, setCustomView] = useState<{
    center: { latitude: number; longitude: number };
    radiusKm: number;
    label?: string;
  } | null>(null);

  const [searchModalVisible, setSearchModalVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ latitude: number; longitude: number; label: string }>>([]);

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

  // Corrects the Cairo fallback the moment the first real fix lands, then
  // gets out of the way — must never fight the user's own panning/zooming
  // on subsequent fixes, hence the one-time ref instead of a dependency.
  const hasCenteredOnFirstFixRef = useRef(false);
  useEffect(() => {
    if (!location || hasCenteredOnFirstFixRef.current || !mapRef.current) return;
    hasCenteredOnFirstFixRef.current = true;
    mapRef.current.animateCamera({
      center: { latitude: location.coords.latitude, longitude: location.coords.longitude },
    });
  }, [location]);

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

  const formatAddressLabel = (addr: Location.LocationGeocodedAddress): string => {
    const parts = [addr.name, addr.district, addr.city, addr.subregion].filter(
      (p, idx, arr) => !!p && arr.indexOf(p) === idx
    );
    return parts.length > 0 ? parts.join('، ') : isAr ? 'موقع غير مسمى' : 'Unnamed location';
  };

  const handleSearchSubmit = useCallback(async () => {
    const query = searchText.trim();
    if (!query) return;
    setSearching(true);
    try {
      const geocoded = await Location.geocodeAsync(query);
      if (!geocoded || geocoded.length === 0) {
        Alert.alert(isAr ? 'لا توجد نتائج' : 'No results', isAr ? 'لم يتم العثور على هذا المكان' : 'Could not find that place');
        setSearching(false);
        return;
      }
      const withLabels = await Promise.all(
        geocoded.slice(0, 8).map(async (g) => {
          try {
            const [addr] = await Location.reverseGeocodeAsync({ latitude: g.latitude, longitude: g.longitude });
            return { latitude: g.latitude, longitude: g.longitude, label: addr ? formatAddressLabel(addr) : query };
          } catch {
            return { latitude: g.latitude, longitude: g.longitude, label: query };
          }
        })
      );
      setSearchResults(withLabels);
    } catch (error) {
      Alert.alert(isAr ? 'خطأ' : 'Error', isAr ? 'تعذر البحث الآن' : 'Search failed');
    }
    setSearching(false);
  }, [searchText, isAr]);

  const handleSelectSearchResult = useCallback(
    (result: { latitude: number; longitude: number; label: string }) => {
      // نطاق ثابت أكبر شوية من الوضع العادي عشان يغطي منطقة/تجمع كامل تقريبًا
      // (مفيش عندنا بيانات حدود مناطق فعلية نستخدمها). العرض pins عادية
      // بدون تجميع زي أي وضع تاني، فمفيش خطورة هنج حتى لو العدد زاد شوية.
      const SEARCH_RADIUS_KM = 8;
      setCustomView({
        center: { latitude: result.latitude, longitude: result.longitude },
        radiusKm: SEARCH_RADIUS_KM,
        label: result.label,
      });
      mapRef.current?.animateCamera({
        center: { latitude: result.latitude, longitude: result.longitude },
      });
      setSearchModalVisible(false);
      setSearchText('');
      setSearchResults([]);
    },
    []
  );

  const handleShowSurroundingRadars = useCallback(() => {
    if (!pendingCoords) return;
    const coords = pendingCoords;
    setModalVisible(false);
    Alert.alert(
      isAr ? 'إظهار الردارات المحيطة' : 'Show surrounding radars',
      isAr ? 'اختر نطاق البحث' : 'Choose the radius',
      [
        { text: '2 km', onPress: () => setCustomView({ center: coords, radiusKm: 2 }) },
        { text: '5 km', onPress: () => setCustomView({ center: coords, radiusKm: 5 }) },
        { text: '10 km', onPress: () => setCustomView({ center: coords, radiusKm: 10 }) },
        { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
      ]
    );
    setPendingCoords(null);
  }, [pendingCoords, isAr]);

  const handleRecenter = useCallback(() => {
    setCustomView(null); // ارجع لعرض الردارات القريبة من موقعك الحقيقي
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

   // الوضع العادي: نفس القديم بالظبط — ردارات 5 كم حوالين موقعك الحقيقي
  // (nearbyPois جاهزة من useRadar، بتتحدث مع كل GPS fix).
  // وضع البحث/المنطقة المحيطة: فلترة من allPois (القائمة الكاملة) حوالين
  // نقطة تانية (نتيجة بحث أو نقطة long-press) — منفصل تمامًا عن موقعك.
  const displayedPois = useMemo(() => {
    if (customView) {
      return boundingBoxFilter(allPois, customView.center.latitude, customView.center.longitude, customView.radiusKm);
    }
    return nearbyPois;
  }, [customView, allPois, nearbyPois]);

  const markers = useMemo(
    () =>
      displayedPois.map((poi) => (
        <Marker
          key={poi.id}
          coordinate={{ latitude: poi.latitude, longitude: poi.longitude }}
          pinColor={PIN_COLORS[poi.type]}
          title={poiLabel(poi)}
          onCalloutPress={() => handleDeletePoi(poi)}
        />
      )),
    [displayedPois, poiLabel, handleDeletePoi]
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
        <View style={styles.topRow}>
          <Pressable style={styles.searchButton} onPress={() => setSearchModalVisible(true)}>
            <Ionicons name="search" size={20} color="#FFFFFF" />
          </Pressable>

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
        </View>

        {customView && (
          <View style={styles.customViewBanner}>
            <Text style={styles.permissionText}>
              {isAr
                ? `بتعرض ردارات ${customView.label ? customView.label + ' ' : ''}(نطاق ${customView.radiusKm} كم) — دوس زرار الموقع للرجوع`
                : `Showing radars ${customView.label ? 'near ' + customView.label + ' ' : ''}(${customView.radiusKm} km radius) — tap the location button to go back`}
            </Text>
          </View>
        )}

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

            <Pressable
              style={[styles.modalOption, { borderColor: COLORS.active }]}
              onPress={handleShowSurroundingRadars}
            >
              <Ionicons name="radio" size={20} color={COLORS.active} />
              <Text style={styles.modalOptionText}>{isAr ? 'إظهار الردارات المحيطة' : 'Show surrounding radars'}</Text>
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

      <Modal
        visible={searchModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSearchModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{isAr ? 'ابحث عن منطقة' : 'Search a place'}</Text>
            <TextInput
              style={styles.commentInput}
              value={searchText}
              onChangeText={setSearchText}
              placeholder={isAr ? 'مثال: التجمع الخامس' : 'e.g. Maadi'}
              placeholderTextColor={COLORS.inactive}
              autoFocus
              onSubmitEditing={handleSearchSubmit}
            />

            {searchResults.length > 0 && (
              <ScrollView style={styles.searchResultsList}>
                {searchResults.map((r, idx: number) => (
                  <Pressable
                    key={`${r.latitude}-${r.longitude}-${idx}`}
                    style={styles.searchResultRow}
                    onPress={() => handleSelectSearchResult(r)}
                  >
                    <Ionicons name="location" size={16} color={COLORS.active} />
                    <Text style={styles.searchResultText}>{r.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <Pressable
              style={[styles.modalOption, { borderColor: COLORS.active, opacity: searching ? 0.5 : 1 }]}
              onPress={handleSearchSubmit}
              disabled={searching}
            >
              <Ionicons name="search" size={20} color={COLORS.active} />
              <Text style={styles.modalOptionText}>
                {searching ? (isAr ? 'جاري البحث...' : 'Searching...') : isAr ? 'بحث' : 'Search'}
              </Text>
            </Pressable>

            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setSearchModalVisible(false);
                setSearchText('');
                setSearchResults([]);
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
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  searchButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customViewBanner: {
    alignSelf: 'stretch',
    marginTop: 8,
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.active,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  searchResultsList: {
    maxHeight: 180,
    marginBottom: 12,
  },
  searchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.tabBarBorder,
  },
  searchResultText: {
    color: '#FFFFFF',
    fontSize: 13,
    marginLeft: 8,
    flex: 1,
  },
});
