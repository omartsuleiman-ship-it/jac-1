import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View
} from 'react-native';
import { isConnected, sendOBDCommand } from '../services/bleService';
import { useLang } from './_layout';

const COLORS = {
  background: '#000000',
  card: '#050505',
  cardBorder: '#1A1A1A',
  accent: '#00D9C6',
  accentSoft: 'rgba(0, 217, 198, 0.12)',
  danger: '#FF6B5E',
  textPrimary: '#F5F6F7',
  textSecondary: '#8A9199',
  inputBg: '#0A0A0A',
  routeLine: '#00D9C6',
  destinationPin: '#FF6B5E',
  startPin: '#00E676',
};

const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';

// ── Eco Score: compares this trip's fuel consumption (L/100km) against a
// rough efficient-vs-poor range for the JAC S3 1.5L. 100 = at/below the
// efficient benchmark, 0 = at/above the poor benchmark, linear between.
// This is a relative heuristic for trip-to-trip comparison, not a
// manufacturer-calibrated "true" efficiency figure.
const ECO_L_PER_100KM_EXCELLENT = 6;
const ECO_L_PER_100KM_POOR = 12;

const calculateEcoScore = (distanceKm: number, fuelLiters: number): number | null => {
  if (distanceKm <= 0 || fuelLiters <= 0) return null; // trip too short / no OBD fuel data to score fairly
  const lPer100km = (fuelLiters / distanceKm) * 100;
  const range = ECO_L_PER_100KM_POOR - ECO_L_PER_100KM_EXCELLENT;
  const raw = 100 - ((lPer100km - ECO_L_PER_100KM_EXCELLENT) / range) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
};

