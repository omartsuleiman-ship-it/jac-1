import Ionicons from '@expo/vector-icons/Ionicons';
import { Camera, Map, UserLocation, ViewAnnotation } from '@maplibre/maplibre-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native';
import { COLORS, useLang } from '../(tabs)/_layout';
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

const MAP_STYLE_STORAGE_KEY = '@radar_map/map_style_v1';

// إعدادات خريطة القمر الصناعي المجانية (Esri World Imagery)
const satelliteStyle = JSON.stringify({
  version: 8,
  sources: {
    rasterTiles: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
    },
  },
  layers: [
    {
      id: 'raster-layer',
      type: 'raster',
      source: 'rasterTiles',
      minzoom: 0,
      maxzoom: 22,
    },
  ],
});

const PIN_COLORS: Record<RadarPoiType, string> = {
  radar: '#FF3B30',
  bump: '#FFB020',
  police: '#1E3A8A',
  roadwork: '#F59E0B',
  traffic: '#6B7280',
  accident: '#EC4899',
  comment: '#5AC8FA',
};

// صور PNG حقيقية بدل أيقونات Ionicons المولّدة — نفس الصور مستخدمة في
// الماركر على الخريطة وفي خيارات قائمة "إضافة نقطة"، عشان يفضلوا متطابقين
// بصريًا. require() بيتحل وقت الـ build، فلازم الملفات دي موجودة فعليًا
// في app/assets/icons/ قبل أي build.
const POI_ICON_IMAGES: Record<RadarPoiType, any> = {
  radar: require('../assets/icons/radar.png'),
  bump: require('../assets/icons/bump.png'),
  police: require('../assets/icons/police.png'),
  roadwork: require('../assets/icons/roadwork.png'),
  traffic: require('../assets/icons/traffic.png'),
  accident: require('../assets/icons/accident.png'),
  comment: require('../assets/icons/comment.png'),
};
export function RadarScreenInner() {
  const { isAr } = useLang();
  const {
    location,
    nearbyPois,
    foregroundPermissionGranted,
    isScanning,
    startScanning,
    stopScanning,
    smartAlertsEnabled,
    setSmartAlertsEnabled,
    refreshPois,
    speedKmh,
  } = useRadar();

  const [modalVisible, setModalVisible] = useState(false);
  const [commentModalVisible, setCommentModalVisible] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [pendingCoords, setPendingCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  // Two-step Add POI flow: step 1 picks a TYPE (radar/bump/...), step 2 asks
  // WHERE (current location vs. pin on the map). null selectedPoiType means
  // the modal is showing step 1.
  const [selectedPoiType, setSelectedPoiType] = useState<RadarPoiType | null>(null);
  // Set only when "Pin on the map" was chosen in step 2 — tells
  // handleMapPress this armed tap is placing a NEW POI of this type, not
  // picking a search location (the other thing pinPickMode is reused for).
  const [pendingPoiType, setPendingPoiType] = useState<RadarPoiType | null>(null);
  // Which marker's info card is currently expanded (tap to toggle).
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null);
  const mapRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  // 'standard' (vector tiles) uses far less GPU/battery than satellite
  // imagery — default to it and let the user opt into satellite explicitly.
  // Dark mode is now a manual pick from this same menu, not tied to the
  // system theme.
  const [mapType, setMapType] = useState<'standard' | 'dark' | 'satellite'>('standard');
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(MAP_STYLE_STORAGE_KEY).then((saved) => {
      if (saved === 'standard' || saved === 'dark' || saved === 'satellite') setMapType(saved);
    });
  }, []);

  const mapStyleURL = useMemo(() => {
    if (mapType === 'dark') return 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
    if (mapType === 'satellite') return 'https://api.maptiler.com/maps/hybrid/style.json?key=oyMLTPzFnXdyVYFlohiu';
    return 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
  }, [mapType]);

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
  // true while the user is expected to tap a point on the map (after
  // pressing "Pin on the map" inside the search modal) instead of typing.
  const [pinPickMode, setPinPickMode] = useState(false);

  const [suggestions, setSuggestions] = useState<Array<{ latitude: number; longitude: number; label: string }>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const suggestionsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAllPois = useCallback(async () => {
    const userPois = await loadUserPois();
    setAllPois([...getStaticPois(), ...userPois]);
  }, []);

  useEffect(() => {
    loadAllPois();
  }, [loadAllPois]);

  // <Camera followUserLocation followUserMode={FollowWithHeading}> in the
  // JSX below now owns positioning, rotation, AND zoom natively — no more
  // manual animateCamera effect, no destinationPoint math, no zoom-tracking
  // ref. Only a plain fallback center needed for before the first fix.
  const DEFAULT_CENTER: [number, number] = [
    location?.coords.longitude ?? 31.2357,
    location?.coords.latitude ?? 30.0444,
  ];

  // Button-triggered now, not long-press: reports are always added at the
  // user's OWN current position — same convention as Waze/Google Maps'
  // report button — not an arbitrary tapped point.
  const handleOpenAddPoiModal = useCallback(() => {
    if (!location) {
      Alert.alert(
        isAr ? 'الموقع غير متاح' : 'Location unavailable',
        isAr ? 'انتظر حتى يتحدد موقعك الحالي' : 'Wait until your current location is determined'
      );
      return;
    }
    setPendingCoords({ latitude: location.coords.latitude, longitude: location.coords.longitude });
    setModalVisible(true);
  }, [location, isAr]);

  const handleAddPoi = useCallback(
    async (type: RadarPoiType, note?: string, coordsOverride?: { latitude: number; longitude: number }) => {
      // coordsOverride lets the map-tap path (handleMapPress below) pass
      // fresh coordinates directly instead of relying on pendingCoords —
      // setState is async, so a caller that just called setPendingCoords()
      // in the same tick would otherwise read the STALE value here.
      const coords = coordsOverride ?? pendingCoords;
      if (!coords) return;
      const poi: RadarPoi = {
        id: `user-${Date.now()}`,
        type,
        latitude: coords.latitude,
        longitude: coords.longitude,
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
      setSelectedPoiType(null);
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

  useEffect(() => {
    return () => {
      if (suggestionsDebounceRef.current) clearTimeout(suggestionsDebounceRef.current);
    };
  }, []);

  const fetchSuggestions = useCallback(
    (query: string) => {
      if (suggestionsDebounceRef.current) clearTimeout(suggestionsDebounceRef.current);

      const trimmed = query.trim();
      if (trimmed.length < 2) {
        setSuggestions([]);
        setSuggestionsLoading(false);
        return;
      }

      suggestionsDebounceRef.current = setTimeout(async () => {
        setSuggestionsLoading(true);
        try {
          const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
            trimmed
          )}&format=json&countrycodes=eg&limit=5`;
          const response = await fetch(url, {
            headers: {
              // Nominatim's usage policy requires a distinguishing User-Agent —
              // requests without one risk silent rate-limiting or blocking.
              'User-Agent': 'jac-radar-app/1.0',
              'Accept-Language': isAr ? 'ar' : 'en',
            },
          });
          const results = await response.json();
          setSuggestions(
            (Array.isArray(results) ? results : []).map((r: any) => ({
              latitude: parseFloat(r.lat),
              longitude: parseFloat(r.lon),
              label: r.display_name as string,
            }))
          );
        } catch {
          setSuggestions([]);
        }
        setSuggestionsLoading(false);
      }, 400);
    },
    [isAr]
  );

  const handleSelectSearchResult = useCallback(
    (result: { latitude: number; longitude: number; label: string }) => {
      // نطاق ثابت 5 كم دايمًا الآن — مفيش اختيار نطاق (2/5/10) تاني بقرار
      // صريح: أي نتيجة بحث أو نقطة مثبّتة على الخريطة بتعرض ردارات 5 كم
      // حواليها فورًا من غير سؤال إضافي.
      const SEARCH_RADIUS_KM = 5;
      setCustomView({
        center: { latitude: result.latitude, longitude: result.longitude },
        radiusKm: SEARCH_RADIUS_KM,
        label: result.label,
      });
      cameraRef.current?.setStop({
        center: [result.longitude, result.latitude],
        zoom: 15,
        duration: 500,
      });
      setSearchModalVisible(false);
      setSearchText('');
      setSuggestions([]);
      setPinPickMode(false);
    },
    []
  );

  // "Pin on the map": closes the search modal and arms a ONE-TIME map tap —
  // the very next onPress on the MapView (below) is treated as the chosen
  // point, then this mode turns itself off. Reuses handleSelectSearchResult
  // so the fixed-5km behavior is identical whether the point came from
  // typing or tapping.
  const handleStartPinOnMap = useCallback(() => {
    setSearchModalVisible(false);
    setSearchText('');
    setSuggestions([]);
    setPinPickMode(true);
  }, []);

  // Step 1 → step 2 of the Add POI modal: remembers the chosen type instead
  // of adding immediately, and swaps the modal body to the "Where?" prompt.
  const handleSelectPoiType = useCallback((type: RadarPoiType) => {
    setSelectedPoiType(type);
  }, []);

  const handleAddAtCurrentLocation = useCallback(() => {
    if (!selectedPoiType || !location) return;
    handleAddPoi(selectedPoiType, undefined, {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    });
  }, [selectedPoiType, location, handleAddPoi]);

  const handlePinPoiOnMap = useCallback(() => {
    if (!selectedPoiType) return;
    setPendingPoiType(selectedPoiType);
    setSelectedPoiType(null);
    setModalVisible(false);
    setPinPickMode(true);
  }, [selectedPoiType]);

  const handleMapPress = useCallback(
    (event: any) => {
      if (!pinPickMode) return;
      const [longitude, latitude] = event.nativeEvent.lngLat;

      if (pendingPoiType) {
        const type = pendingPoiType;
        setPendingPoiType(null);
        setPinPickMode(false);
        handleAddPoi(type, undefined, { latitude, longitude });
        return;
      }

      handleSelectSearchResult({ latitude, longitude, label: isAr ? 'موقع مخصص' : 'Pinned location' });
    },
    [pinPickMode, pendingPoiType, handleAddPoi, handleSelectSearchResult, isAr]
  );

  const handleRecenter = useCallback(() => {
    setCustomView(null); // ارجع لعرض الردارات القريبة من موقعك الحقيقي
    if (!location) return;
    // No manual heading math needed — <Camera followUserLocation
    // followUserMode={FollowWithHeading}> below already keeps the map
    // course-up continuously. This just snaps back to it if the user panned away.
    cameraRef.current?.setStop({
      center: [location.coords.longitude, location.coords.latitude],
      zoom: 15,
      duration: 500,
    });
  }, [location]);

  const toggleStyleMenu = useCallback(() => {
    setStyleMenuOpen((prev) => !prev);
  }, []);

  const selectMapType = useCallback((type: 'standard' | 'dark' | 'satellite') => {
    setMapType(type);
    setStyleMenuOpen(false);
    AsyncStorage.setItem(MAP_STYLE_STORAGE_KEY, type).catch(() => {});
  }, []);

  const poiLabel = useCallback(
    (poi: RadarPoi) => {
      if (poi.type === 'radar') {
        return isAr
          ? `رادار${poi.maxspeed ? ` — ${poi.maxspeed} كم/س` : ''}`
          : `Speed camera${poi.maxspeed ? ` — ${poi.maxspeed} km/h` : ''}`;
      }
      if (poi.type === 'bump') return isAr ? 'مطب صناعي' : 'Speed bump';
      if (poi.type === 'police') return isAr ? 'نقطة شرطة' : 'Police checkpoint';
      if (poi.type === 'roadwork') return isAr ? 'أعمال طريق' : 'Roadwork';
      if (poi.type === 'traffic') return isAr ? 'زحمة مرور' : 'Traffic jam';
      if (poi.type === 'accident') return isAr ? 'حادث' : 'Accident';
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
        <ViewAnnotation
          key={poi.id}
          lngLat={[poi.longitude, poi.latitude]}
          onSelect={() => setSelectedPoiId((prev) => (prev === poi.id ? null : poi.id))}
        >
          <View style={styles.markerWrap}>
            {selectedPoiId === poi.id && (
              <View style={styles.calloutBubble}>
                <Text style={styles.calloutText} numberOfLines={2}>
                  {poiLabel(poi)}
                </Text>
                {/* Core/database radars have source !== 'user' — no trash
                    button renders for them at all, not just a disabled one. */}
                {poi.source === 'user' && (
                  <Pressable
                    style={styles.calloutDeleteButton}
                    onPress={() => {
                      setSelectedPoiId(null);
                      handleDeletePoi(poi);
                    }}
                  >
                    <Ionicons name="trash" size={16} color="#FFFFFF" />
                  </Pressable>
                )}
              </View>
            )}
            <Image source={POI_ICON_IMAGES[poi.type]} style={styles.poiMarkerImage} resizeMode="contain" />
          </View>
        </ViewAnnotation>
      )),
    [displayedPois, poiLabel, handleDeletePoi, selectedPoiId]
  );

  return (
    <View style={styles.container}>
      <Map ref={mapRef} style={{ flex: 1 }} mapStyle={mapStyleURL} onPress={handleMapPress}>
        <Camera
          ref={cameraRef}
          initialViewState={{ center: DEFAULT_CENTER, zoom: 15 }}
          trackUserLocation={isScanning && foregroundPermissionGranted ? 'course' : undefined}
          zoom={16}
          pitch={isScanning ? 50 : 0}
        />

        {foregroundPermissionGranted && (
          <UserLocation heading />
        )}

        {markers}
      </Map>

      <Pressable style={styles.recenterButton} onPress={handleRecenter}>
        <Ionicons name="locate" size={22} color="#FFFFFF" />
      </Pressable>

      <Pressable style={styles.layersButton} onPress={toggleStyleMenu}>
        <Ionicons name="layers-outline" size={22} color="#FFFFFF" />
      </Pressable>

      {styleMenuOpen && (
        <View style={styles.mapStyleMenu}>
          <Pressable
            style={[styles.mapStyleMenuButton, mapType === 'standard' && styles.mapStyleMenuButtonActive]}
            onPress={() => selectMapType('standard')}
          >
            <Ionicons name="sunny-outline" size={18} color="#FFFFFF" />
          </Pressable>
          <Pressable
            style={[styles.mapStyleMenuButton, mapType === 'dark' && styles.mapStyleMenuButtonActive]}
            onPress={() => selectMapType('dark')}
          >
            <Ionicons name="moon-outline" size={18} color="#FFFFFF" />
          </Pressable>
          <Pressable
            style={[styles.mapStyleMenuButton, mapType === 'satellite' && styles.mapStyleMenuButtonActive]}
            onPress={() => selectMapType('satellite')}
          >
            <Ionicons name="globe-outline" size={18} color="#FFFFFF" />
          </Pressable>
        </View>
      )}

      <Pressable style={styles.searchRadarsButton} onPress={() => setSearchModalVisible(true)}>
        <Ionicons name="radio" size={22} color="#FFFFFF" />
      </Pressable>

      <Pressable style={styles.addPoiButton} onPress={handleOpenAddPoiModal}>
        <Ionicons name="add" size={26} color="#FFFFFF" />
      </Pressable>

      <View style={styles.topOverlay} pointerEvents="box-none">
        <Pressable
          style={[styles.scanButton, isScanning ? styles.scanButtonActive : styles.scanButtonInactive]}
          onPress={isScanning ? stopScanning : startScanning}
        >
          <Ionicons name={isScanning ? 'stop-circle' : 'play-circle'} size={20} color="#FFFFFF" />
          <Text style={styles.scanButtonText}>
            {isScanning ? (isAr ? 'إيقاف المسح' : 'Stop Scan') : isAr ? 'ابدأ المسح' : 'Start Scan'}
          </Text>
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

        {pinPickMode && (
          <View style={styles.customViewBanner}>
            <Text style={styles.permissionText}>
              {isAr ? 'اضغط على أي نقطة بالخريطة لتحديد الموقع' : 'Tap anywhere on the map to pick a location'}
            </Text>
          </View>
        )}

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
      </View>

      <View style={styles.speedometer}>
        <Text style={styles.speedValue}>{isScanning ? Math.round(speedKmh) : '--'}</Text>
        <Text style={styles.speedUnit}>{isAr ? 'كم/س' : 'km/h'}</Text>
      </View>

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setModalVisible(false);
          setSelectedPoiType(null);
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {!selectedPoiType ? (
              <>
                <Text style={styles.modalTitle}>{isAr ? 'إضافة نقطة' : 'Add a point'}</Text>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.radar }]}
                  onPress={() => handleSelectPoiType('radar')}
                >
                  <Image source={POI_ICON_IMAGES.radar} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'رادار' : 'Radar'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.bump }]}
                  onPress={() => handleSelectPoiType('bump')}
                >
                  <Image source={POI_ICON_IMAGES.bump} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'مطب صناعي' : 'Speed Bump'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.police }]}
                  onPress={() => handleSelectPoiType('police')}
                >
                  <Image source={POI_ICON_IMAGES.police} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'نقطة شرطة' : 'Police'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.roadwork }]}
                  onPress={() => handleSelectPoiType('roadwork')}
                >
                  <Image source={POI_ICON_IMAGES.roadwork} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'أعمال طريق' : 'Roadwork'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.traffic }]}
                  onPress={() => handleSelectPoiType('traffic')}
                >
                  <Image source={POI_ICON_IMAGES.traffic} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'زحمة مرور' : 'Traffic Jam'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.accident }]}
                  onPress={() => handleSelectPoiType('accident')}
                >
                  <Image source={POI_ICON_IMAGES.accident} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'حادث' : 'Accident'}</Text>
                </Pressable>

                <Pressable
                  style={[styles.modalOption, { borderColor: PIN_COLORS.comment }]}
                  onPress={handleOpenCommentInput}
                >
                  <Image source={POI_ICON_IMAGES.comment} style={styles.modalOptionIcon} resizeMode="contain" />
                  <Text style={styles.modalOptionText}>{isAr ? 'ملاحظة' : 'Comment'}</Text>
                </Pressable>

                <Pressable style={styles.modalCancel} onPress={() => setModalVisible(false)}>
                  <Text style={styles.modalCancelText}>{isAr ? 'إلغاء' : 'Cancel'}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.modalTitle}>{isAr ? 'أين؟' : 'Where?'}</Text>

                <Pressable
                  style={[styles.modalOption, { borderColor: COLORS.active }]}
                  onPress={handleAddAtCurrentLocation}
                >
                  <Ionicons name="locate" size={20} color={COLORS.active} />
                  <Text style={styles.modalOptionText}>{isAr ? 'موقعك الحالي' : 'Current Location'}</Text>
                </Pressable>

                <Pressable style={[styles.modalOption, { borderColor: COLORS.active }]} onPress={handlePinPoiOnMap}>
                  <Ionicons name="location-outline" size={20} color={COLORS.active} />
                  <Text style={styles.modalOptionText}>{isAr ? 'حدد على الخريطة' : 'Pin on the map'}</Text>
                </Pressable>

                <Pressable style={styles.modalCancel} onPress={() => setSelectedPoiType(null)}>
                  <Text style={styles.modalCancelText}>{isAr ? 'رجوع' : 'Back'}</Text>
                </Pressable>
              </>
            )}
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
              {/* أيقونة "تم/checkmark" فضلت Ionicons عمدًا هنا — دي فعل حفظ عام،
                  مش تصنيف نوع نقطة، فمفيش صورة PNG مخصصة ليها أصلًا */}
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
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{isAr ? 'ابحث عن منطقة' : 'Search a place'}</Text>
              <TextInput
                style={styles.commentInput}
                value={searchText}
                onChangeText={(text) => {
                  setSearchText(text);
                  fetchSuggestions(text);
                }}
                placeholder={isAr ? 'مثال: التجمع الخامس' : 'e.g. Maadi'}
                placeholderTextColor={COLORS.inactive}
                autoFocus
              />

              {suggestionsLoading && (
                <Text style={styles.searchLoadingText}>{isAr ? 'جاري البحث...' : 'Searching...'}</Text>
              )}

              {suggestions.length > 0 && (
                <FlatList
                  style={styles.searchResultsList}
                  data={suggestions}
                  keyboardShouldPersistTaps="handled"
                  keyExtractor={(item, idx) => `sugg-${item.latitude}-${item.longitude}-${idx}`}
                  renderItem={({ item }) => (
                    <Pressable style={styles.searchResultRow} onPress={() => handleSelectSearchResult(item)}>
                      <Ionicons name="location" size={16} color={COLORS.active} />
                      <Text style={styles.searchResultText}>{item.label}</Text>
                    </Pressable>
                  )}
                />
              )}

              <Pressable style={[styles.modalOption, { borderColor: COLORS.active }]} onPress={handleStartPinOnMap}>
                <Ionicons name="location-outline" size={20} color={COLORS.active} />
                <Text style={styles.modalOptionText}>{isAr ? 'حدد على الخريطة' : 'Pin on the map'}</Text>
              </Pressable>

              <Pressable
                style={styles.modalCancel}
                onPress={() => {
                  setSearchModalVisible(false);
                  setSearchText('');
                  setSuggestions([]);
                }}
              >
                <Text style={styles.modalCancelText}>{isAr ? 'إلغاء' : 'Cancel'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
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
  modalOptionIcon: { width: 22, height: 22 },
  poiMarkerImage: { width: 32, height: 32 },
  markerWrap: { alignItems: 'center' },
  calloutBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 6,
    maxWidth: 200,
  },
  calloutText: { color: '#FFFFFF', fontSize: 12, flexShrink: 1, marginRight: 8 },
  calloutDeleteButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  layersButton: {
    position: 'absolute',
    bottom: 76,
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
  mapStyleMenu: {
    position: 'absolute',
    bottom: 76,
    right: 76,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.tabBarBg,
    borderColor: COLORS.tabBarBorder,
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 6,
    height: 48,
  },
  mapStyleMenuButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  mapStyleMenuButtonActive: {
    backgroundColor: COLORS.active,
  },
  searchRadarsButton: {
    position: 'absolute',
    bottom: 132,
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
  addPoiButton: {
    position: 'absolute',
    bottom: 188,
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.active,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 24,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  scanButtonInactive: { backgroundColor: COLORS.active },
  scanButtonActive: { backgroundColor: '#FF3B30' },
  scanButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
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
  searchLoadingText: {
    color: COLORS.inactive,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 8,
  },
  poiMarkerBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
});
