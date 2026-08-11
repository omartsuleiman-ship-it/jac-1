import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_DEFAULT, Region } from 'react-native-maps';
import { useLang } from './_layout'; // ── استدعاء اللغة العامة ──

const COLORS = {
  background: '#0B0D10',
  card: '#15181C',
  cardBorder: '#22262B',
  accent: '#00D9C6',
  accentSoft: 'rgba(0, 217, 198, 0.12)',
  danger: '#FF6B5E',
  textPrimary: '#F5F6F7',
  textSecondary: '#8A9199',
  inputBg: '#1B1F24',
  routeLine: '#00D9C6',
  destinationPin: '#FF6B5E',
  startPin: '#00E676',
};

type Coords = { latitude: number; longitude: number };
type Suggestion = { display_name: string; lat: string; lon: string };

const DEFAULT_REGION: Region = {
  latitude: 30.3071,
  longitude: 31.7423,
  latitudeDelta: 0.1,
  longitudeDelta: 0.1,
};

const OSRM_BASE_URL = 'http://router.project-osrm.org/route/v1/driving';

async function fetchOsrmRoute(from: Coords, to: Coords): Promise<Coords[]> {
  const url = `${OSRM_BASE_URL}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM request failed with status ${response.status}`);
  }
  const json = await response.json();
  if (json.code !== 'Ok' || !json.routes?.length) {
    throw new Error('OSRM could not find a route between these points');
  }
  const geoCoords: [number, number][] = json.routes[0].geometry.coordinates;
  return geoCoords.map(([longitude, latitude]) => ({ latitude, longitude }));
}

