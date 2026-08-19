// diagnostics.tsx
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { DTC_DATABASE, DTCRecord, URGENCY_META, UrgencyLevel } from '../constants/dtc_dictionary';
import { getEngineDTCs, getExtraSafetyData, getLiveData, getMisfireCounters, getReadiness, getTransmissionDTCs, isConnected, LiveDataKey, SafetyDataKey } from '../services/bleService';
import { fetchDTCFromAI } from '../services/groqDtcService';
import { useLang } from './_layout';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// Android needs this opt-in for LayoutAnimation to work at all (iOS doesn't)
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// -----------------------------------------------------------------------------
// Constants & Types
// -----------------------------------------------------------------------------
const COLORS = {
  background: '#0B0D10',
  card: '#15181C',
  cardAlt: '#181C21',
  cardBorder: '#22262B',
  glassBorder: 'rgba(255,255,255,0.08)',
  accent: '#00D9C6',
  accentDim: 'rgba(0, 217, 198, 0.12)',
  danger: '#FF6B5E',
  dangerDim: 'rgba(255, 107, 94, 0.12)',
  warning: '#F2C94C',
  warningDim: 'rgba(242, 201, 76, 0.12)',
  success: '#00E676',
  successDim: 'rgba(0, 230, 118, 0.10)',
  textPrimary: '#F5F6F7',
  textSecondary: '#8A9199',
  textTertiary: '#5B6169',
  inputBg: '#1B1F24',
  overlay: 'rgba(0,0,0,0.72)',
};

const urgencyColor = (tone: 'danger' | 'warning' | 'accent' | 'success') =>
  tone === 'danger' ? COLORS.danger : tone === 'warning' ? COLORS.warning : tone === 'success' ? COLORS.success : COLORS.accent;
const urgencyDim = (tone: 'danger' | 'warning' | 'accent' | 'success') =>
  tone === 'danger' ? COLORS.dangerDim : tone === 'warning' ? COLORS.warningDim : tone === 'success' ? COLORS.successDim : COLORS.accentDim;

// -----------------------------------------------------------------------------
// Live Data thresholds
// -----------------------------------------------------------------------------
type CardStatus = { tone: 'success' | 'warning' | 'danger'; statusEn: string; statusAr: string };

