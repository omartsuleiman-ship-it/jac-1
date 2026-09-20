import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { router, useLocalSearchParams } from 'expo-router'; // 👈 استدعاء الـ SearchParams
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLang } from './_layout';

const COLORS = {
  background: '#000000',
  card: '#050505',
  cardBorder: '#1A1A1A',
  accent: '#00D9C6',
  accentSoft: 'rgba(0, 217, 198, 0.12)',
  warning: '#FFB74D',
  warningSoft: 'rgba(255, 183, 77, 0.12)',
  danger: '#FF6B5E',
  dangerSoft: 'rgba(255, 107, 94, 0.12)',
  textPrimary: '#F5F6F7',
  textSecondary: '#8A9199',
  trackBg: '#0A0A0A',
  inputBg: '#0A0A0A',
  modalBg: '#000000',
  overlay: 'rgba(0,0,0,0.6)',
};


type MaintenanceUnit = 'km' | 'months';

interface MaintenanceConfig {
  id: string;
  labelEn: string;
  labelAr: string;
  icon: keyof typeof Ionicons.glyphMap;
  unit: MaintenanceUnit;
  options: number[];
  allowCustom: boolean;
}

interface MaintenanceRecord {
  itemId: string;
  lifespanValue: number; 
  loggedAtOdometer: number; 
  loggedAtDate: string; 
  notificationThreshold: number; 
  notificationId?: string; 
}

type RecordsMap = Record<string, MaintenanceRecord>;

const MAINTENANCE_CONFIG: MaintenanceConfig[] = [
  { id: 'engine_oil', labelEn: 'Engine Oil', labelAr: 'زيت المحرك', icon: 'water-outline', unit: 'km', options: [3000, 5000, 10000], allowCustom: true },
  { id: 'transmission_fluid', labelEn: 'Transmission Fluid', labelAr: 'زيت الفتيس', icon: 'settings-outline', unit: 'km', options: [40000, 60000, 80000], allowCustom: true },
  { id: 'timing_belt', labelEn: 'Timing Belt', labelAr: 'سير الكاتينة', icon: 'sync-outline', unit: 'km', options: [50000, 80000], allowCustom: true },
  { id: 'spark_plugs', labelEn: 'Spark Plugs', labelAr: 'بوجيهات', icon: 'flash-outline', unit: 'km', options: [20000, 40000, 100000], allowCustom: true },
  { id: 'filters', labelEn: 'Filters (Air/AC)', labelAr: 'فلاتر (هواء/تكييف)', icon: 'filter-outline', unit: 'km', options: [10000, 20000], allowCustom: true },
  { id: 'brake_pads', labelEn: 'Brake Pads', labelAr: 'تيل الفرامل', icon: 'disc-outline', unit: 'km', options: [30000], allowCustom: true },
  { id: 'battery', labelEn: 'Battery', labelAr: 'البطارية', icon: 'battery-charging-outline', unit: 'months', options: [12, 24], allowCustom: true },
];

const STORAGE_KEY_RECORDS = '@car_app/maintenance_records_v1';
const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';
const STORAGE_KEY_ODOMETER_NOTIF = '@car_app/odometer_reminder_id'; // 👈 مفتاح جديد للإشعار
const STORAGE_KEY_ODOMETER_UPDATED_AT = '@car_app/odometer_updated_at_v1';

const ASSUMED_DAILY_KM = 40;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface ItemStatus {
  logged: boolean;
  percentRemaining: number;
  remainingLabel: string;
  overdue: boolean;
}

