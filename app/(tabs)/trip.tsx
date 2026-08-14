import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
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
import { isConnected, sendOBDCommand } from '../services/bleService';
import { useLang } from './_layout';

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

const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';
const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';

// ── OSRM Route Fetcher (Modified to return distance) ──
async function fetchOsrmRoute(from: Coords, to: Coords): Promise<{coords: Coords[], distanceKm: number}> {
  const url = `${OSRM_BASE_URL}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`OSRM request failed with status ${response.status}`);
  
  const json = await response.json();
  if (json.code !== 'Ok' || !json.routes?.length) {
    throw new Error('OSRM could not find a route between these points');
  }
  const distanceKm = json.routes[0].distance / 1000; // Distance in km
  const geoCoords: [number, number][] = json.routes[0].geometry.coordinates;
  const coords = geoCoords.map(([longitude, latitude]) => ({ latitude, longitude }));
  return { coords, distanceKm };
}

export default function TripCostScreen() {
  const { isAr } = useLang();
  const dir = isAr ? 'row-reverse' : 'row';

  const mapRef = useRef<MapView | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Trip State ──
  const [tripActive, setTripActive] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<Coords | null>(null);
  
  // ── Map State ──
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [fromCoords, setFromCoords] = useState<Coords | null>(null);
  const [toCoords, setToCoords] = useState<Coords | null>(null);
  const [routeCoords, setRouteCoords] = useState<Coords[]>([]);
  const [routeDistanceKm, setRouteDistanceKm] = useState<number | null>(null);
  
  const [isRouting, setIsRouting] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeField, setActiveField] = useState<'from' | 'to' | null>(null);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);

  // ── Live OBD Data State ──
  const [distanceKm, setDistanceKm] = useState(0);
  const [fuelConsumedLiters, setFuelConsumedLiters] = useState(0);
  const [fuelPrice, setFuelPrice] = useState('22.25');
  const fuelPriceRef = useRef(22.25);
  useEffect(() => { fuelPriceRef.current = parseFloat(fuelPrice) || 0; }, [fuelPrice]);

  // ── End Trip Modal State ──
  const [endModalVisible, setEndModalVisible] = useState(false);
  const [extraCosts, setExtraCosts] = useState('');
  const [passengers, setPassengers] = useState('1');
  const [isCalculated, setIsCalculated] = useState(false);

  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      
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

  // ── OBD Polling ──
  const lastPollRef = useRef<number | null>(null);
  const tripOdometerDeltaRef = useRef(0);

  const parseSpeedKmh = (response: string): number => {
    const hex = response.replace(/\s/g, '').toUpperCase();
    const idx = hex.indexOf('410D');
    if (idx === -1) return 0;
    const value = parseInt(hex.substring(idx + 4, idx + 6), 16);
    return isNaN(value) ? 0 : value;
  };

  const parseMafGramsPerSec = (response: string): number => {
    const hex = response.replace(/\s/g, '').toUpperCase();
    const idx = hex.indexOf('4110');
    if (idx === -1) return 0;
    const bytes = (hex.substring(idx + 4, idx + 8).match(/.{1,2}/g) || []) as string[];
    if (bytes.length < 2) return 0;
    const value = ((parseInt(bytes[0], 16) * 256) + parseInt(bytes[1], 16)) / 100;
    return isNaN(value) ? 0 : value;
  };

  useEffect(() => {
    if (!tripActive) {
      lastPollRef.current = null;
      return;
    }

    const parseHexBytes = (hexStr: string, header: string) => {
      const clean = hexStr.replace(/\s/g, '').toUpperCase();
      const idx = clean.indexOf(header);
      if (idx === -1) return [];
      const match = (clean.substring(idx + header.length).match(/.{1,2}/g) || []) as string[];
      return match.map(b => parseInt(b, 16));
    };

    const poll = setInterval(async () => {
      if (!isConnected()) return;
      try {
        const speedResponse = await sendOBDCommand('010D');
        const speedKmh = parseSpeedKmh(speedResponse);
        
        let mafGramsPerSec = 0;
        const mafResponse = await sendOBDCommand('0110');
        mafGramsPerSec = parseMafGramsPerSec(mafResponse);

        if (mafGramsPerSec === 0) {
           const rpmRes = await sendOBDCommand('010C');
           const mapRes = await sendOBDCommand('010B');
           const iatRes = await sendOBDCommand('010F');

           const rpmData = parseHexBytes(rpmRes, '410C');
           const mapData = parseHexBytes(mapRes, '410B');
           const iatData = parseHexBytes(iatRes, '410F');

           const rpm = rpmData.length >= 2 ? ((rpmData[0] * 256) + rpmData[1]) / 4 : 0;
           const map = mapData.length >= 1 ? mapData[0] : 0;
           const iat = iatData.length >= 1 ? iatData[0] - 40 : 40; 

           if (rpm > 0 && map > 0) {
              const iatKelvin = iat + 273.15;
              const imap = (rpm * map) / 120;
              mafGramsPerSec = imap * 0.80 * 1.499 * (28.97 / (8.314 * iatKelvin));
           }
        }

        const now = Date.now();
        if (lastPollRef.current) {
          const secondsElapsed = (now - lastPollRef.current) / 1000;
          const hoursElapsed = secondsElapsed / 3600;

          const deltaKm = speedKmh * hoursElapsed;
          tripOdometerDeltaRef.current += deltaKm;
          setDistanceKm((prev) => prev + deltaKm);

          const deltaLiters = (mafGramsPerSec / 14.7 / 740) * secondsElapsed;
          setFuelConsumedLiters((prev) => {
            const newTotal = prev + deltaLiters;
            const liveCost = newTotal * fuelPriceRef.current;
            AsyncStorage.setItem('@live_trip_cost', liveCost.toFixed(2)).catch(() => {});
            return newTotal;
          });
        }
        lastPollRef.current = now;
      } catch (error) {
        console.warn('OBD trip poll failed:', error);
      }
    }, 2500); 
    return () => clearInterval(poll);
  }, [tripActive]);

  // ── Actions ──
  const handleStartTrip = async () => {
    setDistanceKm(0);
    setFuelConsumedLiters(0);
    setExtraCosts('');
    setPassengers('1');
    setIsCalculated(false);
    tripOdometerDeltaRef.current = 0;
    lastPollRef.current = null;
    setTripActive(true);
    await AsyncStorage.setItem('@trip_active', 'true');
    await AsyncStorage.setItem('@live_trip_cost', '0.00');
  };

  const handleEndTrip = async () => {
    setTripActive(false);
    setEndModalVisible(true); // Open the summary & calculation modal
    try {
      await AsyncStorage.setItem('@trip_active', 'false');
      const stored = await AsyncStorage.getItem(STORAGE_KEY_ODOMETER);
      const currentOdometer = stored ? JSON.parse(stored) : 0;
      const updatedOdometer = currentOdometer + tripOdometerDeltaRef.current;
      await AsyncStorage.setItem(STORAGE_KEY_ODOMETER, JSON.stringify(updatedOdometer));
    } catch (error) {
      console.warn('Failed to persist odometer:', error);
    }
  };

  // ── Routing Logic ──
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
      const { coords, distanceKm } = await fetchOsrmRoute(startNode, toCoords);
      setRouteCoords(coords);
      setRouteDistanceKm(distanceKm);
      mapRef.current?.fitToCoordinates([startNode, toCoords, ...coords], {
        edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
        animated: true,
      });
    } catch (err: any) {
      Alert.alert(isAr ? 'خطأ في المسار' : 'Route Error', err.message ?? 'Could not fetch route.');
      setRouteCoords([]);
      setRouteDistanceKm(null);
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
    setRouteDistanceKm(null);
    setSuggestions([]);
    if (currentLocation) {
      mapRef.current?.animateToRegion({ ...currentLocation, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    }
  };

  // ── Calculations ──
  const fuelPriceNum = parseFloat(fuelPrice) || 0;
  const extraCostsNum = parseFloat(extraCosts) || 0;
  const wearTearCost = distanceKm * 1; 
  const fuelCost = fuelConsumedLiters * fuelPriceNum;

  const totalCost = fuelCost + extraCostsNum + wearTearCost;
  const passengersNum = Math.max(parseInt(passengers, 10) || 1, 1);
  const costPerPerson = totalCost / passengersNum;

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        
        {/* ── MAP ── */}
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
          <TouchableOpacity style={styles.recenterButton} onPress={() => {
            if (currentLocation) mapRef.current?.animateToRegion({ ...currentLocation, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
          }}>
            <Ionicons name="locate" size={20} color={COLORS.textPrimary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          
          {/* ── ROUTING CARD ── */}
          <View style={styles.card}>
            <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'تخطيط المسار' : 'Plan Route'}
            </Text>
            
            <TextInput
              style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]}
              placeholder={isAr ? 'من (اتركه فارغاً لاستخدام الـ GPS)' : 'From (Leave blank for GPS)'}
              placeholderTextColor={COLORS.textSecondary}
              value={fromText}
              onChangeText={(t) => onSearchTextChange(t, 'from')}
            />
            {activeField === 'from' && suggestions.length > 0 && (
              <View style={styles.suggestionsContainer}>
                {suggestions.map((item, index) => (
                  <TouchableOpacity key={index} style={[styles.suggestionItem, { flexDirection: dir }]} onPress={() => selectSuggestion(item)}>
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
                  <TouchableOpacity key={index} style={[styles.suggestionItem, { flexDirection: dir }]} onPress={() => selectSuggestion(item)}>
                    <Ionicons name="location-outline" size={16} color={COLORS.textSecondary} />
                    <Text style={[styles.suggestionText, { textAlign: isAr ? 'right' : 'left' }]} numberOfLines={2}>{item.display_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {isFetchingSuggestions && (
               <Text style={[styles.fetchingText, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'جاري البحث...' : 'Searching...'}</Text>
            )}

            <View style={[styles.routeActionRow, { flexDirection: dir }]}>
              <TouchableOpacity style={[styles.searchRouteButton, { flexDirection: dir }]} onPress={handleSearchRoute} disabled={isRouting}>
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

            {/* ── Theoretical Distance Pill ── */}
            {routeDistanceKm !== null && (
              <View style={[styles.distancePill, { flexDirection: dir }]}>
                <Ionicons name="map-outline" size={18} color={COLORS.accent} />
                <Text style={styles.distancePillText}>
                  {isAr ? `المسافة النظرية للمسار: ${routeDistanceKm.toFixed(1)} كم` : `Estimated Route Distance: ${routeDistanceKm.toFixed(1)} km`}
                </Text>
              </View>
            )}
          </View>

          {/* ── LIVE DATA CARD ── */}
          <View style={styles.card}>
            <View style={[styles.cardHeaderRow, { flexDirection: dir }]}>
              <Ionicons name="speedometer-outline" size={18} color={COLORS.accent} />
              <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? 'إجمالي الرحلة المباشرة' : 'Live Trip Totals'}
              </Text>
              <View style={[styles.statusDot, { backgroundColor: tripActive ? COLORS.accent : COLORS.textSecondary }]} />
            </View>

            {/* Small Fuel Price config */}
            <View style={[styles.miniConfigRow, { flexDirection: dir }]}>
              <Text style={styles.miniConfigLabel}>{isAr ? 'سعر لتر الوقود للحساب:' : 'Fuel Price:'}</Text>
              <TextInput 
                style={[styles.miniConfigInput, { textAlign: isAr ? 'right' : 'left' }]} 
                keyboardType="decimal-pad" 
                value={fuelPrice} 
                onChangeText={setFuelPrice} 
              />
              <Text style={styles.miniConfigLabel}>{isAr ? 'جنيه' : 'EGP'}</Text>
            </View>

            <View style={[styles.statsRow, { flexDirection: dir }]}>
              <StatBlock label={isAr ? 'المسافة' : 'Distance'} value={distanceKm.toFixed(1)} unit={isAr ? 'كم' : 'km'} />
              <StatBlock label={isAr ? 'الوقود المحترق' : 'Fuel Used'} value={fuelConsumedLiters.toFixed(2)} unit={isAr ? 'لتر' : 'L'} />
              <StatBlock label={isAr ? 'إجمالي البنزين' : 'Fuel Cost'} value={fuelCost.toFixed(2)} unit={isAr ? 'جنيه' : 'EGP'} />
            </View>
            
            <View style={[styles.wearTearNote, { flexDirection: dir }]}>
              <Ionicons name="build-outline" size={14} color={COLORS.textSecondary} />
              <Text style={[styles.wearTearNoteText, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? `إهلاك السيارة الكلي (١ جنيه/كم): ${wearTearCost.toFixed(2)} جنيه` : `Total Wear & tear (1 EGP/km): ${wearTearCost.toFixed(2)} EGP`}
              </Text>
            </View>
          </View>

          {/* ── ACTIONS ── */}
          <View style={[styles.buttonRow, { flexDirection: dir }]}>
            <TouchableOpacity style={[styles.actionButton, styles.startButton, tripActive && styles.disabledButton, { flexDirection: dir }]} onPress={handleStartTrip} disabled={tripActive}>
              <Ionicons name="play" size={18} color={tripActive ? COLORS.textSecondary : '#0B0D10'} />
              <Text style={[styles.actionButtonText, { color: tripActive ? COLORS.textSecondary : '#0B0D10' }]}>
                {isAr ? 'بدء الرحلة' : 'Start Trip'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, styles.endButton, !tripActive && styles.disabledButton, { flexDirection: dir }]} onPress={handleEndTrip} disabled={!tripActive}>
              <Ionicons name="stop" size={18} color={!tripActive ? COLORS.textSecondary : '#FFFFFF'} />
              <Text style={[styles.actionButtonText, { color: !tripActive ? COLORS.textSecondary : '#FFFFFF' }]}>
                {isAr ? 'إنهاء الرحلة' : 'End Trip'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── END TRIP MODAL ── */}
      <Modal visible={endModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHandle} />
            <Text style={[styles.modalTitle, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'ملخص وحساب الرحلة' : 'Trip Summary & Calculation'}
            </Text>
            
            {/* Totals Summary */}
            <View style={styles.summaryBox}>
              <View style={[styles.summaryRow, { flexDirection: dir }]}>
                <Text style={styles.summaryLabel}>{isAr ? 'تكلفة البنزين الكلية:' : 'Total Fuel Cost:'}</Text>
                <Text style={styles.summaryValue}>{fuelCost.toFixed(2)} {isAr ? 'جنيه' : 'EGP'}</Text>
              </View>
              <View style={[styles.summaryRow, { flexDirection: dir }]}>
                <Text style={styles.summaryLabel}>{isAr ? 'إهلاك السيارة الكلي:' : 'Total Wear & Tear:'}</Text>
                <Text style={styles.summaryValue}>{wearTearCost.toFixed(2)} {isAr ? 'جنيه' : 'EGP'}</Text>
              </View>
            </View>

            {/* Inputs */}
            <Text style={[styles.inputLabel, { textAlign: isAr ? 'right' : 'left', marginTop: 16 }]}>{isAr ? 'مصاريف إضافية (كارتة، ركنة):' : 'Extra Costs (Tolls, Parking):'}</Text>
            <TextInput 
              style={[styles.input, { textAlign: isAr ? 'right' : 'left', marginBottom: 12 }]} 
              keyboardType="decimal-pad" 
              placeholder="0"
              placeholderTextColor={COLORS.textSecondary}
              value={extraCosts} 
              onChangeText={(val) => { setExtraCosts(val); setIsCalculated(false); }} 
            />

            <Text style={[styles.inputLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? 'عدد الركاب:' : 'Number of Passengers:'}</Text>
            <TextInput 
              style={[styles.input, { textAlign: isAr ? 'right' : 'left', marginBottom: 20 }]} 
              keyboardType="number-pad" 
              placeholder="1"
              placeholderTextColor={COLORS.textSecondary}
              value={passengers} 
              onChangeText={(val) => { setPassengers(val); setIsCalculated(false); }} 
            />

            {/* Calculate Button or Result */}
            {!isCalculated ? (
              <TouchableOpacity style={styles.calcButton} onPress={() => setIsCalculated(true)}>
                <Text style={styles.calcButtonText}>{isAr ? 'حساب التكلفة للفرد' : 'Calculate Per Person'}</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.finalCostBox}>
                <Text style={styles.finalCostLabel}>{isAr ? 'التكلفة النهائية للفرد' : 'Final Cost Per Person'}</Text>
                <Text style={styles.finalCostValue}>{costPerPerson.toFixed(2)} {isAr ? 'جنيه' : 'EGP'}</Text>
                <Text style={styles.finalCostSub}>
                  {isAr 
                    ? `الإجمالي ${totalCost.toFixed(2)} جنيه ÷ ${passengersNum} ${passengersNum === 1 ? 'شخص' : 'أشخاص'}` 
                    : `Total ${totalCost.toFixed(2)} EGP ÷ ${passengersNum} ${passengersNum === 1 ? 'person' : 'people'}`}
                </Text>
              </View>
            )}

            <TouchableOpacity style={styles.closeModalBtn} onPress={() => setEndModalVisible(false)}>
              <Text style={styles.closeModalText}>{isAr ? 'إغلاق' : 'Close'}</Text>
            </TouchableOpacity>

          </View>
        </View>
      </Modal>

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
  
  distancePill: { marginTop: 14, backgroundColor: 'rgba(0, 217, 198, 0.1)', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, alignItems: 'center', gap: 8, borderWidth: 1, borderColor: 'rgba(0, 217, 198, 0.2)' },
  distancePillText: { color: COLORS.accent, fontSize: 14, fontWeight: '700' },

  statusDot: { width: 8, height: 8, borderRadius: 4 },
  miniConfigRow: { alignItems: 'center', gap: 8, backgroundColor: COLORS.inputBg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, alignSelf: 'flex-start', marginBottom: 16 },
  miniConfigLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  miniConfigInput: { color: COLORS.textPrimary, fontSize: 14, fontWeight: 'bold', borderBottomWidth: 1, borderBottomColor: COLORS.cardBorder, minWidth: 40, padding: 0 },
  
  statsRow: { justifyContent: 'space-between' },
  statBlock: { flex: 1, alignItems: 'center' },
  statValue: { color: COLORS.accent, fontSize: 18, fontWeight: '800' },
  statUnit: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  statLabel: { color: COLORS.textSecondary, fontSize: 11, marginTop: 4, fontWeight: '500' },
  inputRow: { alignItems: 'center', marginBottom: 14 },
  inputIcon: { marginHorizontal: 10 },
  inputFlex: { flex: 1 },
  inputLabel: { color: COLORS.textSecondary, fontSize: 13, marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: COLORS.inputBg, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: COLORS.textPrimary, fontSize: 15, borderWidth: 1, borderColor: COLORS.cardBorder },
  suggestionsContainer: { backgroundColor: '#1A1D21', borderRadius: 8, marginTop: 4, padding: 8, borderWidth: 1, borderColor: COLORS.cardBorder },
  suggestionItem: { alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#2A2E35', gap: 8 },
  suggestionText: { color: COLORS.textPrimary, fontSize: 13, flex: 1 },
  fetchingText: { color: COLORS.textSecondary, fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  wearTearNote: { alignItems: 'center', gap: 6, marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: COLORS.cardBorder },
  wearTearNoteText: { color: COLORS.textSecondary, fontSize: 12, flexShrink: 1 },
  
  buttonRow: { gap: 12 },
  actionButton: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 12 },
  startButton: { backgroundColor: COLORS.accent },
  endButton: { backgroundColor: COLORS.danger },
  disabledButton: { backgroundColor: COLORS.card, borderWidth: 1, borderColor: COLORS.cardBorder },
  actionButtonText: { fontSize: 15, fontWeight: '700' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: COLORS.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalHandle: { width: 40, height: 4, backgroundColor: COLORS.cardBorder, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  modalTitle: { color: COLORS.textPrimary, fontSize: 18, fontWeight: '900', marginBottom: 16 },
  summaryBox: { backgroundColor: COLORS.inputBg, padding: 16, borderRadius: 12, gap: 12, borderWidth: 1, borderColor: COLORS.cardBorder },
  summaryRow: { justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },
  summaryValue: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '800' },
  
  calcButton: { backgroundColor: COLORS.accent, paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  calcButtonText: { color: '#0B0D10', fontSize: 15, fontWeight: 'bold' },
  
  finalCostBox: { backgroundColor: 'rgba(0, 217, 198, 0.1)', padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 10, borderWidth: 1, borderColor: 'rgba(0, 217, 198, 0.3)' },
  finalCostLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 },
  finalCostValue: { color: COLORS.accent, fontSize: 32, fontWeight: '900' },
  finalCostSub: { color: COLORS.textSecondary, fontSize: 11, marginTop: 4 },
  
  closeModalBtn: { marginTop: 16, paddingVertical: 12, alignItems: 'center' },
  closeModalText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '600' },
});