const getVoltageStatus = (v: number | null): CardStatus => {
  if (v === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (v < 11.5 || v > 15.0) return { tone: 'danger', statusEn: 'Danger', statusAr: 'خطر' };
  if (v >= 11.5 && v < 13.3) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getCoolantStatus = (c: number | null): CardStatus => {
  if (c === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (c > 115) return { tone: 'danger', statusEn: 'Danger', statusAr: 'خطر' };
  if (c >= 106 && c <= 115) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getRpmStatus = (rpm: number | null): CardStatus => {
  if (rpm === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (rpm > 6000) return { tone: 'danger', statusEn: 'Danger', statusAr: 'خطر' };
  if (rpm > 4000 && rpm <= 6000) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getMafStatus = (maf: number | null): CardStatus => {
  if (maf === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (maf === 0) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getO2Status = (o2: number | null): CardStatus => {
  if (o2 === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (o2 <= 0.05 || o2 >= 0.95) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getFuelTrimStatus = (ft: number | null): CardStatus => {
  if (ft === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  const abs = Math.abs(ft);
  if (abs > 10) return { tone: 'danger', statusEn: 'Danger', statusAr: 'خطر' };
  if (abs > 5 && abs <= 10) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

const getEngineLoadStatus = (load: number | null): CardStatus => {
  if (load === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (load > 85) return { tone: 'warning', statusEn: 'High', statusAr: 'مرتفع' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

// --- NEW Extra Safety Data Thresholds ---
const getAtfTempStatus = (temp: number | null): CardStatus => {
  if (temp === null) return { tone: 'warning', statusEn: '--', statusAr: '--' };
  if (temp > 110) return { tone: 'danger', statusEn: 'Danger', statusAr: 'خطر' };
  if (temp > 90 && temp <= 110) return { tone: 'warning', statusEn: 'Check', statusAr: 'فحص' };
  return { tone: 'success', statusEn: 'Normal', statusAr: 'طبيعي' };
};

// ABS and Tire Pressure status helpers removed: raw terminal testing showed
// this ELM327 cannot reach those ECUs (NO DATA / timeouts on 7B0 and 7A0).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Selective Live Data — parameter catalogue for the pick-and-choose dashboard
// -----------------------------------------------------------------------------
type LiveParamId = LiveDataKey | SafetyDataKey;

type LiveParamMeta = {
  id: LiveParamId;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  labelEn: string;
  labelAr: string;
  category: 'engine' | 'safety';
};

const LIVE_PARAMS: LiveParamMeta[] = [
  { id: 'rpm', icon: 'speedometer-outline', labelEn: 'Engine RPM', labelAr: 'سرعة دوران المحرك', category: 'engine' },
  { id: 'coolant', icon: 'thermometer-outline', labelEn: 'Coolant Temp', labelAr: 'حرارة المحرك', category: 'engine' },
  { id: 'voltage', icon: 'battery-charging-outline', labelEn: 'Battery Volt', labelAr: 'جهد البطارية', category: 'engine' },
  { id: 'engineLoad', icon: 'speedometer', labelEn: 'Engine Load', labelAr: 'حمل المحرك', category: 'engine' },
  { id: 'maf', icon: 'flash-outline', labelEn: 'MAF Flow', labelAr: 'تدفق الهواء', category: 'engine' },
  { id: 'o2', icon: 'analytics-outline', labelEn: 'O2 Sensor', labelAr: 'الأكسجين', category: 'engine' },
  { id: 'fuelTrim', icon: 'options-outline', labelEn: 'Fuel Trim', labelAr: 'ضبط الوقود', category: 'engine' },
  { id: 'atfTemp', icon: 'cog-outline', labelEn: 'Trans Temp', labelAr: 'حرارة الفتيس', category: 'safety' },
];

const DEFAULT_SELECTED_PARAMS: LiveParamId[] = ['rpm', 'coolant', 'voltage'];
const STORAGE_KEY_SELECTED_PARAMS = '@car_app/selected_live_params_v1';

type ViewMode = 'SCANNER' | 'LIVE_DATA' | 'READINESS';

type FaultStatus = 'ready' | 'loading' | 'error';
type FaultItem = Partial<DTCRecord> & {
  code: string;
  source: 'LOCAL' | 'AI';
  status: FaultStatus;
};

type AdviceContent = {
  title: string;
  subtitle?: string;
  module?: string;
  urgency?: UrgencyLevel;
  immediateGuidance: string;
  steps: string[];
  source?: 'LOCAL' | 'AI';
};

// -----------------------------------------------------------------------------
// Main Component
// -----------------------------------------------------------------------------
export default function DiagnosticsScreen() {
  const { isAr } = useLang();
  const dir = isAr ? 'row-reverse' : 'row';

  // --- Animation State for RPM ---
  const rpmAnim = useRef(new Animated.Value(0)).current;


  // Tab state
  const [activeView, setActiveView] = useState<ViewMode>('SCANNER');

  // --- SCANNER state ---
  const [isScanning, setIsScanning] = useState(false);
  const [scanTarget, setScanTarget] = useState<'engine' | 'transmission' | null>(null);
  const [faults, setFaults] = useState<FaultItem[] | null>(null);
  const scanIdRef = useRef(0);

  // --- LIVE DATA state (Engine) ---
  const [liveData, setLiveData] = useState<{
    rpm: number | null;
    coolant: number | null;
    voltage: number | null;
    engineLoad: number | null;
    maf: number | null;
    o2: number | null;
    fuelTrim: number | null;
  }>({
    rpm: null, coolant: null, voltage: null, engineLoad: null, maf: null, o2: null, fuelTrim: null,
  });

  // --- EXTRA SAFETY DATA state (TCM only; ABS/TPMS ECUs unreachable) ---
  const [extraSafetyData, setExtraSafetyData] = useState<{
    atfTemp: number | null;
  }>({
    atfTemp: null,
  });

  const [isLiveDataLoading, setIsLiveDataLoading] = useState(false);

  // --- Selective Live Data Dashboard state ---
  const [liveDataMode, setLiveDataMode] = useState<'select' | 'dashboard'>('select');
  const [selectedParams, setSelectedParams] = useState<Set<LiveParamId>>(new Set(DEFAULT_SELECTED_PARAMS));

  // Restore the user's last selection on mount; jump straight to the
  // dashboard if one was already saved instead of always starting on select
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY_SELECTED_PARAMS);
        if (stored) {
          const ids: LiveParamId[] = JSON.parse(stored);
          if (ids.length > 0) {
            setSelectedParams(new Set(ids));
            setLiveDataMode('dashboard');
          }
        }
      } catch (error) {
        console.warn('Failed to load selected live params:', error);
      }
    })();
  }, []);

  const toggleParam = (id: LiveParamId) => {
    setSelectedParams((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirmParamSelection = async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLiveDataMode('dashboard');
    try {
      await AsyncStorage.setItem(STORAGE_KEY_SELECTED_PARAMS, JSON.stringify(Array.from(selectedParams)));
    } catch (error) {
      console.warn('Failed to save selected live params:', error);
    }
  };

  const openParamSelection = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLiveDataMode('select');
  };

  // --- READINESS state ---
  const [readiness, setReadiness] = useState<{
    misfire: boolean; fuel: boolean; catalyst: boolean; evap: boolean; o2sensor: boolean;
  } | null>(null);
  const [misfireCounters, setMisfireCounters] = useState<{ cylinder: number; count: number }[] | null>(null);
  const [isReadinessLoading, setIsReadinessLoading] = useState(false);

  // --- Advice Modal ---
  const [adviceModalVisible, setAdviceModalVisible] = useState(false);
  const [currentAdvice, setCurrentAdvice] = useState<AdviceContent>({
    title: '', immediateGuidance: '', steps: [],
  });

  // --- Connection state ---
  const connected = isConnected();
  const statusColor = connected ? COLORS.success : COLORS.textTertiary;
  const statusText = connected ? (isAr ? 'متصل' : 'Connected') : (isAr ? 'غير متصل' : 'Disconnected');

  // ---------------------------------------------------------------------------
  // DTC Scan (Mode 03 + Multi-ECU)
  // ---------------------------------------------------------------------------
  const resolveFaultCode = async (code: string, moduleName: string | undefined, scanId: number) => {
    try {
      const ai = await fetchDTCFromAI(code, moduleName);
      if (scanIdRef.current !== scanId) return;
      setFaults((prev) =>
        prev?.map((f) => (f.code === code ? { ...ai, source: 'AI', status: 'ready' } : f)) ?? prev
      );
    } catch (err) {
      console.warn(`AI fallback failed for ${code}:`, err);
      if (scanIdRef.current !== scanId) return;
      setFaults((prev) => prev?.map((f) => (f.code === code ? { ...f, status: 'error' } : f)) ?? prev);
    }
  };

  const runScan = async (target: 'engine' | 'transmission') => {
    const thisScan = ++scanIdRef.current;
    setIsScanning(true);
    setScanTarget(target);
    setFaults(null);

    try {
      const foundItems = target === 'engine' ? await getEngineDTCs() : await getTransmissionDTCs();
      if (scanIdRef.current !== thisScan) return;

      const initialFaults: FaultItem[] = foundItems.map((item) => {
        const local = DTC_DATABASE[item.code];
        if (local) {
          return { ...local, module: local.module || item.module, source: 'LOCAL', status: 'ready' };
        }
        return { code: item.code, module: item.module, source: 'AI', status: 'loading' };
      });

      setFaults(initialFaults);
      initialFaults.filter((f) => f.status === 'loading').forEach((f) => resolveFaultCode(f.code, f.module, thisScan));

      // السطر ده عشان يحفظ الأعطال وتسمّع في الشاشة الرئيسية بره
      AsyncStorage.setItem('@stored_faults', JSON.stringify(initialFaults)).catch(() => {});
    } catch (error) {
      console.error('Scan failed:', error);
      Alert.alert('Error', isAr ? 'فشل الفحص' : 'Scan failed');
    } finally {
      setIsScanning(false);
      setScanTarget(null);
    }
  };

  const handleClear = () => {
    Alert.alert(isAr ? 'مسح الأعطال' : 'Clear Faults', isAr ? 'هل أنت متأكد؟' : 'Are you sure?', [
      { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
      { text: isAr ? 'مسح' : 'Clear', style: 'destructive', onPress: () => setFaults([]) },
    ]);
  };

  // ---------------------------------------------------------------------------
  // Live Data & Multi-ECU Polling
  // ---------------------------------------------------------------------------
  const fetchLiveDataWrapper = useCallback(async (isInitial = false) => {
    const engineKeys = LIVE_PARAMS.filter((p) => p.category === 'engine' && selectedParams.has(p.id)).map((p) => p.id) as LiveDataKey[];
    if (engineKeys.length === 0) return; // nothing engine-side selected — skip the round trip entirely

    if (isInitial) setIsLiveDataLoading(true);
    try {
      const data = await getLiveData(engineKeys);
      setLiveData(data);
    } catch (error) {
      console.warn('Failed to fetch live data:', error);
    } finally {
      if (isInitial) setIsLiveDataLoading(false);
    }
  }, [selectedParams]);

  const fetchExtraSafetyWrapper = useCallback(async () => {
    const safetyKeys = LIVE_PARAMS.filter((p) => p.category === 'safety' && selectedParams.has(p.id)).map((p) => p.id) as SafetyDataKey[];
    if (safetyKeys.length === 0) return; // nothing multi-ECU selected — skip entirely, no ATSH switching at all

    try {
      const data = await getExtraSafetyData(safetyKeys);
      setExtraSafetyData(data);
    } catch (error) {
      console.warn('Failed to fetch extra safety data:', error);
    }
  }, [selectedParams]);

  // Poll live data with a single sequential loop instead of two independent
  // setIntervals. This guarantees the slow (multi-ECU header-switching) request
  // always runs to completion before the fast loop is allowed to send its next
  // command — so ELM327 commands from the two cadences can never overlap or
  // pile up in the queue, and the JS thread/ELM buffer can't get stuck.
  useEffect(() => {
    let cancelled = false;
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;
    const FAST_INTERVAL_MS = 800;
    const SLOW_INTERVAL_MS = 5000;

    const runPollLoop = async () => {
      if (cancelled) return;
      await fetchLiveDataWrapper(true);
      if (cancelled) return;
      await fetchExtraSafetyWrapper();
      let lastSlowFetch = Date.now();

      const tick = async () => {
        if (cancelled) return;
        const tickStart = Date.now();

        // Slow multi-ECU request takes priority: it fully completes (halting
        // the fast loop) before any further fast-loop command is sent.
        if (tickStart - lastSlowFetch >= SLOW_INTERVAL_MS) {
          await fetchExtraSafetyWrapper();
          lastSlowFetch = Date.now();
          if (cancelled) return;
        }

        await fetchLiveDataWrapper(false);
        if (cancelled) return;

        const elapsed = Date.now() - tickStart;
        const delay = Math.max(0, FAST_INTERVAL_MS - elapsed);
        pollTimeout = setTimeout(tick, delay);
      };

      pollTimeout = setTimeout(tick, FAST_INTERVAL_MS);
    };

    if (activeView === 'LIVE_DATA' && liveDataMode === 'dashboard' && selectedParams.size > 0) {
      runPollLoop();
    }

    return () => {
      cancelled = true;
      if (pollTimeout) clearTimeout(pollTimeout);
    };
  }, [activeView, liveDataMode, selectedParams, fetchLiveDataWrapper, fetchExtraSafetyWrapper]);

  // Smooth Animation Trigger — animate toward 0 on a null/lost reading too
  // (instead of an instant setValue snap), so one missed poll doesn't jolt
  // the gauge; the numeric readout still switches to '--' immediately.
  useEffect(() => {
    const target = connected && liveData.rpm !== null ? liveData.rpm : 0;
    Animated.timing(rpmAnim, {
      toValue: target,
      duration: 750,
      useNativeDriver: false,
    }).start();
  }, [liveData.rpm, connected]);

  // ---------------------------------------------------------------------------
  // Readiness & Misfire Counters
  // ---------------------------------------------------------------------------
  const fetchReadiness = useCallback(async () => {
    setIsReadinessLoading(true);
    try {
      const [read, misfire] = await Promise.all([
        getReadiness(),
        getMisfireCounters(),
      ]);
      setReadiness(read);
      setMisfireCounters(misfire);
    } catch (error) {
      console.warn('Failed to fetch readiness data:', error);
    } finally {
      setIsReadinessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'READINESS') {
      fetchReadiness();
    }
  }, [activeView, fetchReadiness]);

  // ---------------------------------------------------------------------------
  // Advice Modal helpers
  // ---------------------------------------------------------------------------
  const openFaultAdvice = (f: FaultItem) => {
    if (f.status !== 'ready' || !f.adviceAr || !f.adviceEn || !f.urgency) return;
    const [immediateGuidance, ...steps] = isAr ? f.adviceAr : f.adviceEn;
    setCurrentAdvice({
      title: f.code,
      subtitle: isAr ? f.descAr : f.descEn,
      module: f.module,
      urgency: f.urgency,
      immediateGuidance,
      steps,
      source: f.source,
    });
    setAdviceModalVisible(true);
  };

  // ---------------------------------------------------------------------------
  // Computed values for UI
  // ---------------------------------------------------------------------------
  const faultCount = faults?.length ?? 0;
  const stopCount = useMemo(() => faults?.filter((f) => f.urgency === 'STOP').length ?? 0, [faults]);

  // Safe UI Variables
  const actualRpm = connected ? liveData.rpm : null;
  const actualCoolant = connected ? liveData.coolant : null;
  const actualVoltage = connected ? liveData.voltage : null;
  const actualEngineLoad = connected ? liveData.engineLoad : null;
  const actualMaf = connected ? liveData.maf : null;
  const actualO2 = connected ? liveData.o2 : null;
  const actualFuelTrim = connected ? liveData.fuelTrim : null;
  
  const actualAtfTemp = connected ? extraSafetyData.atfTemp : null;


  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { flexDirection: dir }]}>
        <Text style={[styles.headerTitle, { textAlign: isAr ? 'right' : 'left' }]}>
          {isAr ? 'تشخيص أعطال OBD-II' : 'OBD-II Diagnostics'}
        </Text>
        <View style={[styles.connectionStatus, { flexDirection: dir }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>ARC 103 · {statusText}</Text>
        </View>
      </View>

      <SegmentedTabs activeView={activeView} setActiveView={setActiveView} isAr={isAr} dir={dir} />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {activeView === 'SCANNER' && (
          <View>
            <View style={[styles.scanButtonRow2, { flexDirection: dir }]}>
              <TouchableOpacity
                style={[styles.scanButtonHalf, isScanning && styles.scanButtonDisabled]}
                onPress={() => runScan('engine')}
                disabled={isScanning}
                activeOpacity={0.85}
              >
                {isScanning && scanTarget === 'engine' ? (
                  <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                    <ActivityIndicator color="#0B0D10" />
                    <Text style={styles.scanButtonText}>{isAr ? 'جاري الفحص...' : 'Scanning...'}</Text>
                  </View>
                ) : (
                  <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                    <Ionicons name="cog-outline" size={20} color="#0B0D10" />
                    <Text style={styles.scanButtonText}>{isAr ? 'فحص الموتور' : 'Scan Engine'}</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.scanButtonHalf, styles.scanButtonHalfSecondary, isScanning && styles.scanButtonDisabled]}
                onPress={() => runScan('transmission')}
                disabled={isScanning}
                activeOpacity={0.85}
              >
                {isScanning && scanTarget === 'transmission' ? (
                  <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                    <ActivityIndicator color={COLORS.textPrimary} />
                    <Text style={[styles.scanButtonText, { color: COLORS.textPrimary }]}>{isAr ? 'جاري الفحص...' : 'Scanning...'}</Text>
                  </View>
                ) : (
                  <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                    <Ionicons name="build-outline" size={20} color={COLORS.textPrimary} />
                    <Text style={[styles.scanButtonText, { color: COLORS.textPrimary }]}>{isAr ? 'فحص الفتيس' : 'Scan Transmission'}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {faults !== null && (
              <View style={[styles.resultsBar, { flexDirection: dir }]}>
                <View style={[styles.resultsBarLeft, { flexDirection: dir }]}>
                  <Text style={styles.resultsCount}>
                    {isAr ? `${faultCount} عطل تم اكتشافه` : `${faultCount} faults found`}
                  </Text>
                  {stopCount > 0 && (
                    <View style={[styles.resultsStopPill, { flexDirection: dir }]}>
                      <Ionicons name="alert-circle" size={12} color={COLORS.danger} />
                      <Text style={styles.resultsStopPillText}>
                        {isAr ? `${stopCount} يستدعي التوقف` : `${stopCount} require stopping`}
                      </Text>
                    </View>
                  )}
                </View>
                {faultCount > 0 && (
                  <TouchableOpacity onPress={handleClear} hitSlop={8}>
                    <Text style={styles.clearLink}>{isAr ? 'مسح الكل' : 'Clear all'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {faults?.map((f) => (
              <FaultCard
                key={f.code}
                fault={f}
                isAr={isAr}
                dir={dir}
                onPress={() => openFaultAdvice(f)}
                onRetry={() => {
                  setFaults((prev) => prev?.map((x) => (x.code === f.code ? { ...x, status: 'loading' } : x)) ?? prev);
                  resolveFaultCode(f.code, f.module, scanIdRef.current);
                }}
              />
            ))}

            {faults !== null && faults.length === 0 && (
              <View style={styles.emptyState}>
                <Ionicons name="shield-checkmark-outline" size={36} color={COLORS.success} />
                <Text style={styles.emptyStateText}>
                  {isAr ? 'مفيش أعطال مسجلة في أي كنترول' : 'No faults stored in any module'}
                </Text>
              </View>
            )}
          </View>
        )}

        {activeView === 'LIVE_DATA' && (
          <View>
            {/* ── Select / Dashboard toolbar ── */}
            <View style={[styles.liveModeBar, { flexDirection: dir }]}>
              {liveDataMode === 'dashboard' ? (
                <>
                  <TouchableOpacity onPress={openParamSelection} style={[styles.liveModeBtn, { flexDirection: dir }]} activeOpacity={0.8}>
                    <Ionicons name="options-outline" size={16} color={COLORS.accent} />
                    <Text style={styles.liveModeBtnText}>{isAr ? 'تعديل الاختيار' : 'Edit Selection'}</Text>
                  </TouchableOpacity>
                  <Text style={styles.liveModeCount}>
                    {isAr ? `${selectedParams.size} مقياس نشط` : `${selectedParams.size} active`}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.liveModeCount}>
                    {isAr ? `${selectedParams.size} تم اختياره` : `${selectedParams.size} selected`}
                  </Text>
                  <TouchableOpacity
                    onPress={confirmParamSelection}
                    disabled={selectedParams.size === 0}
                    style={[styles.liveModeBtn, styles.liveModeBtnConfirm, selectedParams.size === 0 && { opacity: 0.4 }, { flexDirection: dir }]}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="checkmark-circle" size={16} color="#0B0D10" />
                    <Text style={styles.liveModeBtnConfirmText}>{isAr ? 'تأكيد' : 'Confirm'}</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>

            {liveDataMode === 'select' ? (
              /* ── SELECT MODE: plain list with checkboxes ── */
              <View style={styles.paramSelectList}>
                {LIVE_PARAMS.map((param) => {
                  const checked = selectedParams.has(param.id);
                  return (
                    <TouchableOpacity
                      key={param.id}
                      style={[styles.paramSelectRow, { flexDirection: dir }, checked && styles.paramSelectRowActive]}
                      onPress={() => toggleParam(param.id)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.paramSelectIconWrap, checked && { backgroundColor: COLORS.accentDim }]}>
                        <Ionicons name={param.icon} size={18} color={checked ? COLORS.accent : COLORS.textTertiary} />
                      </View>
                      <Text style={[styles.paramSelectLabel, { textAlign: isAr ? 'right' : 'left' }]}>
                        {isAr ? param.labelAr : param.labelEn}
                      </Text>
                      <Ionicons
                        name={checked ? 'checkbox' : 'square-outline'}
                        size={22}
                        color={checked ? COLORS.accent : COLORS.textTertiary}
                      />
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              /* ── DASHBOARD MODE: only the selected cards ── */
              <View style={styles.liveGrid}>
                {selectedParams.has('rpm') && (
                  <View style={[styles.liveCard, { width: '100%', paddingVertical: 24, alignItems: 'center' }]}>
                    <View style={{ width: '100%', flexDirection: dir, justifyContent: 'space-between', position: 'absolute', top: 16, paddingHorizontal: 16 }}>
                      <View style={[styles.statusBadge, { backgroundColor: actualRpm === null ? 'rgba(255,255,255,0.06)' : urgencyDim(getRpmStatus(actualRpm).tone), flexDirection: dir }]}>
                        <View style={[styles.miniDot, { backgroundColor: actualRpm === null ? COLORS.textTertiary : urgencyColor(getRpmStatus(actualRpm).tone) }]} />
                        <Text style={[styles.statusBadgeText, { color: actualRpm === null ? COLORS.textTertiary : urgencyColor(getRpmStatus(actualRpm).tone) }]}>
                          {actualRpm === null ? (isAr ? 'بانتظار...' : 'Waiting...') : isAr ? getRpmStatus(actualRpm).statusAr : getRpmStatus(actualRpm).statusEn}
                        </Text>
                      </View>
                      <Ionicons name="speedometer-outline" size={20} color={COLORS.textTertiary} />
                    </View>

                    <View style={{ width: 220, height: 110, marginTop: 20, alignItems: 'center', justifyContent: 'flex-end' }}>
                      <Svg width="100%" height="100%" viewBox="0 0 200 100">
                        <Path d="M 20 90 A 80 80 0 0 1 180 90" fill="none" stroke={COLORS.cardBorder} strokeWidth="12" strokeLinecap="round" />
                        <AnimatedPath
                          d="M 20 90 A 80 80 0 0 1 180 90"
                          fill="none"
                          stroke={actualRpm === null ? COLORS.cardBorder : urgencyColor(getRpmStatus(actualRpm).tone)}
                          strokeWidth="12"
                          strokeLinecap="round"
                          strokeDasharray={251.2}
                          strokeDashoffset={rpmAnim.interpolate({
                            inputRange: [0, 6000],
                            outputRange: [251.2, 0],
                            extrapolate: 'clamp',
                          })}
                        />
                      </Svg>

                      <View style={{ position: 'absolute', bottom: 0, alignItems: 'center' }}>
                        {isLiveDataLoading && actualRpm === null ? (
                          <ActivityIndicator color={COLORS.accent} style={{ marginBottom: 10 }} />
                        ) : (
                          <>
                            <Text style={{ color: COLORS.textPrimary, fontSize: 42, fontWeight: '900', letterSpacing: -1, height: 48 }}>
                              {actualRpm !== null ? actualRpm.toFixed(0) : '--'}
                            </Text>
                            <Text style={{ color: COLORS.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 1 }}>RPM</Text>
                          </>
                        )}
                      </View>
                    </View>
                    <Text style={{ color: COLORS.textSecondary, fontSize: 14, fontWeight: '600', marginTop: 12 }}>
                      {isAr ? 'سرعة دوران المحرك' : 'Engine Speed'}
                    </Text>
                  </View>
                )}

                {selectedParams.has('atfTemp') && (
                  <LiveCard
                    icon="cog-outline"
                    tone={getAtfTempStatus(actualAtfTemp).tone}
                    value={actualAtfTemp !== null ? actualAtfTemp.toFixed(0) : '--'}
                    unit="°C"
                    labelEn="Trans Temp"
                    labelAr="حرارة الفتيس"
                    statusEn={getAtfTempStatus(actualAtfTemp).statusEn}
                    statusAr={getAtfTempStatus(actualAtfTemp).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualAtfTemp === null}
                  />
                )}
                {selectedParams.has('coolant') && (
                  <LiveCard
                    icon="thermometer-outline"
                    tone={getCoolantStatus(actualCoolant).tone}
                    value={actualCoolant !== null ? actualCoolant.toFixed(0) : '--'}
                    unit="°C"
                    labelEn="Coolant Temp"
                    labelAr="حرارة المحرك"
                    statusEn={getCoolantStatus(actualCoolant).statusEn}
                    statusAr={getCoolantStatus(actualCoolant).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualCoolant === null}
                  />
                )}
                {selectedParams.has('voltage') && (
                  <LiveCard
                    icon="battery-charging-outline"
                    tone={getVoltageStatus(actualVoltage).tone}
                    value={actualVoltage !== null ? actualVoltage.toFixed(1) : '--'}
                    unit="V"
                    labelEn="Battery Volt"
                    labelAr="جهد البطارية"
                    statusEn={getVoltageStatus(actualVoltage).statusEn}
                    statusAr={getVoltageStatus(actualVoltage).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualVoltage === null}
                  />
                )}
                {selectedParams.has('engineLoad') && (
                  <LiveCard
                    icon="speedometer"
                    tone={getEngineLoadStatus(actualEngineLoad).tone}
                    value={actualEngineLoad !== null ? actualEngineLoad.toFixed(1) : '--'}
                    unit="%"
                    labelEn="Engine Load"
                    labelAr="حمل المحرك"
                    statusEn={getEngineLoadStatus(actualEngineLoad).statusEn}
                    statusAr={getEngineLoadStatus(actualEngineLoad).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualEngineLoad === null}
                  />
                )}
                {selectedParams.has('maf') && (
                  <LiveCard
                    icon="flash-outline"
                    tone={getMafStatus(actualMaf).tone}
                    value={actualMaf !== null ? actualMaf.toFixed(1) : '--'}
                    unit="g/s"
                    labelEn="MAF Flow"
                    labelAr="تدفق الهواء"
                    statusEn={getMafStatus(actualMaf).statusEn}
                    statusAr={getMafStatus(actualMaf).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualMaf === null}
                  />
                )}
                {selectedParams.has('o2') && (
                  <LiveCard
                    icon="analytics-outline"
                    tone={getO2Status(actualO2).tone}
                    value={actualO2 !== null ? actualO2.toFixed(2) : '--'}
                    unit="V"
                    labelEn="O2 Sensor"
                    labelAr="الأكسجين"
                    statusEn={getO2Status(actualO2).statusEn}
                    statusAr={getO2Status(actualO2).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualO2 === null}
                  />
                )}
                {selectedParams.has('fuelTrim') && (
                  <LiveCard
                    icon="options-outline"
                    tone={getFuelTrimStatus(actualFuelTrim).tone}
                    value={actualFuelTrim !== null ? actualFuelTrim.toFixed(1) : '--'}
                    unit="%"
                    labelEn="Fuel Trim"
                    labelAr="ضبط الوقود"
                    statusEn={getFuelTrimStatus(actualFuelTrim).statusEn}
                    statusAr={getFuelTrimStatus(actualFuelTrim).statusAr}
                    isAr={isAr}
                    dir={dir}
                    isLoading={isLiveDataLoading}
                    isWaiting={actualFuelTrim === null}
                  />
                )}

                {selectedParams.size === 0 && (
                  <View style={styles.emptyState}>
                    <Ionicons name="options-outline" size={36} color={COLORS.textTertiary} />
                    <Text style={styles.emptyStateText}>
                      {isAr ? 'محتاج تختار مقياس واحد على الأقل' : 'Select at least one parameter'}
                    </Text>
                  </View>
                )}
              </View>
            )}
          </View>
        )}

        {activeView === 'READINESS' && (
          <View>
            <Text style={[styles.sectionHeading, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'جاهزية الانبعاثات' : 'Emissions Readiness'}
            </Text>
            {isReadinessLoading ? (
              <ActivityIndicator color={COLORS.accent} size="large" style={{ marginVertical: 20 }} />
            ) : readiness ? (
              <View style={styles.glassCard}>
                {[
                  { key: 'misfire', labelEn: 'Misfire Monitor', labelAr: 'مراقبة التفتيش', icon: 'pulse-outline' },
                  { key: 'fuel', labelEn: 'Fuel System', labelAr: 'نظام الوقود', icon: 'water-outline' },
                  { key: 'catalyst', labelEn: 'Catalyst', labelAr: 'الكاتاليزر', icon: 'filter-outline' },
                  { key: 'evap', labelEn: 'EVAP System', labelAr: 'نظام التبخر EVAP', icon: 'cloud-outline' },
                  { key: 'o2sensor', labelEn: 'Oxygen Sensor', labelAr: 'حساس الأكسجين', icon: 'analytics-outline' },
                ].map((item, i) => {
                  const ready = readiness[item.key as keyof typeof readiness];
                  return (
                    <View
                      key={item.key}
                      style={[
                        styles.readinessRow,
                        { flexDirection: dir },
                        i === 4 && styles.readinessRowLast,
                      ]}
                    >
                      <View style={[styles.readinessLeft, { flexDirection: dir }]}>
                        <View style={[styles.readinessIconWrap, { backgroundColor: ready ? COLORS.successDim : COLORS.warningDim }]}>
                          <Ionicons name={item.icon as any} size={16} color={ready ? COLORS.success : COLORS.warning} />
                        </View>
                        <Text style={styles.readinessLabel}>{isAr ? item.labelAr : item.labelEn}</Text>
                      </View>
                      <View style={[styles.readinessStatusPill, { backgroundColor: ready ? COLORS.successDim : COLORS.warningDim, flexDirection: dir }]}>
                        <Ionicons
                          name={ready ? 'checkmark-circle' : 'time-outline'}
                          size={14}
                          color={ready ? COLORS.success : COLORS.warning}
                        />
                        <Text style={[styles.readinessStatusText, { color: ready ? COLORS.success : COLORS.warning }]}>
                          {ready ? (isAr ? 'جاهز' : 'Ready') : (isAr ? 'غير جاهز' : 'Not Ready')}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={{ color: COLORS.textSecondary, textAlign: 'center', marginVertical: 20 }}>
                {isAr ? 'لا توجد بيانات جاهزية' : 'No readiness data'}
              </Text>
            )}

            <Text style={[styles.sectionHeading, { textAlign: isAr ? 'right' : 'left', marginTop: 24 }]}>
              {isAr ? 'عدادات التفتيش — Mode $06' : 'Misfire Counters — Mode $06'}
            </Text>
            <Text style={[styles.sectionSubheading, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr
                ? 'عدد أحداث التفتيش المسجلة لكل سلندر منذ آخر مسح للأعطال'
                : 'Recorded misfire events per cylinder since the last fault clear'}
            </Text>
            {isReadinessLoading ? (
              <ActivityIndicator color={COLORS.accent} size="large" style={{ marginVertical: 20 }} />
            ) : misfireCounters ? (
              <View style={styles.misfireGrid}>
                {misfireCounters.map((m) => {
                  const pass = m.count <= 2;
                  const pct = Math.min(100, (m.count / 6) * 100);
                  return (
                    <View key={m.cylinder} style={styles.misfireCard}>
                      <View style={[styles.misfireCardTop, { flexDirection: dir }]}>
                        <Text style={styles.misfireCylinderLabel}>
                          {isAr ? `سلندر ${m.cylinder}` : `Cylinder ${m.cylinder}`}
                        </Text>
                        <View
                          style={[
                            styles.misfireStatusPill,
                            { backgroundColor: pass ? COLORS.successDim : COLORS.dangerDim, flexDirection: dir },
                          ]}
                        >
                          <Ionicons
                            name={pass ? 'checkmark-circle' : 'close-circle'}
                            size={12}
                            color={pass ? COLORS.success : COLORS.danger}
                          />
                          <Text style={[styles.misfireStatusText, { color: pass ? COLORS.success : COLORS.danger }]}>
                            {pass ? (isAr ? 'ضمن الحد' : 'Pass') : (isAr ? 'تجاوز الحد' : 'Fail')}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.misfireCount}>{m.count}</Text>
                      <View style={styles.misfireBarTrack}>
                        <View
                          style={[
                            styles.misfireBarFill,
                            { width: `${pct}%`, backgroundColor: pass ? COLORS.success : COLORS.danger },
                          ]}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <View style={{ alignItems: 'center', marginVertical: 20, gap: 8 }}>
                <Ionicons name="construct-outline" size={28} color={COLORS.textTertiary} />
                <Text style={{ color: COLORS.textSecondary, textAlign: 'center' }}>
                  {isAr
                    ? 'بيانات التفتيش غير مدعومة أو غير مطبقة بعد'
                    : 'Misfire data not supported or not implemented yet'}
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      <AdviceModal
        visible={adviceModalVisible}
        onClose={() => setAdviceModalVisible(false)}
        content={currentAdvice}
        isAr={isAr}
        dir={dir}
      />
    </SafeAreaView>
  );
}

// -----------------------------------------------------------------------------
// Sub‑components
// -----------------------------------------------------------------------------

function SegmentedTabs({
  activeView,
  setActiveView,
  isAr,
  dir,
}: {
  activeView: ViewMode;
  setActiveView: (v: ViewMode) => void;
  isAr: boolean;
  dir: 'row' | 'row-reverse';
}) {
  const tabs: { key: ViewMode; icon: string; labelEn: string; labelAr: string }[] = [
    { key: 'SCANNER', icon: 'scan-outline', labelEn: 'Scanner', labelAr: 'الفحص' },
    { key: 'LIVE_DATA', icon: 'pulse-outline', labelEn: 'Live Data', labelAr: 'بيانات حية' },
    { key: 'READINESS', icon: 'shield-checkmark-outline', labelEn: 'Readiness', labelAr: 'الجاهزية' },
  ];
  return (
    <View style={[styles.segmentWrap, { flexDirection: dir }]}>
      {tabs.map((tab) => {
        const active = activeView === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.segmentBtn, active && styles.segmentBtnActive]}
            onPress={() => setActiveView(tab.key)}
            activeOpacity={0.8}
          >
            <View style={[styles.segmentBtnRow, { flexDirection: dir }]}>
              <Ionicons name={tab.icon as any} size={15} color={active ? COLORS.background : COLORS.textSecondary} />
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {isAr ? tab.labelAr : tab.labelEn}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function FaultCard({
  fault,
  isAr,
  dir,
  onPress,
  onRetry,
}: {
  fault: FaultItem;
  isAr: boolean;
  dir: 'row' | 'row-reverse';
  onPress: () => void;
  onRetry: () => void;
}) {
  if (fault.status === 'loading') {
    return (
      <View style={[styles.faultCard, styles.faultCardPending]}>
        <View style={[styles.faultCardTop, { flexDirection: dir }]}>
          <Text style={styles.faultCode}>{fault.code}</Text>
          <View style={[styles.aiPill, { flexDirection: dir }]}>
            <Ionicons name="sparkles-outline" size={12} color={COLORS.accent} />
            <Text style={styles.aiPillText}>AI</Text>
          </View>
        </View>
        <View style={[styles.loadingRow, { flexDirection: dir }]}>
          <ActivityIndicator size="small" color={COLORS.accent} />
          <Text style={styles.loadingRowText}>
            {isAr
              ? 'كود غير موجود بالقاموس المحلي، جاري السؤال عن التشخيص من الذكاء الاصطناعي...'
              : 'Not in the local dictionary — asking AI for a diagnosis...'}
          </Text>
        </View>
      </View>
    );
  }

  if (fault.status === 'error') {
    return (
      <View style={[styles.faultCard, styles.faultCardError]}>
        <View style={[styles.faultCardTop, { flexDirection: dir }]}>
          <Text style={styles.faultCode}>{fault.code}</Text>
          <View style={[styles.aiPill, { flexDirection: dir }]}>
            <Ionicons name="sparkles-outline" size={12} color={COLORS.accent} />
            <Text style={styles.aiPillText}>AI</Text>
          </View>
        </View>
        <Text style={[styles.faultDescription, { textAlign: isAr ? 'right' : 'left', color: COLORS.textSecondary }]}>
          {isAr
            ? 'تعذر الوصول للذكاء الاصطناعي لتفسير هذا الكود. تأكد من الاتصال بالإنترنت.'
            : "Couldn't reach the AI to explain this code. Check your internet connection."}
        </Text>
        <TouchableOpacity style={styles.retryBtn} onPress={onRetry} activeOpacity={0.85}>
          <View style={[styles.smartAdviceRow, { flexDirection: dir }]}>
            <Ionicons name="refresh-outline" size={16} color={COLORS.textPrimary} />
            <Text style={styles.retryBtnText}>{isAr ? 'إعادة المحاولة' : 'Retry'}</Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  const meta = URGENCY_META[fault.urgency!];
  const tone = urgencyColor(meta.color);
  const dim = urgencyDim(meta.color);

  return (
    <View style={styles.faultCard}>
      <View style={[styles.faultCardTop, { flexDirection: dir }]}>
        <View style={[styles.faultCardTopLeft, { flexDirection: dir }]}>
          <Text style={styles.faultCode}>{fault.code}</Text>
          {fault.source === 'AI' && (
            <View style={[styles.aiPill, { flexDirection: dir }]}>
              <Ionicons name="sparkles-outline" size={12} color={COLORS.accent} />
              <Text style={styles.aiPillText}>AI</Text>
            </View>
          )}
        </View>
        <View style={[styles.urgencyPill, { backgroundColor: dim, flexDirection: dir }]}>
          <Ionicons name={meta.icon as any} size={13} color={tone} />
          <Text style={[styles.urgencyPillText, { color: tone }]}>{isAr ? meta.labelAr : meta.labelEn}</Text>
        </View>
      </View>
      <Text style={[styles.faultDescription, { textAlign: isAr ? 'right' : 'left' }]}>
        {isAr ? fault.descAr : fault.descEn}
      </Text>
      {!!fault.module && (
        <View style={[styles.moduleRow, { flexDirection: dir }]}>
          <Ionicons name="hardware-chip-outline" size={13} color={COLORS.textTertiary} />
          <Text style={styles.moduleText}>{fault.module}</Text>
        </View>
      )}
      <TouchableOpacity style={styles.smartAdviceBtn} onPress={onPress} activeOpacity={0.85}>
        <View style={[styles.smartAdviceRow, { flexDirection: dir }]}>
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={COLORS.background} />
          <Text style={styles.smartAdviceText}>{isAr ? 'إزاي أحل المشكلة؟' : 'How to fix this?'}</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

function LiveCard({
  icon,
  tone,
  value,
  unit,
  labelEn,
  labelAr,
  statusEn,
  statusAr,
  isAr,
  dir,
  onPress,
  isLoading = false,
  isWaiting = false,
  fullWidth = false,
}: {
  icon: any;
  tone: 'success' | 'warning' | 'danger' | 'accent';
  value: string;
  unit: string;
  labelEn: string;
  labelAr: string;
  statusEn: string;
  statusAr: string;
  isAr: boolean;
  dir: 'row' | 'row-reverse';
  onPress?: () => void;
  isLoading?: boolean;
  isWaiting?: boolean;
  fullWidth?: boolean;
}) {
  const displayTone = isWaiting ? 'warning' : tone;
  const color =
    displayTone === 'success' ? COLORS.success :
    displayTone === 'warning' ? COLORS.warning :
    displayTone === 'danger' ? COLORS.danger :
    COLORS.accent;
  const dimColor =
    displayTone === 'success' ? COLORS.successDim :
    displayTone === 'warning' ? COLORS.warningDim :
    displayTone === 'danger' ? COLORS.dangerDim :
    COLORS.accentDim;

  let displayStatusEn = statusEn;
  let displayStatusAr = statusAr;
  let displayColor = color;
  if (isWaiting) {
    displayStatusEn = 'Waiting...';
    displayStatusAr = 'بانتظار...';
    displayColor = COLORS.textTertiary;
  }

  const CardInner = (
    <>
      <View style={[styles.liveCardTop, { flexDirection: dir }]}>
        <View style={styles.liveIconWrap}>
          <Ionicons name={icon} size={18} color={color} />
        </View>
        <View style={[styles.statusBadge, { backgroundColor: isWaiting ? 'rgba(255,255,255,0.06)' : dimColor, flexDirection: dir }]}>
          <View style={[styles.miniDot, { backgroundColor: displayColor }]} />
          <Text style={[styles.statusBadgeText, { color: displayColor }]}>{isAr ? displayStatusAr : displayStatusEn}</Text>
        </View>
      </View>
      {isLoading ? (
        <ActivityIndicator color={color} style={{ marginVertical: 8 }} />
      ) : (
        <Text style={[styles.liveValue, { textAlign: isAr ? 'right' : 'left', color: isWaiting ? COLORS.textSecondary : color }]}>
          {value} <Text style={styles.liveUnit}>{unit}</Text>
        </Text>
      )}
      <Text style={[styles.liveLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? labelAr : labelEn}</Text>
      {!isLoading && !isWaiting && onPress && (
        <View style={[styles.liveCardHint, { flexDirection: dir }]}>
          <Ionicons name="information-circle-outline" size={12} color={COLORS.textTertiary} />
          <Text style={styles.liveCardHintText}>{isAr ? 'اضغط للتفاصيل' : 'Tap for details'}</Text>
        </View>
      )}
    </>
  );

  const cardStyle: any = [styles.liveCard, fullWidth ? { width: '100%', paddingVertical: 20 } : null];
  
  if (onPress && !isLoading && !isWaiting) {
    return (
      <TouchableOpacity style={[cardStyle, styles.liveCardTappable]} onPress={onPress} activeOpacity={0.8}>
        {CardInner}
      </TouchableOpacity>
    );
  }
  return <View style={cardStyle}>{CardInner}</View>;
}

function AdviceModal({
  visible,
  onClose,
  content,
  isAr,
  dir,
}: {
  visible: boolean;
  onClose: () => void;
  content: AdviceContent;
  isAr: boolean;
  dir: 'row' | 'row-reverse';
}) {
  const meta = content.urgency ? URGENCY_META[content.urgency] : null;
  const tone = meta ? urgencyColor(meta.color) : COLORS.accent;
  const dim = meta ? urgencyDim(meta.color) : COLORS.accentDim;

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
        <View style={styles.adviceModalContent}>
          <View style={styles.modalHandle} />
          <View style={[styles.adviceHeader, { flexDirection: dir }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.adviceTitleText, { textAlign: isAr ? 'right' : 'left' }]}>{content.title}</Text>
              {!!content.subtitle && (
                <Text style={[styles.adviceSubtitleText, { textAlign: isAr ? 'right' : 'left' }]}>{content.subtitle}</Text>
              )}
              {!!content.module && (
                <View style={[styles.moduleRow, { flexDirection: dir, marginTop: 4 }]}>
                  <Ionicons name="hardware-chip-outline" size={13} color={COLORS.textTertiary} />
                  <Text style={styles.moduleText}>{content.module}</Text>
                </View>
              )}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={24} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={[styles.pillRow, { flexDirection: dir }]}>
              {meta && (
                <View style={[styles.urgencyPill, { backgroundColor: dim, flexDirection: dir }]}>
                  <Ionicons name={meta.icon as any} size={14} color={tone} />
                  <Text style={[styles.urgencyPillText, { color: tone, fontSize: 13 }]}>
                    {isAr ? meta.labelAr : meta.labelEn}
                  </Text>
                </View>
              )}
              {content.source === 'AI' && (
                <View style={[styles.aiPill, styles.aiPillLarge, { flexDirection: dir }]}>
                  <Ionicons name="sparkles-outline" size={13} color={COLORS.accent} />
                  <Text style={styles.aiPillText}>{isAr ? 'مولّد بالذكاء الاصطناعي' : 'AI Generated'}</Text>
                </View>
              )}
            </View>

            {content.source === 'AI' && (
              <View style={[styles.aiDisclaimer, { flexDirection: dir }]}>
                <Ionicons name="information-circle-outline" size={15} color={COLORS.textSecondary} />
                <Text style={[styles.aiDisclaimerText, { textAlign: isAr ? 'right' : 'left' }]}>
                  {isAr
                    ? 'هذا الكود غير موجود في القاموس المحلي وتم تفسيره تلقائياً عبر الذكاء الاصطناعي. راجع فني متخصص قبل اتخاذ قرار نهائي.'
                    : 'This code isn\u2019t in the local dictionary and was explained automatically by AI. Confirm with a qualified technician before making a final decision.'}
                </Text>
              </View>
            )}

            <View style={[styles.immediateBox, { borderColor: tone, backgroundColor: dim }]}>
              <View style={[styles.immediateBoxHeader, { flexDirection: dir }]}>
                <Ionicons name="navigate-circle-outline" size={18} color={tone} />
                <Text style={[styles.immediateBoxLabel, { color: tone }]}>
                  {isAr ? 'التوجيه المروري الفوري' : 'Immediate Driving Guidance'}
                </Text>
              </View>
              <Text style={[styles.immediateBoxText, { textAlign: isAr ? 'right' : 'left' }]}>
                {content.immediateGuidance}
              </Text>
            </View>

            <Text style={[styles.stepsHeading, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'خطوات الإصلاح الفني' : 'Technical Repair Steps'}
            </Text>
            <View style={styles.adviceStepsContainer}>
              {content.steps.map((step, index) => (
                <View key={index} style={[styles.adviceStepRow, { flexDirection: dir }]}>
                  <View style={styles.stepNumberBadge}>
                    <Text style={styles.stepNumberText}>{index + 1}</Text>
                  </View>
                  <Text style={[styles.stepText, { textAlign: isAr ? 'right' : 'left' }]}>{step}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },

  header: { padding: 16, paddingBottom: 8, alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { color: COLORS.textPrimary, fontSize: 21, fontWeight: '800', letterSpacing: 0.2 },
  connectionStatus: {
    alignItems: 'center',
    backgroundColor: '#122019',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.25)',
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 11, fontWeight: '700' },

  segmentWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    gap: 4,
  },
  segmentBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentBtnActive: { backgroundColor: COLORS.accent },
  segmentBtnRow: { alignItems: 'center', gap: 6 },
  segmentText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: COLORS.background },

  scrollContent: { padding: 16, paddingBottom: 48 },

  scanButton: {
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 17,
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: COLORS.accent,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  scanButtonDisabled: { opacity: 0.8 },
  scanButtonRow: { alignItems: 'center', gap: 8 },
  scanButtonText: { color: '#0B0D10', fontSize: 15.5, fontWeight: '800' },

  scanButtonRow2: { gap: 10, marginBottom: 16 },
  scanButtonHalf: {
    flex: 1,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 17,
    borderRadius: 16,
    shadowColor: COLORS.accent,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  scanButtonHalfSecondary: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    shadowOpacity: 0,
    elevation: 0,
  },

  resultsBar: { alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingHorizontal: 2 },
  resultsBarLeft: { alignItems: 'center', gap: 10 },
  resultsCount: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  resultsStopPill: {
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.dangerDim,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  resultsStopPillText: { color: COLORS.danger, fontSize: 11, fontWeight: '700' },
  clearLink: { color: COLORS.textTertiary, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },

  emptyState: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  emptyStateText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '600' },

  faultCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  faultCardTop: { alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  faultCardTopLeft: { alignItems: 'center', gap: 8 },
  faultCardPending: { borderColor: COLORS.accent, borderStyle: 'dashed' },
  faultCardError: { borderColor: COLORS.textTertiary },
  faultCode: { color: COLORS.textPrimary, fontSize: 21, fontWeight: '900', letterSpacing: 0.5 },
  urgencyPill: { alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 9 },
  urgencyPillText: { fontSize: 11.5, fontWeight: '800' },
  faultDescription: { color: COLORS.textPrimary, fontSize: 14, lineHeight: 20, marginBottom: 14 },
  smartAdviceBtn: { backgroundColor: COLORS.accent, paddingVertical: 11, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  smartAdviceRow: { alignItems: 'center', gap: 7 },
  smartAdviceText: { color: COLORS.background, fontSize: 14, fontWeight: '800' },

  aiPill: {
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.accentDim,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 7,
  },
  aiPillLarge: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 9 },
  aiPillText: { color: COLORS.accent, fontSize: 10.5, fontWeight: '800' },
  pillRow: { alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 },

  loadingRow: { alignItems: 'center', gap: 10, paddingVertical: 4 },
  loadingRowText: { flex: 1, color: COLORS.textSecondary, fontSize: 13, lineHeight: 18 },
  retryBtn: {
    backgroundColor: COLORS.cardBorder,
    paddingVertical: 10,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  retryBtnText: { color: COLORS.textPrimary, fontSize: 13.5, fontWeight: '700' },

  moduleRow: { alignItems: 'center', gap: 6, marginBottom: 14 },
  moduleText: { color: COLORS.textTertiary, fontSize: 12, fontWeight: '600' },

  aiDisclaimer: {
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 18,
  },
  aiDisclaimerText: { flex: 1, color: COLORS.textSecondary, fontSize: 12, lineHeight: 17 },

  liveGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },

  liveModeBar: { justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  liveModeBtn: { alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: COLORS.accentDim },
  liveModeBtnText: { color: COLORS.accent, fontSize: 13, fontWeight: '700' },
  liveModeCount: { color: COLORS.textTertiary, fontSize: 12, fontWeight: '600' },
  liveModeBtnConfirm: { backgroundColor: COLORS.accent },
  liveModeBtnConfirmText: { color: '#0B0D10', fontSize: 13, fontWeight: '800' },

  paramSelectList: { gap: 8 },
  paramSelectRow: {
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  paramSelectRowActive: { borderColor: COLORS.accent },
  paramSelectIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.cardAlt,
  },
  paramSelectLabel: { flex: 1, color: COLORS.textPrimary, fontSize: 14.5, fontWeight: '700' },
  liveCard: {
    width: '48%',
    backgroundColor: COLORS.card,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    marginBottom: 12,
  },
  liveCardTappable: { borderColor: COLORS.warning },
  liveIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveCardTop: { justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  statusBadge: { alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7 },
  statusBadgeText: { fontSize: 9.5, fontWeight: '800' },
  miniDot: { width: 5, height: 5, borderRadius: 3 },
  liveValue: { color: COLORS.textPrimary, fontSize: 21, fontWeight: '800', marginBottom: 2 },
  liveUnit: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  liveLabel: { color: COLORS.textSecondary, fontSize: 11.5 },
  liveCardHint: { alignItems: 'center', gap: 4, marginTop: 8 },
  liveCardHintText: { color: COLORS.textTertiary, fontSize: 10, fontWeight: '600' },

  sectionHeading: { color: COLORS.textPrimary, fontSize: 15.5, fontWeight: '800', marginBottom: 4 },
  sectionSubheading: { color: COLORS.textSecondary, fontSize: 12.5, marginBottom: 14, lineHeight: 18 },

  glassCard: {
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderRadius: 18,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
  },
  readinessRow: {
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.glassBorder,
  },
  readinessRowLast: { borderBottomWidth: 0 },
  readinessLeft: { alignItems: 'center', gap: 12 },
  readinessIconWrap: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  readinessLabel: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '600' },
  readinessStatusPill: { alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 },
  readinessStatusText: { fontSize: 11.5, fontWeight: '800' },

  misfireGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  misfireCard: {
    width: '48%',
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
  },
  misfireCardTop: { alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  misfireCylinderLabel: { color: COLORS.textSecondary, fontSize: 12.5, fontWeight: '700' },
  misfireStatusPill: { alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7 },
  misfireStatusText: { fontSize: 10, fontWeight: '800' },
  misfireCount: { color: COLORS.textPrimary, fontSize: 26, fontWeight: '900', marginBottom: 10 },
  misfireBarTrack: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  misfireBarFill: { height: 6, borderRadius: 3 },

  modalOverlay: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end' },
  adviceModalContent: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    padding: 24,
    maxHeight: '85%',
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.cardBorder,
    alignSelf: 'center',
    marginBottom: 16,
  },
  adviceHeader: { alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 10 },
  adviceTitleText: { color: COLORS.textPrimary, fontSize: 19, fontWeight: '900' },
  adviceSubtitleText: { color: COLORS.textSecondary, fontSize: 13, marginTop: 3, lineHeight: 18 },
  immediateBox: { borderRadius: 16, borderWidth: 1.5, padding: 15, marginBottom: 22 },
  immediateBoxHeader: { alignItems: 'center', gap: 7, marginBottom: 8 },
  immediateBoxLabel: { fontSize: 13, fontWeight: '800' },
  immediateBoxText: { color: COLORS.textPrimary, fontSize: 14.5, lineHeight: 21, fontWeight: '500' },

  stepsHeading: { color: COLORS.textSecondary, fontSize: 12.5, fontWeight: '800', marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.5 },
  adviceStepsContainer: { gap: 16, paddingBottom: 8 },
  adviceStepRow: { alignItems: 'flex-start', gap: 12 },
  stepNumberBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.accent,
  },
  stepNumberText: { color: COLORS.accent, fontSize: 14, fontWeight: 'bold' },
  stepText: { color: COLORS.textPrimary, fontSize: 15, lineHeight: 22, flex: 1 },
});