function getItemStatus(
  item: MaintenanceConfig,
  record: MaintenanceRecord | undefined,
  currentOdometer: number,
  isAr: boolean
): ItemStatus {
  if (!record) {
    return { logged: false, percentRemaining: 0, remainingLabel: isAr ? 'لم يتم التسجيل بعد' : 'Not logged yet', overdue: false };
  }

  if (item.unit === 'km') {
    const consumed = currentOdometer - record.loggedAtOdometer;
    const remaining = record.lifespanValue - consumed;
    const percentRemaining = clamp((remaining / record.lifespanValue) * 100, 0, 100);
    const overdue = remaining <= 0;
    const remainingLabel = overdue
      ? (isAr ? `متأخر بـ ${Math.abs(Math.round(remaining)).toLocaleString()} كم` : `Overdue by ${Math.abs(Math.round(remaining)).toLocaleString()} km`)
      : (isAr ? `متبقي ${Math.round(remaining).toLocaleString()} كم` : `${Math.round(remaining).toLocaleString()} km remaining`);
    return { logged: true, percentRemaining, remainingLabel, overdue };
  }

  const loggedDate = new Date(record.loggedAtDate);
  const now = new Date();
  const monthsElapsed =
    (now.getFullYear() - loggedDate.getFullYear()) * 12 + (now.getMonth() - loggedDate.getMonth());
  const remaining = record.lifespanValue - monthsElapsed;
  const percentRemaining = clamp((remaining / record.lifespanValue) * 100, 0, 100);
  const overdue = remaining <= 0;
  const remainingLabel = overdue
    ? (isAr ? `متأخر بـ ${Math.abs(remaining)} شهر` : `Overdue by ${Math.abs(remaining)} month(s)`)
    : (isAr ? `متبقي ${remaining} شهر` : `${remaining} month(s) remaining`);
  return { logged: true, percentRemaining, remainingLabel, overdue };
}

function getStatusColor(status: ItemStatus) {
  if (!status.logged) return COLORS.textSecondary;
  if (status.overdue || status.percentRemaining <= 15) return COLORS.danger;
  if (status.percentRemaining <= 40) return COLORS.warning;
  return COLORS.accent;
}

async function registerForMaintenanceNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('maintenance-reminders', {
      name: 'Maintenance Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: COLORS.accent,
    });
  }
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  return finalStatus === 'granted';
}

async function scheduleMaintenanceNotification(
  itemId: string,
  itemName: string,
  estimatedDueDate: Date
): Promise<string | undefined> {
  try {
    const secondsUntilDue = Math.max(5, Math.round((estimatedDueDate.getTime() - Date.now()) / 1000));
    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Maintenance Reminder 🔧',
        body: `${itemName} is approaching its service threshold. Time for a check-up!`,
        data: { itemId },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: secondsUntilDue,
        channelId: Platform.OS === 'android' ? 'maintenance-reminders' : undefined,
      },
    });
    return notificationId;
  } catch (error) {
    return undefined;
  }
}

async function cancelMaintenanceNotification(notificationId?: string) {
  if (!notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  } catch {}
}

function estimateDueDate(item: MaintenanceConfig, record: MaintenanceRecord): Date {
  const now = new Date();
  if (item.unit === 'km') {
    const remaining = record.lifespanValue;
    const kmUntilNotify = Math.max(remaining - record.notificationThreshold, 0);
    const daysUntilNotify = kmUntilNotify / ASSUMED_DAILY_KM;
    const due = new Date(now);
    due.setDate(due.getDate() + Math.round(daysUntilNotify));
    return due;
  }
  const monthsUntilNotify = Math.max(record.lifespanValue - record.notificationThreshold, 0);
  const due = new Date(now);
  due.setMonth(due.getMonth() + monthsUntilNotify);
  return due;
}

