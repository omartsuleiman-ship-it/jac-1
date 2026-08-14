// diagnostics.tsx
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { DTC_DATABASE, DTCRecord, URGENCY_META, UrgencyLevel } from '../constants/dtc_dictionary';
import { getDTCs, getLiveData, getMisfireCounters, getReadiness, isConnected } from '../services/bleService';
import { fetchDTCFromAI } from '../services/groqDtcService';
import { useLang } from './_layout';

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
// Live Data thresholds — calibrated for a 2016 JAC S3 1.5L NA VVT, ~145,000 km.
// Ranges are widened slightly vs. factory-new spec to reflect normal wear at
// this mileage (idle drift, minor injector/vacuum aging, alternator brush wear)
// without masking genuine faults.
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
  // From 0 to 105 is normal (covers cold start and normal operating temp)
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

  // Tab state
  const [activeView, setActiveView] = useState<ViewMode>('SCANNER');

  // --- SCANNER state ---
  const [isScanning, setIsScanning] = useState(false);
  const [faults, setFaults] = useState<FaultItem[] | null>(null);
  const scanIdRef = useRef(0);

  // --- LIVE DATA state (initialised to null) ---
  const [liveData, setLiveData] = useState<{
    rpm: number | null;
    coolant: number | null;
    voltage: number | null;
    engineLoad: number | null;
    maf: number | null;
    o2: number | null;
    fuelTrim: number | null;
  }>({
    rpm: null,
    coolant: null,
    voltage: null,
    engineLoad: null,
    maf: null,
    o2: null,
    fuelTrim: null,
  });
  const [isLiveDataLoading, setIsLiveDataLoading] = useState(false);

  // --- READINESS state ---
  const [readiness, setReadiness] = useState<{
    misfire: boolean;
    fuel: boolean;
    catalyst: boolean;
    evap: boolean;
    o2sensor: boolean;
  } | null>(null);
  const [misfireCounters, setMisfireCounters] = useState<{ cylinder: number; count: number }[] | null>(null);
  const [isReadinessLoading, setIsReadinessLoading] = useState(false);

  // --- Advice Modal ---
  const [adviceModalVisible, setAdviceModalVisible] = useState(false);
  const [currentAdvice, setCurrentAdvice] = useState<AdviceContent>({
    title: '',
    immediateGuidance: '',
    steps: [],
  });

  // --- Connection state ---
  const connected = isConnected();
  const statusColor = connected ? COLORS.success : COLORS.textTertiary;
  const statusText = connected ? (isAr ? 'متصل' : 'Connected') : (isAr ? 'غير متصل' : 'Disconnected');

  // ---------------------------------------------------------------------------
  // DTC Scan (Mode 03)
  // ---------------------------------------------------------------------------
  const resolveFaultCode = async (code: string, scanId: number) => {
    try {
      const ai = await fetchDTCFromAI(code);
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

  const handleScan = async () => {
    const thisScan = ++scanIdRef.current;
    setIsScanning(true);
    setFaults(null);

    try {
      const codes = await getDTCs();
      if (scanIdRef.current !== thisScan) return;

      const initialFaults: FaultItem[] = codes.map((code) => {
        const local = DTC_DATABASE[code];
        if (local) {
          return { ...local, source: 'LOCAL', status: 'ready' };
        }
        return { code, source: 'AI', status: 'loading' };
      });

      setFaults(initialFaults);
      initialFaults.filter((f) => f.status === 'loading').forEach((f) => resolveFaultCode(f.code, thisScan));
    } catch (error) {
      console.error('Scan failed:', error);
      Alert.alert('Error', isAr ? 'فشل الفحص' : 'Scan failed');
    } finally {
      setIsScanning(false);
    }
  };

  const handleClear = () => {
    Alert.alert(isAr ? 'مسح الأعطال' : 'Clear Faults', isAr ? 'هل أنت متأكد؟' : 'Are you sure?', [
      { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
      { text: isAr ? 'مسح' : 'Clear', style: 'destructive', onPress: () => setFaults([]) },
    ]);
  };

  // ---------------------------------------------------------------------------
  // Live Data (Mode 01 PIDs)
  // ---------------------------------------------------------------------------
  const fetchLiveData = useCallback(async (isInitial = false) => {
    if (isInitial) setIsLiveDataLoading(true);
    try {
      const data = await getLiveData();
      setLiveData(data);
    } catch (error) {
      console.warn('Failed to fetch live data:', error);
    } finally {
      if (isInitial) setIsLiveDataLoading(false);
    }
  }, []);

  // Poll live data when the tab is active
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (activeView === 'LIVE_DATA') {
      fetchLiveData(true); // Load only on the very first fetch
      interval = setInterval(() => fetchLiveData(false), 1000); // Silent updates thereafter
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [activeView, fetchLiveData]);

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

  const openSensorAdvice = (
    titleEn: string,
    titleAr: string,
    immediateEn: string,
    immediateAr: string,
    stepsEn: string[],
    stepsAr: string[]
  ) => {
    setCurrentAdvice({
      title: isAr ? titleAr : titleEn,
      urgency: 'CAUTION',
      immediateGuidance: isAr ? immediateAr : immediateEn,
      steps: isAr ? stepsAr : stepsEn,
    });
    setAdviceModalVisible(true);
  };

  // ---------------------------------------------------------------------------
  // Computed values for UI
  // ---------------------------------------------------------------------------
  const faultCount = faults?.length ?? 0;
  const stopCount = useMemo(() => faults?.filter((f) => f.urgency === 'STOP').length ?? 0, [faults]);

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
            <TouchableOpacity
              style={[styles.scanButton, isScanning && styles.scanButtonDisabled]}
              onPress={handleScan}
              disabled={isScanning}
              activeOpacity={0.85}
            >
              {isScanning ? (
                <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                  <ActivityIndicator color="#0B0D10" />
                  <Text style={styles.scanButtonText}>{isAr ? 'جاري الفحص...' : 'Scanning...'}</Text>
                </View>
              ) : (
                <View style={[styles.scanButtonRow, { flexDirection: dir }]}>
                  <Ionicons name="scan-outline" size={20} color="#0B0D10" />
                  <Text style={styles.scanButtonText}>
                    {isAr ? 'فحص جميع الأعطال المسجلة' : 'Scan All Stored Faults'}
                  </Text>
                </View>
              )}
            </TouchableOpacity>

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
                  resolveFaultCode(f.code, scanIdRef.current);
                }}
              />
            ))}

            {faults !== null && faults.length === 0 && (
              <View style={styles.emptyState}>
                <Ionicons name="shield-checkmark-outline" size={36} color={COLORS.success} />
                <Text style={styles.emptyStateText}>
                  {isAr ? 'مفيش أعطال مسجلة حالياً' : 'No faults currently stored'}
                </Text>
              </View>
            )}
          </View>
        )}

        {activeView === 'LIVE_DATA' && (
          <View style={styles.liveGrid}>
            {/* ── 3D Interactive RPM Gauge ── */}
            <View style={[styles.liveCard, { width: '100%', paddingVertical: 24, alignItems: 'center' }]}>
              <View style={{ width: '100%', flexDirection: dir, justifyContent: 'space-between', position: 'absolute', top: 16, paddingHorizontal: 16 }}>
                <View style={[styles.statusBadge, { backgroundColor: liveData.rpm === null ? 'rgba(255,255,255,0.06)' : urgencyDim(getRpmStatus(liveData.rpm).tone), flexDirection: dir }]}>
                  <View style={[styles.miniDot, { backgroundColor: liveData.rpm === null ? COLORS.textTertiary : urgencyColor(getRpmStatus(liveData.rpm).tone) }]} />
                  <Text style={[styles.statusBadgeText, { color: liveData.rpm === null ? COLORS.textTertiary : urgencyColor(getRpmStatus(liveData.rpm).tone) }]}>
                    {liveData.rpm === null ? (isAr ? 'بانتظار...' : 'Waiting...') : isAr ? getRpmStatus(liveData.rpm).statusAr : getRpmStatus(liveData.rpm).statusEn}
                  </Text>
                </View>
                <Ionicons name="speedometer-outline" size={20} color={COLORS.textTertiary} />
              </View>

              <View style={{ width: 220, height: 110, marginTop: 20, alignItems: 'center', justifyContent: 'flex-end' }}>
                <Svg width="100%" height="100%" viewBox="0 0 200 100">
                  {/* مسار العداد الخلفي (الرمادي) */}
                  <Path
                    d="M 20 90 A 80 80 0 0 1 180 90"
                    fill="none"
                    stroke={COLORS.cardBorder}
                    strokeWidth="12"
                    strokeLinecap="round"
                  />
                  {/* مسار العداد الملون (التفاعلي) */}
                  <Path
                    d="M 20 90 A 80 80 0 0 1 180 90"
                    fill="none"
                    stroke={liveData.rpm === null ? COLORS.cardBorder : urgencyColor(getRpmStatus(liveData.rpm).tone)}
                    strokeWidth="12"
                    strokeLinecap="round"
                    strokeDasharray={251.2} // محيط النص دائرة (Pi * 80)
                    strokeDashoffset={liveData.rpm === null ? 251.2 : 251.2 - (Math.min(liveData.rpm / 6000, 1) * 251.2)}
                  />
                </Svg>
                
                {/* الأرقام داخل العداد */}
                <View style={{ position: 'absolute', bottom: 0, alignItems: 'center' }}>
                  {isLiveDataLoading && liveData.rpm === null ? (
                    <ActivityIndicator color={COLORS.accent} style={{ marginBottom: 10 }} />
                  ) : (
                    <>
                      <Text style={{ color: COLORS.textPrimary, fontSize: 42, fontWeight: '900', letterSpacing: -1, height: 48 }}>
                        {liveData.rpm !== null ? liveData.rpm.toFixed(0) : '--'}
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
            {/* ── End of RPM Gauge ── */}
            {/* The other 6 cards (2x2x2) */}
            <LiveCard
              icon="thermometer-outline"
              tone={getCoolantStatus(liveData.coolant).tone}
              value={liveData.coolant !== null ? liveData.coolant.toFixed(0) : '--'}
              unit="°C"
              labelEn="Coolant Temp"
              labelAr="حرارة المحرك"
              statusEn={getCoolantStatus(liveData.coolant).statusEn}
              statusAr={getCoolantStatus(liveData.coolant).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.coolant === null}
            />
            <LiveCard
              icon="battery-charging-outline"
              tone={getVoltageStatus(liveData.voltage).tone}
              value={liveData.voltage !== null ? liveData.voltage.toFixed(1) : '--'}
              unit="V"
              labelEn="Battery Voltage"
              labelAr="جهد البطارية"
              statusEn={getVoltageStatus(liveData.voltage).statusEn}
              statusAr={getVoltageStatus(liveData.voltage).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.voltage === null}
            />
            <LiveCard
              icon="speedometer"
              tone={getEngineLoadStatus(liveData.engineLoad).tone}
              value={liveData.engineLoad !== null ? liveData.engineLoad.toFixed(1) : '--'}
              unit="%"
              labelEn="Engine Load"
              labelAr="حمل المحرك"
              statusEn={getEngineLoadStatus(liveData.engineLoad).statusEn}
              statusAr={getEngineLoadStatus(liveData.engineLoad).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.engineLoad === null}
            />
            <LiveCard
              icon="flash-outline"
              tone={getMafStatus(liveData.maf).tone}
              value={liveData.maf !== null ? liveData.maf.toFixed(1) : '--'}
              unit="g/s"
              labelEn="MAF Air Flow"
              labelAr="تدفق الهواء"
              statusEn={getMafStatus(liveData.maf).statusEn}
              statusAr={getMafStatus(liveData.maf).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.maf === null}
            />
            <LiveCard
              icon="analytics-outline"
              tone={getO2Status(liveData.o2).tone}
              value={liveData.o2 !== null ? liveData.o2.toFixed(2) : '--'}
              unit="V"
              labelEn="O2 Sensor"
              labelAr="حساس الأكسجين"
              statusEn={getO2Status(liveData.o2).statusEn}
              statusAr={getO2Status(liveData.o2).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.o2 === null}
              onPress={() =>
                openSensorAdvice(
                  'O2 Sensor — Checking',
                  'حساس الأكسجين — قيد الفحص',
                  'No need to stop; drive normally while the module finishes evaluating the sensor.',
                  'مفيش داعي تقف؛ كمل السواقة عادي لحد ما الكمبيوتر يخلص تقييم الحساس.',
                  ['Check sensor connector.', 'Inspect for exhaust leak.'],
                  ['افحص وصلة الحساس.', 'افحص أي تسريب في العادم.']
                )
              }
            />
            <LiveCard
              icon="options-outline"
              tone={getFuelTrimStatus(liveData.fuelTrim).tone}
              value={liveData.fuelTrim !== null ? liveData.fuelTrim.toFixed(1) : '--'}
              unit="%"
              labelEn="Fuel Trim"
              labelAr="ضبط الوقود"
              statusEn={getFuelTrimStatus(liveData.fuelTrim).statusEn}
              statusAr={getFuelTrimStatus(liveData.fuelTrim).statusAr}
              isAr={isAr}
              dir={dir}
              isLoading={isLiveDataLoading}
              isWaiting={liveData.fuelTrim === null}
            />
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
  // Determine the actual tone to display (waiting overrides to neutral)
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

  // Determine status text to show
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
// Styles (unchanged)
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