import Ionicons from '@expo/vector-icons/Ionicons';

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
import MapView, { Camera, Marker } from 'react-native-maps';
import { LOCATION_TIME_INTERVAL_MS, useRadar } from '../hooks/useRadarWatchdog';
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
// Meters to project the camera's center ahead of the driver, along their
// heading, so the real GPS fix lands in the lower third of the screen
// instead of dead-center. Tuned for the fixed zoom:15/pitch:50 nav camera
// below — re-tune both together if you change either.
const NAV_FORWARD_OFFSET_M = 70;
// Where the fixed "you are here" arrow sits on screen (0 = top, 1 = bottom)
// while nav mode is active. Must stay visually matched to the offset above.
const NAV_ARROW_SCREEN_FRACTION = 0.72;

// Standard spherical "destination point given start, bearing, distance"
// formula — used only for camera framing, never for alert geometry.
function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceM: number
): { latitude: number; longitude: number } {
  const R = 6371000;
  const delta = distanceM / R;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lng * Math.PI) / 180;

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );

  return {
    latitude: (phi2 * 180) / Math.PI,
    longitude: (((lambda2 * 180) / Math.PI + 540) % 360) - 180,
  };
}
export default function RadarScreen() {
  const { isAr } = useLang();
  const {
    location,
    nearbyPois,
    foregroundPermissionGranted,
    backgroundPermissionGranted,
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
  const mapRef = useRef<MapView>(null);
  // 'standard' (vector tiles) uses far less GPU/battery than satellite
  // imagery — default to it and let the user opt into satellite explicitly.
  // 'hybrid', not 'satellite': plain 'satellite' is raw imagery with ZERO
  // road names, city labels, or POIs overlaid — that's what was rendering
  // as an empty satellite view. 'hybrid' is imagery WITH the label overlay
  // on top, same as what Google/Apple Maps call "Satellite" in their own UI.
  const [mapType, setMapType] = useState<'standard' | 'hybrid'>('standard');

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

  // initialCamera, not initialRegion — the entire point of this fix is to
  // stop mixing react-native-maps' region-based API with its camera-based
  // API on the same MapView. On iOS, any region-based call (including just
  // the initialRegion prop) can implicitly reset the native camera's
  // heading/pitch back to 0, silently fighting animateCamera() elsewhere.
  // Zoom has no exact equivalent to the old 0.05° lat/lng delta — 15 is a
  // reasonable street-level default; adjust to taste.
  const initialCamera: Camera = {
    center: {
      latitude: location?.coords.latitude ?? 30.0444,
      longitude: location?.coords.longitude ?? 31.2357,
    },
    heading: 0,
    pitch: 0,
    zoom: 15,
  };

  // Corrects the Cairo fallback the moment the first real fix lands, then
  // gets out of the way — must never fight the user's own panning/zooming
  // on subsequent fixes, hence the one-time ref instead of a dependency.
  const hasCenteredOnFirstFixRef = useRef(false);

  // THE ZOOM BUG: every animateCamera() call in this file only ever
  // specified center/heading/pitch and left `zoom` out entirely.
  // react-native-maps treats an omitted `zoom` as "set it to 0" — the
  // whole-Earth view — not "leave it alone". So every single GPS fix (each
  // course-up recenter, every LOCATION_TIME_INTERVAL_MS while scanning) was
  // silently resetting the camera to zoom 0, then immediately fighting any
  // pinch-to-zoom the user did in between fixes. This ref always holds the
  // last known real zoom level (seeded from initialCamera.zoom, kept in
  // sync by onCameraChange on the MapView below) so every animateCamera()
  // call can explicitly re-assert it instead of letting it be reset.
  const lastZoomRef = useRef(initialCamera.zoom ?? 15);

  // Single source of truth for ALL camera movement, on purpose. iOS's
  // native camera bridge has a well-documented quirk: a PARTIAL
  // animateCamera() call (e.g. center only, omitting heading/pitch) can
  // silently reset the omitted fields back to 0/north instead of leaving
  // them untouched. This file used to have three separate call sites each
  // animating only SOME camera fields (a center-only "first fix" effect, a
  // center+heading+pitch "course-up" effect, and a recenter button that
  // sometimes omitted heading entirely) — those raced each other, which is
  // very likely why the compass value updated correctly while the rendered
  // map still looked north-up/diagonal. Now there's exactly one effect, and
  // every animateCamera() call in this file (including the recenter
  // button, below) always specifies center, heading, AND pitch together.
  useEffect(() => {
    if (!location || !mapRef.current) return;

    if (isScanning) {
      // Continuous course-up nav mode: recenter AND rotate together on
      // every fix, matching standard turn-by-turn nav behavior.
      const heading = location.coords.heading; // GPS course/trajectory, NOT magnetic compass
      const hasReliableHeading = heading !== null && heading !== undefined && heading >= 0;
      // Offset the geographic center forward so the driver's true coordinate
      // sits in the lower third of the screen (see the fixed arrow overlay
      // in the JSX below, which shares NAV_ARROW_SCREEN_FRACTION).
      const center = hasReliableHeading
        ? destinationPoint(location.coords.latitude, location.coords.longitude, heading, NAV_FORWARD_OFFSET_M)
        : { latitude: location.coords.latitude, longitude: location.coords.longitude };
      // duration MUST match the fix cadence. Leaving it unset lets the
      // native animation finish early and idle until the next fix — that
      // stop/start gap is the stutter. Matching it keeps motion continuous.
      mapRef.current.animateCamera(
        {
          center,
          heading: hasReliableHeading ? heading : 0,
          pitch: hasReliableHeading ? 50 : 0,
          zoom: lastZoomRef.current,
        },
        { duration: LOCATION_TIME_INTERVAL_MS }
      );
      return;
    }

    // Not scanning: only ever center ONCE, on the first real fix — must
    // never fight the user's own panning/zooming afterward.
    if (hasCenteredOnFirstFixRef.current) return;
    hasCenteredOnFirstFixRef.current = true;
    mapRef.current.animateCamera({
      center: { latitude: location.coords.latitude, longitude: location.coords.longitude },
      heading: 0,
      pitch: 0,
      zoom: lastZoomRef.current,
    });
  }, [location, isScanning]);

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
      mapRef.current?.animateCamera({
        center: { latitude: result.latitude, longitude: result.longitude },
        zoom: lastZoomRef.current,
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

  const handleMapPress = useCallback(
    (e: any) => {
      if (!pinPickMode) return;
      const { latitude, longitude } = e.nativeEvent.coordinate;
      handleSelectSearchResult({ latitude, longitude, label: isAr ? 'موقع مخصص' : 'Pinned location' });
    },
    [pinPickMode, handleSelectSearchResult, isAr]
  );

  const handleRecenter = useCallback(() => {
    setCustomView(null); // ارجع لعرض الردارات القريبة من موقعك الحقيقي
    if (!location || !mapRef.current) return;
    // Always send the full camera object together — a partial call (e.g.
    // omitting heading) is the exact iOS quirk that could silently reset
    // course-up rotation elsewhere. Mirror whatever the effect above would
    // currently show, rather than forcing north-up, so tapping recenter
    // mid-drive doesn't un-rotate the map out from under the driver.
    const heading = location.coords.heading;
    const hasReliableHeading = heading !== null && heading !== undefined && heading >= 0;
    const useCourseUp = isScanning && hasReliableHeading;
    const center = useCourseUp
      ? destinationPoint(location.coords.latitude, location.coords.longitude, heading, NAV_FORWARD_OFFSET_M)
      : { latitude: location.coords.latitude, longitude: location.coords.longitude };
    mapRef.current.animateCamera({
      center,
      heading: useCourseUp ? heading : 0,
      pitch: useCourseUp ? 50 : 0,
      zoom: lastZoomRef.current,
    });
  }, [location, isScanning]);

  const toggleMapType = useCallback(() => {
    setMapType((prev) => (prev === 'standard' ? 'hybrid' : 'standard'));
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
        <Marker
          key={poi.id}
          coordinate={{ latitude: poi.latitude, longitude: poi.longitude }}
          title={poiLabel(poi)}
          onCalloutPress={() => handleDeletePoi(poi)}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
        >
          <Image source={POI_ICON_IMAGES[poi.type]} style={styles.poiMarkerImage} resizeMode="contain" />
        </Marker>
      )),
    [displayedPois, poiLabel, handleDeletePoi]
  );

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialCamera={initialCamera}
        mapType={mapType}
        showsUserLocation={false}
        showsMyLocationButton
        showsCompass
        onPress={handleMapPress}
        onRegionChangeComplete={(region: any) => {
          // Same purpose as onCameraChange — not present in this
          // react-native-maps version's type definitions, so we use the
          // older, universally-supported region event instead. This is
          // what stops the fight with manual pinch-to-zoom: without it, a
          // user pinch updates the native camera, but the NEXT
          // animateCamera() call (next GPS fix) would still re-assert a
          // stale zoom instead of what the user just pinched to. Standard
          // region-delta → zoom conversion: zoom 0 spans the full 360°
          // world, so zoom = log2(360 / longitudeDelta).
          if (region?.longitudeDelta) {
            const zoom = Math.log2(360 / region.longitudeDelta);
            if (Number.isFinite(zoom)) lastZoomRef.current = zoom;
          }
        }}
      >
        {markers}
        {/* Only rendered OUTSIDE nav mode. In nav mode the camera itself
            tracks the driver every fix, so a lat/lng Marker here would be
            reprojected over the JS bridge independently of the native
            camera animation — that mismatch is what caused the diagonal
            "off-road" drift. See the fixed overlay below for nav mode. */}
        {location && !isScanning && (
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

      {/* Course-up nav arrow: a screen-space overlay, NOT a map Marker. The
          camera is the single source of truth for both position (re-centered
          on the driver every fix) and rotation (bearing == heading), so this
          icon never moves or rotates itself — it just always points up, at a
          fixed screen spot. That removes the Marker/camera desync entirely. */}
      {isScanning && (
        <View
          pointerEvents="none"
          style={[styles.navArrowContainer, { top: `${NAV_ARROW_SCREEN_FRACTION * 100}%` }]}
        >
          <Ionicons name="navigate" size={34} color="#00D9C6" />
        </View>
      )}

      <Pressable style={styles.recenterButton} onPress={handleRecenter}>
        <Ionicons name="locate" size={22} color="#FFFFFF" />
      </Pressable>

      <Pressable style={styles.layersButton} onPress={toggleMapType}>
        <Ionicons name="layers-outline" size={22} color="#FFFFFF" />
      </Pressable>

      <Pressable style={styles.searchRadarsButton} onPress={() => setSearchModalVisible(true)}>
        <Ionicons name="search" size={22} color="#FFFFFF" />
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
        <Text style={styles.speedValue}>{isScanning ? Math.round(speedKmh) : '--'}</Text>
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
              <Image source={POI_ICON_IMAGES.radar} style={styles.modalOptionIcon} resizeMode="contain" />
              <Text style={styles.modalOptionText}>{isAr ? 'رادار' : 'Radar'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.bump }]}
              onPress={() => handleAddPoi('bump')}
            >
              <Image source={POI_ICON_IMAGES.bump} style={styles.modalOptionIcon} resizeMode="contain" />
              <Text style={styles.modalOptionText}>{isAr ? 'مطب صناعي' : 'Speed Bump'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.police }]}
              onPress={() => handleAddPoi('police')}
            >
              <Image source={POI_ICON_IMAGES.police} style={styles.modalOptionIcon} resizeMode="contain" />
              <Text style={styles.modalOptionText}>{isAr ? 'نقطة شرطة' : 'Police'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.roadwork }]}
              onPress={() => handleAddPoi('roadwork')}
            >
              <Image source={POI_ICON_IMAGES.roadwork} style={styles.modalOptionIcon} resizeMode="contain" />
              <Text style={styles.modalOptionText}>{isAr ? 'أعمال طريق' : 'Roadwork'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.traffic }]}
              onPress={() => handleAddPoi('traffic')}
            >
              <Image source={POI_ICON_IMAGES.traffic} style={styles.modalOptionIcon} resizeMode="contain" />
              <Text style={styles.modalOptionText}>{isAr ? 'زحمة مرور' : 'Traffic Jam'}</Text>
            </Pressable>

            <Pressable
              style={[styles.modalOption, { borderColor: PIN_COLORS.accident }]}
              onPress={() => handleAddPoi('accident')}
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
  navArrowContainer: {
    position: 'absolute',
    left: '50%',
    marginLeft: -17, // half of icon size (34), to horizontally center it
    marginTop: -17,  // half of icon size, to vertically center on `top`
    alignItems: 'center',
    justifyContent: 'center',
  },
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