export default function MaintenanceScreen() {
  const { isAr } = useLang();
  const params = useLocalSearchParams(); // 👈 عشان نلقط اللينك من الإشعار

  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<RecordsMap>({});
  const [currentOdometer, setCurrentOdometer] = useState(0);

  const [modalVisible, setModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MaintenanceConfig | null>(null);

  const [odometerModalVisible, setOdometerModalVisible] = useState(false);
  const [odometerModalInput, setOdometerModalInput] = useState('');
  const [selectedLifespan, setSelectedLifespan] = useState<number | 'custom' | null>(null);
  const [customLifespanInput, setCustomLifespanInput] = useState('');
  const [thresholdInput, setThresholdInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [odometerUpdatedAt, setOdometerUpdatedAt] = useState<number | null>(null);

  const responseListener = useRef<Notifications.EventSubscription | null>(null);

  // 🚀 NEW: دالة برمجة إشعار العداد الذكية (7 أيام للنجاح، 1 يوم للتجاهل)
  const scheduleOdometerReminder = async (days: number) => {
    try {
      const storedNotifId = await AsyncStorage.getItem(STORAGE_KEY_ODOMETER_NOTIF);
      if (storedNotifId) {
        await Notifications.cancelScheduledNotificationAsync(storedNotifId);
      }
      const seconds = days * 24 * 60 * 60; // نحول الأيام لثواني
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: isAr ? 'تحديث العداد 🚗' : 'Odometer Update 🚗',
          body: isAr 
            ? 'حان الوقت لتحديث قراءة عداد المسافات لضمان دقة مواعيد الصيانة.'
            : 'Time to manually update your odometer reading to keep maintenance schedules accurate.',
          data: { action: 'update_odometer' },
          sound: 'default',
          priority: Notifications.AndroidNotificationPriority.HIGH,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: seconds,
          channelId: Platform.OS === 'android' ? 'maintenance-reminders' : undefined,
        },
      });
      await AsyncStorage.setItem(STORAGE_KEY_ODOMETER_NOTIF, notificationId);
    } catch (error) {
      console.warn('Failed to schedule odometer reminder', error);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const [storedRecords, storedOdometer, storedUpdatedAt] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY_RECORDS),
          AsyncStorage.getItem(STORAGE_KEY_ODOMETER),
          AsyncStorage.getItem(STORAGE_KEY_ODOMETER_UPDATED_AT),
        ]);
        if (storedRecords) setRecords(JSON.parse(storedRecords));
        if (storedOdometer) setCurrentOdometer(JSON.parse(storedOdometer));
        if (storedUpdatedAt) setOdometerUpdatedAt(parseInt(storedUpdatedAt, 10));
      } catch (error) {
      } finally {
        setLoading(false);
      }
    })();

    (async () => {
      await registerForMaintenanceNotifications();
    })();

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { itemId?: string };
      if (data?.itemId) {
        router.replace('/(tabs)/maintenance');
        setPendingItemId(data.itemId);
      }
    });

    return () => {
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, []);

  // 🚀 NEW: لو ضغط على إشعار العداد، نفتح الـ Modal فوراً
  useEffect(() => {
    if (params.action === 'update_odometer' && !loading) {
      openOdometerModal();
    }
  }, [params.action, loading]);

  useEffect(() => {
    if (pendingItemId && !loading) {
      const targetItem = MAINTENANCE_CONFIG.find((cfg) => cfg.id === pendingItemId);
      if (targetItem) {
        openLogModal(targetItem);
        setPendingItemId(null);
      }
    }
  }, [pendingItemId, loading]);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        try {
          const [storedOdometer, storedUpdatedAt] = await Promise.all([
            AsyncStorage.getItem(STORAGE_KEY_ODOMETER),
            AsyncStorage.getItem(STORAGE_KEY_ODOMETER_UPDATED_AT),
          ]);
          if (storedOdometer) setCurrentOdometer(JSON.parse(storedOdometer));
          if (storedUpdatedAt) setOdometerUpdatedAt(parseInt(storedUpdatedAt, 10));
        } catch (error) {}
      })();
    }, [])
  );

  const persistRecords = useCallback(async (next: RecordsMap) => {
    setRecords(next);
    try {
      await AsyncStorage.setItem(STORAGE_KEY_RECORDS, JSON.stringify(next));
    } catch (error) {}
  }, []);

  const persistOdometer = useCallback(async (value: number) => {
    setCurrentOdometer(value);
    try {
      await AsyncStorage.setItem(STORAGE_KEY_ODOMETER, JSON.stringify(value));
      await AsyncStorage.setItem(STORAGE_KEY_ODOMETER_UPDATED_AT, Date.now().toString());
    } catch (error) {}
  }, []);

  const openLogModal = (item: MaintenanceConfig) => {
    const existing = records[item.id];
    setSelectedItem(item);
    setSelectedLifespan(existing?.lifespanValue ?? item.options[0]);
    setCustomLifespanInput('');
    setThresholdInput(existing ? existing.notificationThreshold.toString() : '');
    setModalVisible(true);
  };

  const closeModal = () => {
    setModalVisible(false);
    setSelectedItem(null);
  };

  const openOdometerModal = () => {
    // نقرّب لأقرب كيلومتر صحيح — currentOdometer ممكن يحمل كسور عشرية كتير
    // لما يكون بييتحدث تلقائي من حساب الـ OBD في تابة الوقود، ومحدش بيكتب
    // رقم بـ 20 رقم عشري يدويًا.
    setOdometerModalInput(Math.round(currentOdometer).toString());
    setOdometerModalVisible(true);
  };

  // 🚀 NEW: لوجيك القفل. لو savedNewValue بـ false (يعني تجاهل)، يرجع كمان يوم.
  const closeOdometerModal = (savedNewValue: boolean = false) => {
    setOdometerModalVisible(false);
    scheduleOdometerReminder(savedNewValue ? 7 : 1);
  };

  const handleSaveOdometer = async () => {
    const value = parseInt(odometerModalInput, 10);
    if (isNaN(value) || value < 0) {
      Alert.alert(
        isAr ? 'إدخال خاطئ' : 'Invalid Input',
        isAr ? 'الرجاء إدخال قراءة عداد صحيحة.' : 'Please enter a valid odometer reading.'
      );
      return;
    }
    // 🚀 NEW: لو داس حفظ على نفس الرقم القديم بالظبط يعتبر تجاهل (هيجي تاني يوم)
    if (value === currentOdometer) {
      closeOdometerModal(false); 
      return;
    }
    
    if (value < currentOdometer) {
      Alert.alert(
        isAr ? 'تأكيد' : 'Confirm',
        isAr
          ? `القراءة الجديدة (${value.toLocaleString()}) أقل من القراءة الحالية (${currentOdometer.toLocaleString()}). متابعة؟`
          : `The new reading (${value.toLocaleString()}) is lower than the current one (${currentOdometer.toLocaleString()}). Continue anyway?`,
        [
          { text: isAr ? 'إلغاء' : 'Cancel', style: 'cancel' },
          {
            text: isAr ? 'متابعة' : 'Continue',
            style: 'destructive',
            onPress: async () => {
              await persistOdometer(value);
              closeOdometerModal(true); // 👈 قيمة جديدة، نام 7 أيام
            },
          },
        ]
      );
      return;
    }
    
    await persistOdometer(value);
    closeOdometerModal(true); // 👈 قيمة جديدة، نام 7 أيام
  };

  const handleSaveService = async () => {
    if (!selectedItem) return;

    const lifespanValue =
      selectedLifespan === 'custom' ? parseInt(customLifespanInput, 10) : selectedLifespan;
    const thresholdValue = parseInt(thresholdInput, 10);

    if (!lifespanValue || isNaN(lifespanValue) || lifespanValue <= 0) {
      Alert.alert(isAr ? 'إدخال خاطئ' : 'Invalid Input', isAr ? 'الرجاء اختيار عمر افتراضي صحيح.' : 'Please choose or enter a valid lifespan.');
      return;
    }
    if (isNaN(thresholdValue) || thresholdValue < 0 || thresholdValue >= lifespanValue) {
      Alert.alert(
        isAr ? 'حد تنبيه خاطئ' : 'Invalid Threshold',
        isAr ? `يجب أن يكون الحد رقم إيجابي أقل من العمر الافتراضي (${lifespanValue}).` : `Threshold must be a positive number smaller than the lifespan (${lifespanValue}).`
      );
      return;
    }

    setSaving(true);
    try {
      const existingRecord = records[selectedItem.id];
      await cancelMaintenanceNotification(existingRecord?.notificationId);

      const newRecord: MaintenanceRecord = {
        itemId: selectedItem.id,
        lifespanValue,
        loggedAtOdometer: currentOdometer,
        loggedAtDate: new Date().toISOString(),
        notificationThreshold: thresholdValue,
      };

      const estimatedDue = estimateDueDate(selectedItem, newRecord);
      const notificationId = await scheduleMaintenanceNotification(
        selectedItem.id,
        isAr ? selectedItem.labelAr : selectedItem.labelEn,
        estimatedDue
      );
      newRecord.notificationId = notificationId;

      const nextRecords: RecordsMap = { ...records, [selectedItem.id]: newRecord };
      await persistRecords(nextRecords);

      closeModal();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.safeArea, styles.loadingContainer]}>
        <ActivityIndicator color={COLORS.accent} size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <TouchableOpacity
          style={[styles.headerCard, { flexDirection: isAr ? 'row-reverse' : 'row' }]}
          onPress={openOdometerModal}
          activeOpacity={0.7}
        >
          <Ionicons name="speedometer-outline" size={22} color={COLORS.accent} />
          <View style={{ marginHorizontal: 10, flex: 1 }}>
            <Text style={[styles.headerTitle, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr ? 'تحديث قراءة العداد' : 'Update Odometer Reading'}
            </Text>
            <Text style={[styles.headerSubtitle, { textAlign: isAr ? 'right' : 'left' }]}>
              {isAr
                ? `${currentOdometer.toLocaleString()} كم — ${
                    odometerUpdatedAt
                      ? `آخر تحديث قبل ${Math.max(0, Math.floor((Date.now() - odometerUpdatedAt) / 86400000))} يوم`
                      : 'لم يُسجَّل تاريخ تحديث بعد'
                  }`
                : `${currentOdometer.toLocaleString()} km — ${
                    odometerUpdatedAt
                      ? `last updated ${Math.max(0, Math.floor((Date.now() - odometerUpdatedAt) / 86400000))} day(s) ago`
                      : 'no update date recorded yet'
                  }`}
            </Text>
          </View>
          <Ionicons name="create-outline" size={18} color={COLORS.textSecondary} />
        </TouchableOpacity>

        {MAINTENANCE_CONFIG.map((item) => {
          const record = records[item.id];
          const status = getItemStatus(item, record, currentOdometer, isAr);
          const statusColor = getStatusColor(status);

          return (
            <TouchableOpacity
              key={item.id}
              style={styles.card}
              activeOpacity={0.8}
              onPress={() => openLogModal(item)}
            >
              <View style={[styles.cardTopRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                <View style={styles.iconCircle}>
                  <Ionicons name={item.icon} size={20} color={COLORS.accent} />
                </View>
                <View style={{ flex: 1, marginHorizontal: 12 }}>
                  <Text style={[styles.itemLabel, { textAlign: isAr ? 'right' : 'left' }]}>
                    {isAr ? item.labelAr : item.labelEn}
                  </Text>
                  <Text style={[styles.itemSubtext, { textAlign: isAr ? 'right' : 'left' }]}>
                    {status.remainingLabel}
                  </Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: `${statusColor}22` }]}>
                  <Text style={[styles.statusBadgeText, { color: statusColor }]}>
                    {!status.logged ? (isAr ? 'سجل الآن' : 'LOG NOW') : status.overdue ? (isAr ? 'متأخر' : 'OVERDUE') : `${Math.round(status.percentRemaining)}%`}
                  </Text>
                </View>
              </View>

              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${status.logged ? status.percentRemaining : 0}%`, backgroundColor: statusColor },
                  ]}
                />
              </View>

              <View style={[styles.cardFooterRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                <Ionicons name="create-outline" size={13} color={COLORS.textSecondary} />
                <Text style={styles.cardFooterText}>{isAr ? 'اضغط لتسجيل صيانة' : 'Tap to log service'}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* ------------------------------------------------------------------ */}
      {/* LOG SERVICE MODAL */}
      {/* ------------------------------------------------------------------ */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={closeModal}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={styles.modalOverlay} onPress={closeModal}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalHandle} />

              {selectedItem && (
                <ScrollView showsVerticalScrollIndicator={false}>
                  <View style={[styles.modalHeaderRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                    <View style={styles.iconCircle}>
                      <Ionicons name={selectedItem.icon} size={20} color={COLORS.accent} />
                    </View>
                    <Text style={[styles.modalTitle, { textAlign: isAr ? 'right' : 'left' }]}>
                      {isAr ? `تسجيل صيانة — ${selectedItem.labelAr}` : `Log Service — ${selectedItem.labelEn}`}
                    </Text>
                    <TouchableOpacity onPress={closeModal} hitSlop={10}>
                      <Ionicons name="close" size={22} color={COLORS.textSecondary} />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.fieldGroup}>
                    <Text style={[styles.fieldLabel, { textAlign: isAr ? 'right' : 'left' }]}>
                      {isAr ? `العمر الافتراضي للقطعة (${selectedItem.unit === 'km' ? 'كم' : 'شهر'})` : `Part Lifespan (${selectedItem.unit === 'km' ? 'km' : 'months'})`}
                    </Text>
                    <View style={[styles.chipRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                      {selectedItem.options.map((option) => {
                        const isActive = selectedLifespan === option;
                        return (
                          <TouchableOpacity
                            key={option}
                            style={[styles.chip, isActive && styles.chipActive]}
                            onPress={() => setSelectedLifespan(option)}
                          >
                            <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                              {option.toLocaleString()}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                      {selectedItem.allowCustom && (
                        <TouchableOpacity
                          style={[styles.chip, selectedLifespan === 'custom' && styles.chipActive]}
                          onPress={() => setSelectedLifespan('custom')}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              selectedLifespan === 'custom' && styles.chipTextActive,
                            ]}
                          >
                            {isAr ? 'مخصص' : 'Custom'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {selectedLifespan === 'custom' && (
                      <TextInput
                        style={[styles.input, { marginTop: 10, textAlign: isAr ? 'right' : 'left' }]}
                        keyboardType="numeric"
                        placeholder={selectedItem.unit === 'km' ? (isAr ? 'مثال: 45000' : 'e.g. 45000') : (isAr ? 'مثال: 18' : 'e.g. 18')}
                        placeholderTextColor={COLORS.textSecondary}
                        value={customLifespanInput}
                        onChangeText={setCustomLifespanInput}
                      />
                    )}
                  </View>

                  <View style={styles.fieldGroup}>
                    <Text style={[styles.fieldLabel, { textAlign: isAr ? 'right' : 'left' }]}>
                      {isAr ? 'حد التنبيه' : 'Notification Threshold'}
                    </Text>
                    <Text style={[styles.fieldHint, { textAlign: isAr ? 'right' : 'left' }]}>
                      {isAr ? 'تنبيهي قبل ' : 'Notify me '}
                      <Text style={{ color: COLORS.accent, fontWeight: '700' }}>
                        [{thresholdInput || 'X'}]
                      </Text>{' '}
                      {isAr ? (selectedItem.unit === 'km' ? 'كم من الانتهاء' : 'شهر من الانتهاء') : `${selectedItem.unit} before it expires`}
                    </Text>
                    <TextInput
                      style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]}
                      keyboardType="numeric"
                      placeholder={selectedItem.unit === 'km' ? (isAr ? 'مثال: 1000' : 'e.g. 1000') : (isAr ? 'مثال: 1' : 'e.g. 1')}
                      placeholderTextColor={COLORS.textSecondary}
                      value={thresholdInput}
                      onChangeText={setThresholdInput}
                    />
                  </View>

                  <TouchableOpacity
                    style={[styles.saveButton, saving && styles.saveButtonDisabled, { flexDirection: isAr ? 'row-reverse' : 'row' }]}
                    onPress={handleSaveService}
                    disabled={saving}
                    activeOpacity={0.85}
                  >
                    {saving ? (
                      <ActivityIndicator color="#0B0D10" size="small" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle-outline" size={19} color="#0B0D10" />
                        <Text style={styles.saveButtonText}>
                          {isAr ? 'حفظ وتفعيل التنبيه' : 'Save & Schedule Reminder'}
                        </Text>
                      </>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              )}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* ------------------------------------------------------------------ */}
      {/* MASTER ODOMETER MODAL */}
      {/* ------------------------------------------------------------------ */}
      {/* 🚀 NEW: استبدال أي غلق للـ Modal بالـ closeOdometerModal(false) عشان يفهم إنه تجاهل */}
      <Modal visible={odometerModalVisible} animationType="slide" transparent onRequestClose={() => closeOdometerModal(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.modalOverlay} onPress={() => closeOdometerModal(false)}>
            <Pressable style={styles.modalSheet} onPress={(e) => e.stopPropagation()}>
              <View style={styles.modalHandle} />
              <View style={[styles.modalHeaderRow, { flexDirection: isAr ? 'row-reverse' : 'row' }]}>
                <View style={styles.iconCircle}>
                  <Ionicons name="speedometer-outline" size={20} color={COLORS.accent} />
                </View>
                <Text style={[styles.modalTitle, { textAlign: isAr ? 'right' : 'left' }]}>
                  {isAr ? 'تحديث قراءة العداد' : 'Update Odometer Reading'}
                </Text>
                <TouchableOpacity onPress={() => closeOdometerModal(false)} hitSlop={10}>
                  <Ionicons name="close" size={22} color={COLORS.textSecondary} />
                </TouchableOpacity>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { textAlign: isAr ? 'right' : 'left' }]}>
                  {isAr ? 'قراءة العداد الحالية (كم)' : 'Current Odometer Reading (km)'}
                </Text>
                <Text style={[styles.fieldHint, { textAlign: isAr ? 'right' : 'left' }]}>
                  {isAr
                    ? 'هذه القراءة الرئيسية تُستخدم تلقائياً في جميع بطاقات الصيانة.'
                    : 'This master reading automatically drives every maintenance card.'}
                </Text>
                <TextInput
                  style={[styles.input, { textAlign: isAr ? 'right' : 'left' }]}
                  keyboardType="numeric"
                  placeholder={isAr ? 'مثال: 45230' : 'e.g. 45230'}
                  placeholderTextColor={COLORS.textSecondary}
                  value={odometerModalInput}
                  onChangeText={setOdometerModalInput}
                  autoFocus={true} // 👈 دي اللي بتنطط الكيبورد أول ما الشاشة تفتح
                />
              </View>

              <TouchableOpacity
                style={[styles.saveButton, { flexDirection: isAr ? 'row-reverse' : 'row' }]}
                onPress={handleSaveOdometer}
                activeOpacity={0.85}
              >
                <Ionicons name="checkmark-circle-outline" size={19} color="#0B0D10" />
                <Text style={styles.saveButtonText}>{isAr ? 'حفظ القراءة' : 'Save Reading'}</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, paddingBottom: 40 },
  headerCard: {
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  headerTitle: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '700' },
  headerSubtitle: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  cardTopRow: { alignItems: 'center', marginBottom: 12 },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0, 217, 198, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemLabel: { color: COLORS.textPrimary, fontSize: 15, fontWeight: '700' },
  itemSubtext: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusBadgeText: { fontSize: 11, fontWeight: '700' },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.trackBg,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: 4 },
  cardFooterRow: { alignItems: 'center', gap: 5, marginTop: 8 },
  cardFooterText: { color: COLORS.textSecondary, fontSize: 11, fontWeight: '500' },

  modalOverlay: { flex: 1, backgroundColor: COLORS.overlay, justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: COLORS.modalBg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 32,
    maxHeight: '88%',
    borderTopWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.cardBorder,
    alignSelf: 'center',
    marginBottom: 16,
  },
  modalHeaderRow: { alignItems: 'center', gap: 10, marginBottom: 20 },
  modalTitle: { color: COLORS.textPrimary, fontSize: 16, fontWeight: '800', flex: 1 },
  fieldGroup: { marginBottom: 18 },
  fieldLabel: { color: COLORS.textPrimary, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  fieldHint: { color: COLORS.textSecondary, fontSize: 11, marginBottom: 8 },
  input: {
    backgroundColor: COLORS.inputBg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    color: COLORS.textPrimary,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  chipRow: { flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  chipActive: { backgroundColor: COLORS.accentSoft, borderColor: COLORS.accent },
  chipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: COLORS.accent },
  saveButton: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 15,
    marginTop: 6,
  },
  saveButtonDisabled: { opacity: 0.7 },
  saveButtonText: { color: '#0B0D10', fontSize: 15, fontWeight: '800' },
});