export default function TripCostScreen() {
  const { isAr } = useLang(); // ── جلب اللغة ──

  const mapRef = useRef<MapView | null>(null);
  const typingTimer = useRef<NodeJS.Timeout | null>(null);

  const [tripActive, setTripActive] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Coords | null>(null);
  
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [fromCoords, setFromCoords] = useState<Coords | null>(null);
  const [toCoords, setToCoords] = useState<Coords | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coords[]>([]);
  
  const [isRouting, setIsRouting] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeField, setActiveField] = useState<'from' | 'to' | null>(null);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);

  const [distanceKm, setDistanceKm] = useState(0);
  const [fuelConsumedLiters, setFuelConsumedLiters] = useState(0);
  const [fuelPrice, setFuelPrice] = useState('22.25');
  const [extraCosts, setExtraCosts] = useState('');
  const [passengers, setPassengers] = useState('1');

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationError(isAr ? 'تم رفض صلاحية الموقع.' : 'Location permission denied.');
        return;
      }
      const initial = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const initialCoords = { latitude: initial.coords.latitude, longitude: initial.coords.longitude };
      setCurrentLocation(initialCoords);
      
      if (!fromCoords && !toCoords) {
        mapRef.current?.animateToRegion({ ...initialCoords, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 500);
      }

      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 10 },
        (loc) => setCurrentLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude })
      );
    })();
    return () => { subscription?.remove(); };
  }, [isAr]);

  const onSearchTextChange = (text: string, field: 'from' | 'to') => {
    if (field === 'from') setFromText(text);
    else setToText(text);

    setActiveField(field);
    if (typingTimer.current) clearTimeout(typingTimer.current);

    if (text.length > 2) {
      setIsFetchingSuggestions(true);
      typingTimer.current = setTimeout(async () => {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(text)}&format=json&limit=4&countrycodes=eg`);
          const data = await res.json();
          setSuggestions(data);
        } catch (e) {
          console.error(e);
        } finally {
          setIsFetchingSuggestions(false);
        }
      }, 800);
    } else {
      setSuggestions([]);
      setIsFetchingSuggestions(false);
    }
  };

  const selectSuggestion = (item: Suggestion) => {
    const coords = { latitude: parseFloat(item.lat), longitude: parseFloat(item.lon) };
    if (activeField === 'from') {
      setFromText(item.display_name.split(',')[0]); 
      setFromCoords(coords);
    } else {
      setToText(item.display_name.split(',')[0]);
      setToCoords(coords);
    }
    setSuggestions([]);
    setActiveField(null);
  };

  const handleMapPress = async (e: { nativeEvent: { coordinate: Coords } }) => {
    const coords = e.nativeEvent.coordinate;
    setToCoords(coords);
    setToText(isAr ? 'جاري جلب العنوان...' : 'Fetching address...');
    
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${coords.latitude}&lon=${coords.longitude}&format=json`);
      const data = await res.json();
      if (data && data.display_name) {
        const shortAddress = data.display_name.split(',').slice(0, 2).join(',');
        setToText(shortAddress);
      } else {
        setToText(isAr ? 'تم التحديد من الخريطة' : 'Selected on Map');
      }
    } catch (error) {
      setToText(isAr ? 'تم التحديد من الخريطة' : 'Selected on Map');
    }
  };

  const handleSearchRoute = async () => {
    const startNode = fromCoords || currentLocation;
    
    if (!startNode || !toCoords) {
      Alert.alert(isAr ? 'بيانات ناقصة' : 'Missing Info', isAr ? 'برجاء تحديد نقطة البداية والنهاية.' : 'Please set both start and destination points.');
      return;
    }

    setIsRouting(true);
    try {
      const coords = await fetchOsrmRoute(startNode, toCoords);
      setRouteCoords(coords);
      mapRef.current?.fitToCoordinates([startNode, toCoords, ...coords], {
        edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
        animated: true,
      });
    } catch (err: any) {
      Alert.alert(isAr ? 'خطأ في المسار' : 'Route Error', err.message ?? (isAr ? 'لم يتم العثور على مسار.' : 'Could not fetch route.'));
      setRouteCoords([]);
    } finally {
      setIsRouting(false);
    }
  };

  const clearRoute = () => {
    setFromText('');
    setToText('');
    setFromCoords(null);
    setToCoords(null);
    setRouteCoords([]);
    setSuggestions([]);
    if (currentLocation) {
      mapRef.current?.animateToRegion({ ...currentLocation, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    }
  };

  const recenterMap = () => {
    if (currentLocation) {
      mapRef.current?.animateToRegion({ ...currentLocation, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    }
  };

  const fuelPriceNum = parseFloat(fuelPrice) || 0;
  const extraCostsNum = parseFloat(extraCosts) || 0;
  const wearTearCost = distanceKm * 1;
  const fuelCost = fuelConsumedLiters * fuelPriceNum;

  const totalCost = useMemo(() => fuelCost + extraCostsNum + wearTearCost, [fuelCost, extraCostsNum, wearTearCost]);
  const passengersNum = Math.max(parseInt(passengers, 10) || 1, 1);
  const costPerPerson = totalCost / passengersNum;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        
        {/* MAP */}
        <View style={styles.mapContainer}>
          <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFillObject}
            provider={PROVIDER_DEFAULT}
            mapType="satellite"
            initialRegion={DEFAULT_REGION}
            showsUserLocation={false}
            onPress={handleMapPress}
          >
            {currentLocation && (
              <Marker coordinate={currentLocation} anchor={{ x: 0.5, y: 0.5 }} title={isAr ? "سيارتك (مباشر)" : "Car (live)"}>
                <View style={styles.carMarker}>
                  <Ionicons name="car-sport" size={16} color="#0B0D10" />
                </View>
              </Marker>
            )}
            {fromCoords && <Marker coordinate={fromCoords} pinColor={COLORS.startPin} title={isAr ? "البداية" : "Start"} />}
            {toCoords && <Marker coordinate={toCoords} pinColor={COLORS.destinationPin} title={isAr ? "الوجهة" : "Destination"} />}
            {routeCoords.length > 0 && (
              <Polyline coordinates={routeCoords} strokeColor={COLORS.routeLine} strokeWidth={4} />
            )}
          </MapView>
          <TouchableOpacity style={styles.recenterButton} onPress={recenterMap}>
            <Ionicons name="locate" size={20} color={COLORS.textPrimary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          
          {/* ROUTING */}
          <View style={styles.card}>
            <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'تخطيط المسار' : 'Plan Route'}
            </Text>
            
            <TextInput
              style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]}
              placeholder={isAr ? 'من (اتركه فارغاً لاستخدام الـ GPS)' : 'From (Leave blank for current GPS)'}
              placeholderTextColor={COLORS.textSecondary}
              value={fromText}
              onChangeText={(t) => onSearchTextChange(t, 'from')}
            />
            
            {activeField === 'from' && suggestions.length > 0 && (
              <View style={styles.suggestionsContainer}>
                {suggestions.map((item, index) => (
                  <TouchableOpacity key={index} style={[styles.suggestionItem, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => selectSuggestion(item)}>
                    <Ionicons name="location-outline" size={16} color={COLORS.textSecondary} />
                    <Text style={[styles.suggestionText, { textAlign: isAr ? 'right' : 'left' }]} numberOfLines={2}>{item.display_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <TextInput
              style={[styles.input, { marginTop: 10, textAlign: isAr ? 'right' : 'left' }]}
              placeholder={isAr ? 'إلى (ابحث أو اضغط على الخريطة)' : 'To (Search or Tap on map)'}
              placeholderTextColor={COLORS.textSecondary}
              value={toText}
              onChangeText={(t) => onSearchTextChange(t, 'to')}
            />

            {activeField === 'to' && suggestions.length > 0 && (
              <View style={styles.suggestionsContainer}>
                {suggestions.map((item, index) => (
                  <TouchableOpacity key={index} style={[styles.suggestionItem, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => selectSuggestion(item)}>
                    <Ionicons name="location-outline" size={16} color={COLORS.textSecondary} />
                    <Text style={[styles.suggestionText, { textAlign: isAr ? 'right' : 'left' }]} numberOfLines={2}>{item.display_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {isFetchingSuggestions && (
               <Text style={[styles.fetchingText, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'جاري البحث...' : 'Searching...'}</Text>
            )}

            <View style={[styles.routeActionRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <TouchableOpacity style={[styles.searchRouteButton, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={handleSearchRoute} disabled={isRouting}>
                {isRouting ? (
                  <ActivityIndicator size="small" color="#0B0D10" />
                ) : (
                  <>
                    <Ionicons name="git-network-outline" size={16} color="#0B0D10" />
                    <Text style={styles.searchRouteButtonText}>{isAr ? 'رسم المسار' : 'Draw Route'}</Text>
                  </>
                )}
              </TouchableOpacity>
              {(fromCoords || toCoords) && (
                <TouchableOpacity style={styles.clearRouteButton} onPress={clearRoute}>
                  <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* LIVE DATA */}
          <View style={styles.card}>
            <View style={[styles.cardHeaderRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <Ionicons name="speedometer-outline" size={18} color={COLORS.accent} />
              <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? 'بيانات الرحلة المباشرة' : 'Live Trip Data'}
              </Text>
              <View style={[styles.statusDot, { backgroundColor: tripActive ? COLORS.accent : COLORS.textSecondary }]} />
            </View>
            <View style={[styles.statsRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <StatBlock label={isAr ? 'المسافة' : 'Distance'} value={distanceKm.toFixed(1)} unit={isAr ? 'كم' : 'km'} />
              <StatBlock label={isAr ? 'الوقود (MAF)' : 'Fuel (MAF)'} value={fuelConsumedLiters.toFixed(2)} unit={isAr ? 'لتر' : 'L'} />
              <StatBlock label={isAr ? 'تكلفة الوقود' : 'Fuel Cost'} value={fuelCost.toFixed(2)} unit={isAr ? 'جنيه' : 'EGP'} />
            </View>
          </View>

          {/* COST INPUTS */}
          <View style={styles.card}>
            <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'مدخلات التكلفة' : 'Cost Inputs'}
            </Text>
            <View style={[styles.inputRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <Ionicons name="water-outline" size={20} color={COLORS.textSecondary} style={styles.inputIcon} />
              <View style={styles.inputFlex}>
                <Text style={[styles.inputLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'سعر لتر البنزين (جنيه)' : 'Fuel Price per Liter (EGP)'}</Text>
                <TextInput style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]} keyboardType="decimal-pad" value={fuelPrice} onChangeText={setFuelPrice} />
              </View>
            </View>
            <View style={[styles.inputRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <Ionicons name="cash-outline" size={20} color={COLORS.textSecondary} style={styles.inputIcon} />
              <View style={styles.inputFlex}>
                <Text style={[styles.inputLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'تكاليف إضافية (جنيه)' : 'Extra Costs (EGP)'}</Text>
                <TextInput style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]} placeholder={isAr ? 'كارتة، ركنة، إلخ' : 'Tolls, parking, etc.'} placeholderTextColor={COLORS.textSecondary} keyboardType="decimal-pad" value={extraCosts} onChangeText={setExtraCosts} />
              </View>
            </View>
            <View style={[styles.inputRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <Ionicons name="people-outline" size={20} color={COLORS.textSecondary} style={styles.inputIcon} />
              <View style={styles.inputFlex}>
                <Text style={[styles.inputLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'عدد الركاب' : 'Number of Passengers'}</Text>
                <TextInput style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]} placeholder="1" placeholderTextColor={COLORS.textSecondary} keyboardType="number-pad" value={passengers} onChangeText={setPassengers} />
              </View>
            </View>
            <View style={[styles.wearTearNote, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
              <Ionicons name="build-outline" size={14} color={COLORS.textSecondary} />
              <Text style={[styles.wearTearNoteText, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? `تم إضافة إهلاك السيارة (١ جنيه/كم): ${wearTearCost.toFixed(2)} جنيه` : `Wear & tear (1 EGP/km) is included: ${wearTearCost.toFixed(2)} EGP`}
              </Text>
            </View>
          </View>

          {/* FINAL COST */}
          <View style={styles.finalCard}>
            <Text style={styles.finalLabel}>{isAr ? 'التكلفة النهائية للفرد' : 'Final Cost Per Person'}</Text>
            <Text style={styles.finalValue}>{costPerPerson.toFixed(2)} {isAr ? 'جنيه' : 'EGP'}</Text>
            <Text style={styles.finalSubtext}>
              {isAr 
                ? `إجمالي الرحلة: ${totalCost.toFixed(2)} جنيه ÷ ${passengersNum} ${passengersNum === 1 ? 'شخص' : 'أشخاص'}` 
                : `Total trip: ${totalCost.toFixed(2)} EGP ÷ ${passengersNum} ${passengersNum === 1 ? 'person' : 'people'}`}
            </Text>
          </View>

          {/* ACTIONS */}
          <View style={[styles.buttonRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
            <TouchableOpacity style={[styles.actionButton, styles.startButton, tripActive && styles.disabledButton, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => setTripActive(true)} disabled={tripActive}>
              <Ionicons name="play" size={18} color={tripActive ? COLORS.textSecondary : '#0B0D10'} />
              <Text style={[styles.actionButtonText, { color: tripActive ? COLORS.textSecondary : '#0B0D10' }]}>
                {isAr ? 'بدء الرحلة' : 'Start Trip'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, styles.endButton, !tripActive && styles.disabledButton, { flexDirection: isAr ? 'row-reverse' : 'row' }]} onPress={() => setTripActive(false)} disabled={!tripActive}>
              <Ionicons name="stop" size={18} color={!tripActive ? COLORS.textSecondary : '#FFFFFF'} />
              <Text style={[styles.actionButtonText, { color: !tripActive ? COLORS.textSecondary : '#FFFFFF' }]}>
                {isAr ? 'إنهاء الرحلة' : 'End Trip'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StatBlock({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={styles.statBlock}>
      <Text style={styles.statValue}>{value} <Text style={styles.statUnit}>{unit}</Text></Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  mapContainer: { height: '42%', width: '100%', backgroundColor: COLORS.card, overflow: 'hidden' },
  carMarker: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#0B0D10' },
  recenterButton: { position: 'absolute', bottom: 12, right: 12, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(21,24,28,0.9)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.cardBorder },
  container: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: COLORS.card, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: COLORS.cardBorder },
  cardHeaderRow: { alignItems: 'center', marginBottom: 14, gap: 8 },
  cardHeader: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '700', flex: 1, marginBottom: 10 },
  routeActionRow: { marginTop: 12, gap: 10 },
  searchRouteButton: { flex: 1, backgroundColor: COLORS.accent, paddingVertical: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 6 },
  searchRouteButtonText: { color: '#0B0D10', fontWeight: 'bold', fontSize: 14 },
  clearRouteButton: { backgroundColor: COLORS.inputBg, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.cardBorder },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statsRow: { justifyContent: 'space-between' },
  statBlock: { flex: 1, alignItems: 'center' },
  statValue: { color: COLORS.accent, fontSize: 18, fontWeight: '800' },
  statUnit: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  statLabel: { color: COLORS.textSecondary, fontSize: 11, marginTop: 4, fontWeight: '500' },
  inputRow: { alignItems: 'center', marginBottom: 14 },
  inputIcon: { marginHorizontal: 10 },
  inputFlex: { flex: 1 },
  inputLabel: { color: COLORS.textSecondary, fontSize: 12, marginBottom: 6, fontWeight: '500' },
  input: { backgroundColor: COLORS.inputBg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: COLORS.textPrimary, fontSize: 15, borderWidth: 1, borderColor: COLORS.cardBorder },
  suggestionsContainer: { backgroundColor: '#1A1D21', borderRadius: 8, marginTop: 4, padding: 8, borderWidth: 1, borderColor: COLORS.cardBorder },
  suggestionItem: { alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#2A2E35', gap: 8 },
  suggestionText: { color: COLORS.textPrimary, fontSize: 13, flex: 1 },
  fetchingText: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  wearTearNote: { alignItems: 'center', gap: 6, marginTop: 2, paddingTop: 12, borderTopWidth: 1, borderTopColor: COLORS.cardBorder },
  wearTearNoteText: { color: COLORS.textSecondary, fontSize: 12, flexShrink: 1 },
  finalCard: { backgroundColor: COLORS.accentSoft, borderRadius: 16, padding: 22, alignItems: 'center', marginBottom: 16, borderWidth: 1, borderColor: COLORS.accent },
  finalLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  finalValue: { color: COLORS.accent, fontSize: 36, fontWeight: '900' },
  finalSubtext: { color: COLORS.textSecondary, fontSize: 12, marginTop: 6 },
  buttonRow: { gap: 12 },
  actionButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12 },
  startButton: { backgroundColor: COLORS.accent },
  endButton: { backgroundColor: COLORS.danger },
  disabledButton: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.cardBorder },
  actionButtonText: { fontSize: 15, fontWeight: '700' },
});