export default function TripCostScreen() {
  const { isAr } = useLang();
  const dir = isAr ? 'row-reverse' : 'row';

  // ── Trip State ──
  const [tripActive, setTripActive] = useState(false);

  // ── Live OBD Data State ──
  const [distanceKm, setDistanceKm] = useState(0);
  const [fuelConsumedLiters, setFuelConsumedLiters] = useState(0);
  const [fuelPrice, setFuelPrice] = useState('22.25');
  const fuelPriceRef = useRef(22.25);
  useEffect(() => { fuelPriceRef.current = parseFloat(fuelPrice) || 0; }, [fuelPrice]);
  const [carDepreciation, setCarDepreciation] = useState('1');

  // ── End Trip Modal State ──
  const [endModalVisible, setEndModalVisible] = useState(false);
  const [extraCosts, setExtraCosts] = useState('');
  const [passengers, setPassengers] = useState('1');
  const [isCalculated, setIsCalculated] = useState(false);
  
  const [recentTrips, setRecentTrips] = useState<any[]>([]);
  const [showAllTrips, setShowAllTrips] = useState(false);

  // ── Load Crash Recovery & History on Mount ──
  useEffect(() => {
    const loadState = async () => {
      const history = await AsyncStorage.getItem('@recent_trips');
      if (history) setRecentTrips(JSON.parse(history));

      const active = await AsyncStorage.getItem('@trip_active');
      if (active === 'true') {
        const savedDist = await AsyncStorage.getItem('@trip_dist');
        const savedFuel = await AsyncStorage.getItem('@trip_fuel');
        if (savedDist) setDistanceKm(parseFloat(savedDist));
        if (savedFuel) setFuelConsumedLiters(parseFloat(savedFuel));
        setTripActive(true);
      }
    };
    loadState();
  }, []);

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
          setDistanceKm((prev) => {
            const newDist = prev + deltaKm;
            AsyncStorage.setItem('@trip_dist', newDist.toString()).catch(() => {});
            return newDist;
          });

          const deltaLiters = (mafGramsPerSec / 14.7 / 740) * secondsElapsed;
          setFuelConsumedLiters((prev) => {
            const newTotal = prev + deltaLiters;
            const liveCost = newTotal * fuelPriceRef.current;
            AsyncStorage.setItem('@live_trip_cost', liveCost.toFixed(2)).catch(() => {});
            AsyncStorage.setItem('@trip_fuel', newTotal.toString()).catch(() => {});
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

  // ── Calculations ──
  const fuelPriceNum = parseFloat(fuelPrice) || 0;
  const extraCostsNum = parseFloat(extraCosts) || 0;
  const wearTearCost = distanceKm * (parseFloat(carDepreciation) || 0);
  const fuelCost = fuelConsumedLiters * fuelPriceNum;

  const totalCost = fuelCost + extraCostsNum + wearTearCost;
  const passengersNum = Math.max(parseInt(passengers, 10) || 1, 1);
  const costPerPerson = totalCost / passengersNum;

 // ── Delete Trip Handler ──
  const handleDeleteTrip = (id: string) => {
    Alert.alert(
      isAr ? 'مسح الرحلة' : 'Delete Trip',
      isAr ? 'هل أنت متأكد من مسح هذه الرحلة من السجل؟' : 'Are you sure you want to delete this trip?',
      [
        { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
        {
          text: isAr ? 'مسح' : 'Delete',
          style: 'destructive',
          onPress: () => {
            const updated = recentTrips.filter(t => t.id !== id);
            setRecentTrips(updated);
            AsyncStorage.setItem('@recent_trips', JSON.stringify(updated)).catch(() => {});
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          
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

            <View style={[styles.miniConfigRow, { flexDirection: dir }]}>
              <Text style={styles.miniConfigLabel}>{isAr ? 'إهلاك السيارة:' : 'Car Depreciation:'}</Text>
              <TextInput 
                style={[styles.miniConfigInput, { textAlign: isAr ? 'right' : 'left' }]} 
                keyboardType="decimal-pad" 
                value={carDepreciation} 
                onChangeText={setCarDepreciation} 
              />
              <Text style={styles.miniConfigLabel}>{isAr ? 'جنيه/كم' : 'EGP/km'}</Text>
            </View>

            <View style={[styles.statsRow, { flexDirection: dir }]}>
              <StatBlock label={isAr ? 'المسافة' : 'Distance'} value={distanceKm.toFixed(1)} unit={isAr ? 'كم' : 'km'} />
              <StatBlock label={isAr ? 'الوقود المحترق' : 'Fuel Used'} value={fuelConsumedLiters.toFixed(2)} unit={isAr ? 'لتر' : 'L'} />
              <StatBlock label={isAr ? 'إجمالي البنزين' : 'Fuel Cost'} value={fuelCost.toFixed(2)} unit={isAr ? 'جنيه' : 'EGP'} />
            </View>
            
            <View style={[styles.wearTearNote, { flexDirection: dir }]}>
              <Ionicons name="build-outline" size={14} color={COLORS.textSecondary} />
              <Text style={[styles.wearTearNoteText, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? `إهلاك السيارة الكلي (${carDepreciation || 0} جنيه/كم): ${wearTearCost.toFixed(2)} جنيه` : `Total Wear & tear (${carDepreciation || 0} EGP/km): ${wearTearCost.toFixed(2)} EGP`}
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

         {/* ── RECENT TRIPS HISTORY ── */}
          {recentTrips.length > 0 && (
            <View style={[styles.card, { marginTop: 16 }]}>
              <Text style={[styles.cardHeader, { textAlign: isAr ? 'right' : 'left' }]}>
                {isAr ? 'سجل الرحلات (آخر 10)' : 'Trip History (Last 10)'}
              </Text>
              {recentTrips.slice(0, showAllTrips ? 10 : 3).map((trip) => (
                <View key={trip.id} style={{ borderBottomWidth: 1, borderBottomColor: COLORS.cardBorder, paddingVertical: 12 }}>
                  <View style={{ flexDirection: dir, justifyContent: 'space-between', marginBottom: 4, alignItems: 'center' }}>
                    <Text style={{ color: COLORS.textPrimary, fontSize: 14, fontWeight: '700', flex: 1, textAlign: isAr ? 'right' : 'left' }}>
                      {(typeof trip.distanceKm === 'number' ? trip.distanceKm.toFixed(1) : '0.0')} {isAr ? 'كم' : 'km'}
                    </Text>
                    <View style={{ flexDirection: dir, alignItems: 'center', gap: 12 }}>
                      <Text style={{ color: COLORS.accent, fontSize: 15, fontWeight: '800' }}>{trip.cost} {isAr ? 'ج' : 'EGP'}</Text>
                      <TouchableOpacity onPress={() => handleDeleteTrip(trip.id)} hitSlop={10}>
                        <Ionicons name="trash-outline" size={18} color={COLORS.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                  <Text style={{ color: COLORS.textSecondary, fontSize: 11, textAlign: isAr ? 'right' : 'left' }}>{trip.date}</Text>
                </View>
              ))}
              {recentTrips.length > 3 && (
                <TouchableOpacity style={styles.showMoreButton} onPress={() => setShowAllTrips((prev) => !prev)}>
                  <Text style={styles.showMoreButtonText}>
                    {showAllTrips ? (isAr ? 'عرض أقل' : 'Show Less') : (isAr ? 'المزيد' : 'Show More')}
                  </Text>
                  <Ionicons name={showAllTrips ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.accent} />
                </TouchableOpacity>
              )}
            </View>
          )}

        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── END TRIP MODAL ── */}
      <Modal visible={endModalVisible} animationType="slide" transparent={true}>
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <KeyboardAvoidingView 
            behavior={Platform.OS === 'ios' ? 'padding' : undefined} 
            style={styles.modalOverlay}
          >
            <TouchableWithoutFeedback onPress={() => {}}>
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
              <TouchableOpacity style={styles.calcButton} onPress={() => {
                setIsCalculated(true);
                const newTrip = {
                  id: Date.now().toString(),
                  date: new Date().toLocaleDateString('en-GB'),
                  cost: totalCost.toFixed(2),
                  distanceKm,
                  ecoScore: calculateEcoScore(distanceKm, fuelConsumedLiters),
                };
                const updated = [newTrip, ...recentTrips].slice(0, 10);
                setRecentTrips(updated);
                AsyncStorage.setItem('@recent_trips', JSON.stringify(updated)).catch(()=>{});
              }}>
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
            </TouchableWithoutFeedback>
          </KeyboardAvoidingView>
        </TouchableWithoutFeedback>
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

  showMoreButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.accentSoft, borderWidth: 1, borderColor: 'rgba(0, 217, 198, 0.3)' },
  showMoreButtonText: { color: COLORS.accent, fontSize: 13, fontWeight: '700' },
});