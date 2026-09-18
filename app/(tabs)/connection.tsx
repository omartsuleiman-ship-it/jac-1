import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Device } from 'react-native-ble-plx';
import {
  connectToBleDevice,
  disconnectBleDevice,
  startBleScan,
  stopBleScan,
} from '../services/bleService';

const COLORS = {
  background: '#000000',
  card: '#050505',
  cardBorder: '#1A1A1A',
  accent: '#00D9C6',
  accentSoft: 'rgba(0, 217, 198, 0.12)',
  warning: '#FFB74D',
  danger: '#FF6B5E',
  textPrimary: '#F5F6F7',
  textSecondary: '#8A9199',
};

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export default function ConnectionScreen() {
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  // التأكد من إيقاف البحث لو المستخدم خرج من الصفحة
  useEffect(() => {
    return () => {
      stopBleScan();
    };
  }, []);

  const handleScan = () => {
    setScanning(true);
    setDevices([]);

    const initGuardTimer = setTimeout(() => setScanning(false), 2000);

    startBleScan(
      (newDevice) => {
        // إضافة الجهاز للقائمة لو مش موجود قبل كده
        setDevices((prevDevices) => {
          const isDuplicate = prevDevices.find((d) => d.id === newDevice.id);
          if (isDuplicate) return prevDevices;
          return [...prevDevices, newDevice];
        });
      },
      (error) => {
        clearTimeout(initGuardTimer);
        setScanning(false);
        Alert.alert('خطأ في البلوتوث', error.message || 'حدث خطأ أثناء البحث عن الأجهزة.');
      }
    );

    // إيقاف البحث أوتوماتيكياً بعد 10 ثواني
    setTimeout(() => {
      stopBleScan();
      setScanning(false);
    }, 10000);
  };

  const handleConnect = async (device: Device) => {
    setStatus('connecting');
    setConnectedDevice(device);

    try {
      await connectToBleDevice(device);
      setStatus('connected');
      Alert.alert('تم الاتصال', `تم الربط بنجاح مع ${device.name}`);
    } catch (error) {
      setStatus('disconnected');
      setConnectedDevice(null);
      Alert.alert('فشل الاتصال', 'تأكد من أن القطعة تعمل وقريبة من الآيفون.');
    }
  };

  const handleDisconnect = async () => {
    if (connectedDevice) {
      await disconnectBleDevice(connectedDevice.id);
    }
    setStatus('disconnected');
    setConnectedDevice(null);
  };

  const statusConfig: Record<ConnectionStatus, { color: string; label: string; icon: keyof typeof Ionicons.glyphMap }> = {
    disconnected: { color: COLORS.textSecondary, label: 'Disconnected', icon: 'bluetooth-outline' },
    connecting: { color: COLORS.warning, label: 'Connecting...', icon: 'bluetooth-outline' },
    connected: { color: COLORS.accent, label: 'Connected', icon: 'bluetooth' },
  };

  const current = statusConfig[status];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        {/* Status Card */}
        <View style={[styles.statusCard, { borderColor: current.color }]}>
          <View style={[styles.statusIconCircle, { backgroundColor: `${current.color}22` }]}>
            <Ionicons name={current.icon} size={28} color={current.color} />
          </View>
          <Text style={[styles.statusText, { color: current.color }]}>{current.label}</Text>
          {status === 'connected' && connectedDevice && (
            <Text style={styles.statusSubtext}>{connectedDevice.name || 'ARC 103'} · OBD-II Dongle</Text>
          )}
          {status === 'connected' && (
            <TouchableOpacity style={styles.disconnectButton} onPress={handleDisconnect} activeOpacity={0.8}>
              <Text style={styles.disconnectButtonText}>Disconnect</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Scan Button */}
        <TouchableOpacity
          style={[styles.scanButton, scanning && styles.scanButtonDisabled]}
          onPress={handleScan}
          disabled={scanning}
          activeOpacity={0.85}
        >
          {scanning ? (
            <>
              <ActivityIndicator color="#0B0D10" size="small" />
              <Text style={styles.scanButtonText}>Scanning for ARC 103...</Text>
            </>
          ) : (
            <>
              <Ionicons name="search-outline" size={20} color="#0B0D10" />
              <Text style={styles.scanButtonText}>Scan for Devices</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Device List */}
        {devices.length > 0 && (
          <View>
            <Text style={styles.sectionLabel}>{devices.length} Device{devices.length > 1 ? 's' : ''} Found</Text>
            {devices.map((device) => {
              const isThisConnected = connectedDevice?.id === device.id && status === 'connected';
              const isThisConnecting = connectedDevice?.id === device.id && status === 'connecting';
              const isTargetDevice = device.name === 'ARC 103' || device.name?.includes('OBD');

              return (
                <View key={device.id} style={styles.deviceCard}>
                  <View style={[styles.deviceIconCircle, isTargetDevice && styles.deviceIconCircleHighlight]}>
                    <Ionicons
                      name="hardware-chip-outline"
                      size={20}
                      color={isTargetDevice ? COLORS.accent : COLORS.textSecondary}
                    />
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={styles.deviceNameRow}>
                      <Text style={styles.deviceName}>{device.name}</Text>
                      {isTargetDevice && (
                        <View style={styles.recommendedBadge}>
                          <Text style={styles.recommendedBadgeText}>OBD DONGLE</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.deviceRssi}>Signal: {device.rssi} dBm</Text>
                  </View>

                  <TouchableOpacity
                    style={[
                      styles.connectButton,
                      isThisConnected && styles.connectedButton,
                      isThisConnecting && styles.connectingButton,
                    ]}
                    onPress={() => handleConnect(device)}
                    disabled={isThisConnected || isThisConnecting}
                    activeOpacity={0.8}
                  >
                    {isThisConnecting ? (
                      <ActivityIndicator color={COLORS.warning} size="small" />
                    ) : (
                      <Text
                        style={[
                          styles.connectButtonText,
                          isThisConnected && styles.connectedButtonText,
                        ]}
                      >
                        {isThisConnected ? 'Connected' : 'Connect'}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}

        {devices.length === 0 && !scanning && (
          <View style={styles.emptyStateCard}>
            <Ionicons name="bluetooth-outline" size={48} color={COLORS.textSecondary} />
            <Text style={styles.emptyStateTitle}>No Devices Found Yet</Text>
            <Text style={styles.emptyStateSubtext}>
              Tap "Scan for Devices" to search for your ARC 103 dongle nearby.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  container: { padding: 16, paddingBottom: 40 },
  statusCard: {
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 24,
    marginBottom: 20,
    borderWidth: 1.5,
  },
  statusIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  statusText: { fontSize: 20, fontWeight: '800' },
  statusSubtext: { color: COLORS.textSecondary, fontSize: 13, marginTop: 4 },
  disconnectButton: {
    marginTop: 14,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.danger,
  },
  disconnectButtonText: { color: COLORS.danger, fontSize: 13, fontWeight: '700' },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: COLORS.accent,
    borderRadius: 14,
    paddingVertical: 16,
    marginBottom: 20,
  },
  scanButtonDisabled: { opacity: 0.7 },
  scanButtonText: { color: '#0B0D10', fontSize: 15, fontWeight: '800' },
  sectionLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700', marginBottom: 10 },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  deviceIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceIconCircleHighlight: { backgroundColor: COLORS.accentSoft },
  deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  deviceName: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700' },
  recommendedBadge: {
    backgroundColor: COLORS.accentSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  recommendedBadgeText: { color: COLORS.accent, fontSize: 9, fontWeight: '800' },
  deviceRssi: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2 },
  connectButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.accent,
    minWidth: 90,
    alignItems: 'center',
  },
  connectedButton: { backgroundColor: COLORS.accentSoft, borderColor: COLORS.accent },
  connectingButton: { borderColor: COLORS.warning },
  connectButtonText: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
  connectedButtonText: { color: COLORS.accent },
  emptyStateCard: {
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 32,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  emptyStateTitle: { color: COLORS.textPrimary, fontSize: 16, fontWeight: '700', marginTop: 12 },
  emptyStateSubtext: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
    paddingHorizontal: 10,
  },
});