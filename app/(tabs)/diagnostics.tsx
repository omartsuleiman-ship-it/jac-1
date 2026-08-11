import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useMemo, useRef, useState } from 'react';
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
import { DTC_DATABASE, DTCRecord, URGENCY_META, UrgencyLevel } from '../constants/dtc_dictionary';
import { fetchDTCFromAI } from '../services/groqDtcService';
import { useLang } from './_layout';

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

// Maps the abstract "color" token stored on each urgency level to real hex values.
const urgencyColor = (tone: 'danger' | 'warning' | 'accent') =>
  tone === 'danger' ? COLORS.danger : tone === 'warning' ? COLORS.warning : COLORS.accent;
const urgencyDim = (tone: 'danger' | 'warning' | 'accent') =>
  tone === 'danger' ? COLORS.dangerDim : tone === 'warning' ? COLORS.warningDim : COLORS.accentDim;

type ViewMode = 'SCANNER' | 'LIVE_DATA' | 'READINESS';

// A fault as rendered in the Scanner list. Every fault is either resolved
// instantly from the local DTC_DATABASE ('LOCAL') or resolved asynchronously
// from Gemini ('AI'). AI-sourced items pass through 'loading' → 'ready' (or
// 'error' with a retry action) while LOCAL items are always 'ready'.
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

// Simulates what the OBD-II adapter would actually read off the car's ECUs
// during a scan. In production this comes from the Bluetooth/OBD adapter
// SDK. It deliberately mixes codes that exist in DTC_DATABASE with codes
// that don't (a rare code and a JAC-specific code) to exercise both paths
// of the hybrid system on every scan.
const RAW_SCAN_CODES = [
  'P0300',
  'P0301',
  'P0171',
  'P0420',
  'P0217',
  'P0562',
  'P245A', // not in local dictionary → AI fallback
  'P1CDA', // JAC-specific code, not in local dictionary → AI fallback
];

// Mocked Mode $06 misfire counters — 4 cylinders, threshold-based pass/fail.
const MISFIRE_THRESHOLD = 2;
const MISFIRE_COUNTERS = [
  { cylinder: 1, count: 0 },
  { cylinder: 2, count: 1 },
  { cylinder: 3, count: 4 },
  { cylinder: 4, count: 0 },
];

const EMISSIONS_READINESS = [
  { key: 'misfire', labelEn: 'Misfire Monitor', labelAr: 'مراقبة التفتيش', icon: 'pulse-outline', ready: true },
  { key: 'fuel', labelEn: 'Fuel System', labelAr: 'نظام الوقود', icon: 'water-outline', ready: true },
  { key: 'catalyst', labelEn: 'Catalyst', labelAr: 'الكاتاليزر', icon: 'filter-outline', ready: true },
  { key: 'evap', labelEn: 'EVAP System', labelAr: 'نظام التبخر EVAP', icon: 'cloud-outline', ready: false },
  { key: 'o2sensor', labelEn: 'Oxygen Sensor', labelAr: 'حساس الأكسجين', icon: 'analytics-outline', ready: true },
];

export default function DiagnosticsScreen() {
  const { isAr } = useLang();
  const dir = isAr ? 'row-reverse' : 'row';

  const [activeView, setActiveView] = useState<ViewMode>('SCANNER');
  const [isScanning, setIsScanning] = useState(false);
  const [faults, setFaults] = useState<FaultItem[] | null>(null);

  const [adviceModalVisible, setAdviceModalVisible] = useState(false);
  const [currentAdvice, setCurrentAdvice] = useState<AdviceContent>({
    title: '',
    immediateGuidance: '',
    steps: [],
  });

  // Bumped every time a new scan starts. AI responses carry the scan id
  // they were requested under; if it no longer matches scanIdRef.current
  // when the response arrives, a newer scan has since started and the
  // response is stale — it's ignored instead of overwriting the current
  // list. Without this, tapping "Scan" again while an AI fallback request
  // from the previous scan is still in flight could let that old response
  // land on top of the new scan's results.
  const scanIdRef = useRef(0);

  // --- Hybrid resolution -----------------------------------------------
  // 1. LOCAL CHECK: look the code up in DTC_DATABASE first — this is
  //    instant and works fully offline.
  // 2. AI FALLBACK: if the code isn't in the local dictionary, place a
  //    "loading" placeholder card immediately (so the UI never hides or
  //    silently drops an unknown code) and kick off a Gemini request in
  //    the background. When it resolves, that one card is updated in
  //    place; other cards are unaffected.
  const resolveFaultCode = async (code: string, scanId: number) => {
    try {
      const ai = await fetchDTCFromAI(code);
      if (scanIdRef.current !== scanId) return; // a newer scan superseded this request
      setFaults((prev) => prev?.map((f) => (f.code === code ? { ...ai, source: 'AI', status: 'ready' } : f)) ?? prev);
    } catch (err) {
      console.warn(`AI fallback failed for ${code}:`, err);
      if (scanIdRef.current !== scanId) return; // a newer scan superseded this request
      setFaults((prev) => prev?.map((f) => (f.code === code ? { ...f, status: 'error' } : f)) ?? prev);
    }
  };

  const handleScan = async () => {
    const thisScan = ++scanIdRef.current;

    setIsScanning(true);
    setFaults(null);

    // Simulates the time the adapter takes to pull stored codes off the bus.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // If another scan started while we were "reading" the bus, bail out —
    // that newer scan already owns the screen's state from here on.
    if (scanIdRef.current !== thisScan) return;

    const initialFaults: FaultItem[] = RAW_SCAN_CODES.map((code) => {
      const local = DTC_DATABASE[code];
      if (local) {
        return { ...local, source: 'LOCAL', status: 'ready' };
      }
      // Unknown to the local dictionary — shown right away as a loading
      // card rather than being hidden, then resolved via Gemini below.
      return { code, source: 'AI', status: 'loading' };
    });

    setFaults(initialFaults);
    setIsScanning(false);

    // Fire off AI resolution for every code that missed the local lookup.
    // Each one resolves independently so a slow/failed code never blocks
    // the rest of the list.
    initialFaults.filter((f) => f.status === 'loading').forEach((f) => resolveFaultCode(f.code, thisScan));
  };

  const handleClear = () => {
    Alert.alert(isAr ? 'مسح الأعطال' : 'Clear Faults', isAr ? 'هل أنت متأكد؟' : 'Are you sure?', [
      { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
      { text: isAr ? 'مسح' : 'Clear', style: 'destructive', onPress: () => setFaults([]) },
    ]);
  };

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

  const faultCount = faults?.length ?? 0;
  const stopCount = useMemo(() => faults?.filter((f) => f.urgency === 'STOP').length ?? 0, [faults]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={[styles.header, { flexDirection: dir }]}>
        <Text style={[styles.headerTitle, { textAlign: isAr ? 'right' : 'left' }]}>
          {isAr ? 'تشخيص أعطال OBD-II' : 'OBD-II Diagnostics'}
        </Text>
        <View style={[styles.connectionStatus, { flexDirection: dir }]}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>ARC 103 · {isAr ? 'متصل' : 'Connected'}</Text>
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
            <LiveCard
              icon="battery-charging-outline"
              tone="success"
              value="14.2"
              unit="V"
              labelEn="Battery Voltage"
              labelAr="جهد البطارية"
              statusEn="Normal"
              statusAr="طبيعي"
              isAr={isAr}
              dir={dir}
            />
            <LiveCard
              icon="thermometer-outline"
              tone="success"
              value="88"
              unit="°C"
              labelEn="Coolant Temp"
              labelAr="حرارة المحرك"
              statusEn="Normal"
              statusAr="طبيعي"
              isAr={isAr}
              dir={dir}
            />
            <LiveCard
              icon="speedometer-outline"
              tone="accent"
              value="850"
              unit="RPM"
              labelEn="Engine Speed"
              labelAr="سرعة المحرك"
              statusEn="Normal"
              statusAr="طبيعي"
              isAr={isAr}
              dir={dir}
            />
            <LiveCard
              icon="flash-outline"
              tone="accent"
              value="14.5"
              unit="g/s"
              labelEn="MAF Air Flow"
              labelAr="تدفق الهواء"
              statusEn="Normal"
              statusAr="طبيعي"
              isAr={isAr}
              dir={dir}
            />
            <LiveCard
              icon="analytics-outline"
              tone="warning"
              value="0.65"
              unit="V"
              labelEn="O2 Sensor"
              labelAr="حساس الأكسجين"
              statusEn="Checking"
              statusAr="فحص"
              isAr={isAr}
              dir={dir}
              onPress={() =>
                openSensorAdvice(
                  'O2 Sensor — Checking',
                  'حساس الأكسجين — قيد الفحص',
                  'No need to stop; drive normally while the module finishes evaluating the sensor over the next few minutes of driving.',
                  'مفيش داعي تقف؛ كمل السواقة عادي لحد ما الكمبيوتر يخلص تقييم الحساس خلال كذا دقيقة سواقة.',
                  [
                    'If the reading stays flat near 0.65V for more than a full drive cycle, have the O2 sensor tested.',
                    'Check the sensor connector for corrosion or a loose pin.',
                    'Inspect for an exhaust leak upstream of the sensor.',
                  ],
                  [
                    'لو القراءة فضلت ثابتة حوالين 0.65V لأكتر من دورة تشغيل كاملة، اطلب فحص الحساس.',
                    'افحص وصلة الحساس من الصدأ أو الفك.',
                    'افحص أي تسريب في العادم قبل الحساس.',
                  ]
                )
              }
            />
            <LiveCard
              icon="options-outline"
              tone="success"
              value="+2.3"
              unit="%"
              labelEn="Fuel Trim"
              labelAr="ضبط الوقود"
              statusEn="Normal"
              statusAr="طبيعي"
              isAr={isAr}
              dir={dir}
            />
          </View>
        )}

        {activeView === 'READINESS' && (
          <View>
            <Text style={[styles.sectionHeading, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'جاهزية الانبعاثات' : 'Emissions Readiness'}
            </Text>
            <View style={styles.glassCard}>
              {EMISSIONS_READINESS.map((item, i) => (
                <View
                  key={item.key}
                  style={[
                    styles.readinessRow,
                    { flexDirection: dir },
                    i === EMISSIONS_READINESS.length - 1 && styles.readinessRowLast,
                  ]}
                >
                  <View style={[styles.readinessLeft, { flexDirection: dir }]}>
                    <View style={[styles.readinessIconWrap, { backgroundColor: item.ready ? COLORS.successDim : COLORS.warningDim }]}>
                      <Ionicons name={item.icon as any} size={16} color={item.ready ? COLORS.success : COLORS.warning} />
                    </View>
                    <Text style={styles.readinessLabel}>{isAr ? item.labelAr : item.labelEn}</Text>
                  </View>
                  <View style={[styles.readinessStatusPill, { backgroundColor: item.ready ? COLORS.successDim : COLORS.warningDim, flexDirection: dir }]}>
                    <Ionicons
                      name={item.ready ? 'checkmark-circle' : 'time-outline'}
                      size={14}
                      color={item.ready ? COLORS.success : COLORS.warning}
                    />
                    <Text style={[styles.readinessStatusText, { color: item.ready ? COLORS.success : COLORS.warning }]}>
                      {item.ready ? (isAr ? 'جاهز' : 'Ready') : (isAr ? 'غير جاهز' : 'Not Ready')}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            <Text style={[styles.sectionHeading, { textAlign: isAr ? 'right' : 'left', marginTop: 24 }]}>
              {isAr ? 'عدادات التفتيش — Mode $06' : 'Misfire Counters — Mode $06'}
            </Text>
            <Text style={[styles.sectionSubheading, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr
                ? 'عدد أحداث التفتيش المسجلة لكل سلندر منذ آخر مسح للأعطال'
                : 'Recorded misfire events per cylinder since the last fault clear'}
            </Text>
            <View style={styles.misfireGrid}>
              {MISFIRE_COUNTERS.map((m) => {
                const pass = m.count <= MISFIRE_THRESHOLD;
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

/* ----------------------------- Segmented Tabs ---------------------------- */

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

/* ------------------------------- Fault Card ------------------------------ */

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
  // --- Loading state: AI is still resolving a code not found locally ---
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

  // --- Error state: AI request failed (network/API issue) ---
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

  // --- Ready state: fully resolved, whether from local dictionary or AI ---
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

/* -------------------------------- Live Card ------------------------------- */

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
}: {
  icon: any;
  tone: 'success' | 'warning' | 'accent';
  value: string;
  unit: string;
  labelEn: string;
  labelAr: string;
  statusEn: string;
  statusAr: string;
  isAr: boolean;
  dir: 'row' | 'row-reverse';
  onPress?: () => void;
}) {
  const isNormal = tone === 'success';
  const color = tone === 'success' ? COLORS.success : tone === 'warning' ? COLORS.warning : COLORS.accent;
  const dimColor = tone === 'success' ? COLORS.successDim : tone === 'warning' ? COLORS.warningDim : COLORS.accentDim;

  const CardInner = (
    <>
      <View style={[styles.liveCardTop, { flexDirection: dir }]}>
        <View style={styles.liveIconWrap}>
          <Ionicons name={icon} size={18} color={color} />
        </View>
        <View style={[styles.statusBadge, { backgroundColor: dimColor, flexDirection: dir }]}>
          <View style={[styles.miniDot, { backgroundColor: color }]} />
          <Text style={[styles.statusBadgeText, { color }]}>{isAr ? statusAr : statusEn}</Text>
        </View>
      </View>
      <Text style={[styles.liveValue, { textAlign: isAr ? 'right' : 'left', color: isNormal ? COLORS.textPrimary : color }]}>
        {value} <Text style={styles.liveUnit}>{unit}</Text>
      </Text>
      <Text style={[styles.liveLabel, { textAlign: isAr ? 'right' : 'left' }]}>{isAr ? labelAr : labelEn}</Text>
      {!isNormal && onPress && (
        <View style={[styles.liveCardHint, { flexDirection: dir }]}>
          <Ionicons name="information-circle-outline" size={12} color={COLORS.textTertiary} />
          <Text style={styles.liveCardHintText}>{isAr ? 'اضغط للتفاصيل' : 'Tap for details'}</Text>
        </View>
      )}
    </>
  );

  if (!isNormal && onPress) {
    return (
      <TouchableOpacity style={[styles.liveCard, styles.liveCardTappable]} onPress={onPress} activeOpacity={0.8}>
        {CardInner}
      </TouchableOpacity>
    );
  }
  return <View style={styles.liveCard}>{CardInner}</View>;
}

/* ------------------------------- Advice Modal ------------------------------ */

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

/* ---------------------------------- Styles --------------------------------- */

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
  statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.success },
  statusText: { color: COLORS.success, fontSize: 11, fontWeight: '700' },

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
  modalUrgencyPill: { alignSelf: 'flex-start', marginBottom: 14 },

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
