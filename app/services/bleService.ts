import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { Alert } from 'react-native';
import { BleManager, Characteristic, Device } from 'react-native-ble-plx';

// ── BLE Manager ──
// restoreStateIdentifier is what actually lets iOS relaunch/reattach this app
// to an already-connected peripheral after backgrounding or a suspend/kill —
// this, not a background-fetch task, is the correct react-native-ble-plx
// mechanism the bluetooth-central mode is meant to pair with.
const BLE_RESTORE_STATE_ID = 'jac-obd-central-manager';

export const bleManager = new BleManager({
  restoreStateIdentifier: BLE_RESTORE_STATE_ID,
  restoreStateFunction: (restoredState) => {
    if (restoredState && restoredState.connectedPeripherals.length > 0) {
      const restoredDevice = restoredState.connectedPeripherals[0];
      console.log('[BLE] iOS restored connection to:', restoredDevice.id);
      // Re-attach write/notify characteristics + command queue to the
      // restored device so it's usable the moment the app is foregrounded
      setOBDDevice(restoredDevice).catch((error) => {
        console.warn('[BLE] Failed to re-attach after state restoration:', error);
      });
    } else {
      console.log('[BLE] iOS restore callback fired with no connected peripheral');
    }
  },
});

// ── OBD-II Service & Characteristic UUIDs ──
const OBD_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const OBD_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

// ── Must match STORAGE_KEY_ODOMETER in maintenance.tsx / trip.tsx exactly ──
const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';

// ── Exported so index.tsx reads the exact same key, never a hardcoded literal ──
export const STORAGE_KEY_LAST_PARKED = '@last_parked_location';

// ── Pure-JS ASCII <-> Base64 helpers (RN has no global Buffer/Node polyfill) ──
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const asciiToBase64 = (input: string): string => {
  let output = '';
  let i = 0;
  while (i < input.length) {
    const b1 = input.charCodeAt(i++) & 0xff;
    const has2 = i < input.length;
    const b2 = has2 ? input.charCodeAt(i++) & 0xff : 0;
    const has3 = i < input.length;
    const b3 = has3 ? input.charCodeAt(i++) & 0xff : 0;

    const enc1 = b1 >> 2;
    const enc2 = ((b1 & 0x03) << 4) | (b2 >> 4);
    const enc3 = ((b2 & 0x0f) << 2) | (b3 >> 6);
    const enc4 = b3 & 0x3f;

    output +=
      BASE64_CHARS.charAt(enc1) +
      BASE64_CHARS.charAt(enc2) +
      (has2 ? BASE64_CHARS.charAt(enc3) : '=') +
      (has3 ? BASE64_CHARS.charAt(enc4) : '=');
  }
  return output;
};

const base64ToAscii = (input: string): string => {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  let output = '';
  let i = 0;
  while (i < clean.length) {
    const c1 = clean.charAt(i++);
    const c2 = clean.charAt(i++);
    const c3 = clean.charAt(i++);
    const c4 = clean.charAt(i++);

    const enc1 = BASE64_CHARS.indexOf(c1);
    const enc2 = BASE64_CHARS.indexOf(c2);
    const enc3 = c3 === '=' || c3 === '' ? -1 : BASE64_CHARS.indexOf(c3);
    const enc4 = c4 === '=' || c4 === '' ? -1 : BASE64_CHARS.indexOf(c4);
    if (enc1 === -1 || enc2 === -1) break;

    output += String.fromCharCode((enc1 << 2) | (enc2 >> 4));
    if (enc3 !== -1) output += String.fromCharCode(((enc2 & 15) << 4) | (enc3 >> 2));
    if (enc3 !== -1 && enc4 !== -1) output += String.fromCharCode(((enc3 & 3) << 6) | enc4);
  }
  return output;
};

// ── State ──
let connectedDevice: Device | null = null;
let writeCharacteristic: Characteristic | null = null;
let notifyCharacteristic: Characteristic | null = null;
let writeWithoutResponseMode = false;
let disconnectSubscription: { remove: () => void } | null = null;

// ── Response buffering: BLE notifications arrive in chunks; ELM327 terminates every reply with '>' ──
let responseBuffer = '';
let notifySubscription: { remove: () => void } | null = null;

// ── Command Queue: ELM327 is half-duplex, only one command may be in flight at a time ──
interface QueuedCommand {
  command: string;
  resolve: (value: string) => void;
  reject: (reason: any) => void;
  timeoutMs: number;
}
const commandQueue: QueuedCommand[] = [];
let activeCommand: QueuedCommand | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

const clearActiveCommand = () => {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  activeCommand = null;
};

const processQueue = () => {
  if (activeCommand || commandQueue.length === 0) return;

  if (!writeCharacteristic) {
    while (commandQueue.length) {
      commandQueue.shift()?.reject(new Error('OBD characteristic not available. Device not connected?'));
    }
    return;
  }

  activeCommand = commandQueue.shift()!;
  responseBuffer = '';
  const current = activeCommand;

  activeTimeout = setTimeout(() => {
    clearActiveCommand();
    current.reject(new Error(`OBD command timeout: ${current.command}`));
    processQueue();
  }, current.timeoutMs);

  const payload = asciiToBase64(current.command + '\r');
  const writePromise = writeWithoutResponseMode
    ? writeCharacteristic.writeWithoutResponse(payload)
    : writeCharacteristic.writeWithResponse(payload);

  console.log(`[BLE] > ${current.command}`);
  writePromise.catch((error) => {
    clearActiveCommand();
    current.reject(error);
    processQueue();
  });
};

// ── Single persistent listener; buffers chunks until the '>' prompt closes the reply ──
const startNotifyListener = () => {
  if (!notifyCharacteristic) return;
  notifySubscription?.remove();
  notifySubscription = notifyCharacteristic.monitor((error, characteristic) => {
    if (error) {
      if (activeCommand) {
        const current = activeCommand;
        clearActiveCommand();
        current.reject(error);
        processQueue();
      }
      return;
    }
    if (characteristic && characteristic.value) {
      responseBuffer += base64ToAscii(characteristic.value);
      if (responseBuffer.includes('>')) {
        const raw = responseBuffer.replace(/>/g, '').trim();
        responseBuffer = '';
        if (activeCommand) {
          const current = activeCommand;
          clearActiveCommand();
          current.resolve(raw);
          processQueue();
        }
      }
    }
  });
};

const queueRawCommand = (command: string, timeoutMs = 2000): Promise<string> => {
  return new Promise((resolve, reject) => {
    commandQueue.push({ command, resolve, reject, timeoutMs });
    processQueue();
  });
};

// ── Small delay helper — used ONLY where a specific ELM327 quirk needs it,
// never as a blanket "just in case" pause between every command. The queue
// already serializes commands correctly by waiting for the '>' prompt (or a
// timeout) before sending the next one, so most commands need no extra delay.
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── ELM327 init sequence: reset, echo off, linefeeds off, auto-detect protocol ──
const initializeELM327 = async () => {
  try {
    await queueRawCommand('ATZ', 3000);
    // ATZ resets the adapter's own MCU. Many cheap clones send back the '>'
    // prompt before their internal parser has actually finished settling
    // post-reset — accepting the next command too early is a well-known
    // real-world cause of a clone appearing to freeze (LEDs stop, no further
    // replies) even though the app's queue did everything right. This is the
    // one place a fixed delay is genuinely justified.
    await delay(300);
    await queueRawCommand('ATE0');
    await queueRawCommand('ATL0');
    await queueRawCommand('ATSP0');
  } catch (error) {
    console.warn('ELM327 initialization failed:', error);
  }
};

// ── Fetch the ECU's true odometer (PID 01A6) and persist it; no-ops safely if the vehicle doesn't support it ──
const fetchAndSaveTrueOdometer = async (): Promise<void> => {
  try {
    const response = await queueRawCommand('01A6', 3000);
    const upper = response.toUpperCase();
    if (upper.includes('NO DATA') || upper.includes('ERROR') || upper.includes('UNABLE')) {
      console.warn('[BLE] True odometer (01A6) not supported by this vehicle');
      return;
    }

    const hex = response.replace(/\s/g, '').toUpperCase();
    const idx = hex.indexOf('41A6');
    if (idx === -1) {
      console.warn('[BLE] Unexpected 01A6 response:', response);
      return;
    }

    const data = hex.substring(idx + 4);
    const bytes = data.match(/.{1,2}/g) || [];
    if (bytes.length < 4) {
      console.warn('[BLE] 01A6 response too short:', response);
      return;
    }

    const [a, b, c, d] = bytes.slice(0, 4).map((byte) => parseInt(byte, 16));
    const distanceKm = (a * 16777216 + b * 65536 + c * 256 + d) / 10;

    if (!isNaN(distanceKm) && distanceKm > 0) {
      await AsyncStorage.setItem(STORAGE_KEY_ODOMETER, JSON.stringify(distanceKm));
      console.log(`[BLE] True odometer saved: ${distanceKm} km`);
    }
  } catch (error) {
    console.warn('[BLE] Failed to fetch true odometer:', error);
  }
};

// ── Capture the phone's current GPS position and persist it as "where the
// car was last parked". Fires from the device-level onDisconnected event so
// it covers BOTH a manual disconnect AND the far more common real-world
// case: the ignition turns off, the ELM327 loses power, and BLE drops
// unexpectedly — which is exactly the moment the user has actually parked. ──
const captureLastParkedLocation = async (): Promise<void> => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[BLE] Location permission not granted — cannot save parked location');
      return;
    }

    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    const parked = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      timestamp: Date.now(),
    };

    await AsyncStorage.setItem(STORAGE_KEY_LAST_PARKED, JSON.stringify(parked));
    console.log(`[BLE] Last parked location saved: ${parked.latitude}, ${parked.longitude}`);
  } catch (error) {
    // Deliberately don't touch AsyncStorage on failure — an old, correct
    // saved location is more useful to the user than silently wiping it
    // because of a transient GPS/permission glitch
    console.warn('[BLE] Failed to capture last-parked location:', error);
  }
};

// ── Dynamically find the UART TX/RX characteristic instead of trusting a hardcoded UUID ──
const discoverOBDCharacteristic = async (
  device: Device
): Promise<{ writeChar: Characteristic | null; notifyChar: Characteristic | null }> => {
  const services = await device.services();

  for (const service of services) {
    console.log(`[BLE] Service: ${service.uuid}`);
    const characteristics = await service.characteristics();
    for (const char of characteristics) {
      console.log(
        `[BLE]   Characteristic: ${char.uuid} | notify=${char.isNotifiable} | writeWithResponse=${char.isWritableWithResponse} | writeWithoutResponse=${char.isWritableWithoutResponse}`
      );
    }
  }

  let writeChar: Characteristic | null = null;
  let notifyChar: Characteristic | null = null;

  // Prefer the known FFE1 UUID for whichever role(s) it actually supports
  for (const service of services) {
    const characteristics = await service.characteristics();
    for (const char of characteristics) {
      if (char.uuid.toLowerCase() === OBD_CHARACTERISTIC_UUID.toLowerCase()) {
        if (!writeChar && (char.isWritableWithResponse || char.isWritableWithoutResponse)) {
          writeChar = char;
        }
        if (!notifyChar && char.isNotifiable) {
          notifyChar = char;
        }
      }
    }
  }

  // Fall back to scanning every service for ANY writable / notifiable characteristic (split TX/RX dongles, e.g. FFF1/FFF2)
  for (const service of services) {
    const characteristics = await service.characteristics();
    for (const char of characteristics) {
      if (!writeChar && (char.isWritableWithResponse || char.isWritableWithoutResponse)) {
        console.log(`[BLE] Auto-selected WRITE characteristic ${char.uuid} on service ${service.uuid}`);
        writeChar = char;
      }
      if (!notifyChar && char.isNotifiable) {
        console.log(`[BLE] Auto-selected NOTIFY characteristic ${char.uuid} on service ${service.uuid}`);
        notifyChar = char;
      }
    }
  }

  return { writeChar, notifyChar };
};

// ── Set the connected device after successful connection ──
export const setOBDDevice = async (device: Device) => {
  connectedDevice = device;

  // Fires on ANY disconnect — manual (disconnectBleDevice) or unexpected
  // (dongle lost power / went out of range, e.g. the car was just turned off)
  disconnectSubscription?.remove();
  disconnectSubscription = device.onDisconnected(() => {
    console.log('[BLE] Device disconnected — capturing last-parked location');
    captureLastParkedLocation();
    connectedDevice = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;
    notifySubscription?.remove();
    notifySubscription = null;
  });

  await device.discoverAllServicesAndCharacteristics();
  try {
    const { writeChar, notifyChar } = await discoverOBDCharacteristic(device);
        if (!writeChar || !notifyChar) {
      console.error('[BLE] Missing write and/or notify characteristic on this device');
      Alert.alert('BLE Char Error', 'No notifiable/writable characteristic found');
      return;
    }
    writeCharacteristic = writeChar;
    notifyCharacteristic = notifyChar;
    writeWithoutResponseMode = !writeChar.isWritableWithResponse && writeChar.isWritableWithoutResponse;
    console.log(
      `[BLE] Write=${writeChar.uuid} Notify=${notifyChar.uuid}, writeWithoutResponse=${writeWithoutResponseMode}`
    );
    // Removed the debug Alert.alert('BLE Success', ...) that used to fire
    // on every connection — leftover from early development, and popping a
    // native modal on every connect is exactly the kind of thing that reads
    // as a freeze. Use the console.log above / [BLE] tags for debugging.
    responseBuffer = '';
    startNotifyListener();
    await initializeELM327();
    await fetchAndSaveTrueOdometer();
  } catch (error: any) {
    console.error(error);
    Alert.alert('BLE Exception', error?.message ?? String(error));
  }
};

// ── Scan functions ──
export const startBleScan = (
  onDeviceFound: (device: Device) => void,
  onError: (error: any) => void
) => {
  bleManager.state().then((state) => {
    if (state !== 'PoweredOn') {
      onError(new Error('يرجى تشغيل البلوتوث أولاً من إعدادات الآيفون.'));
      return;
    }
    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        onError(error);
        return;
      }
      if (device && device.name) {
        onDeviceFound(device);
      }
    });
  });
};

export const stopBleScan = () => {
  bleManager.stopDeviceScan();
};

export const connectToBleDevice = async (device: Device): Promise<Device> => {
  try {
    stopBleScan();
    const connected = await device.connect();
    await connected.discoverAllServicesAndCharacteristics();
    await setOBDDevice(connected);
    return connected;
  } catch (error) {
    throw error;
  }
};

export const disconnectBleDevice = async (deviceId: string) => {
  try {
    await bleManager.cancelDeviceConnection(deviceId);
  } catch (error) {
    console.error('Error disconnecting:', error);
  } finally {
    // Capture directly here too — don't rely solely on the onDisconnected
    // listener above, since its firing order relative to
    // cancelDeviceConnection() resolving isn't guaranteed across platforms.
    // A harmless duplicate write from the listener firing shortly after is
    // fine; a missed one isn't.
    captureLastParkedLocation();

    disconnectSubscription?.remove();
    disconnectSubscription = null;
    notifySubscription?.remove();
    notifySubscription = null;
    responseBuffer = '';
    while (commandQueue.length) {
      commandQueue.shift()?.reject(new Error('Device disconnected'));
    }
    if (activeCommand) {
      const current = activeCommand;
      clearActiveCommand();
      current.reject(new Error('Device disconnected'));
    }
    connectedDevice = null;
    writeCharacteristic = null;
    notifyCharacteristic = null;
  }
};

// ── Connection status ──
export const isConnected = (): boolean => {
  return connectedDevice !== null;
};

// ── OBD Command Helpers ──

/**
 * Send an OBD command and wait for the response.
 * @param command - e.g., "0100" for Mode 01 PID 00
 * @param timeoutMs - timeout in milliseconds
 * @returns The raw response string (hex)
 */
export const sendOBDCommand = async (command: string, timeoutMs: number = 2000): Promise<string> => {
  if (!writeCharacteristic || !notifyCharacteristic) {
    throw new Error('OBD characteristic not available. Device not connected?');
  }
  return queueRawCommand(command, timeoutMs);
};

/**
 * Parse Mode 03 response to extract DTC codes (7-digit hex).
 */
export const parseDTCs = (response: string): string[] => {
  // فصل كل سطر لوحده (ممكن أكتر من ECU يردوا على نفس الطلب) وامسح أي سطر فيه نويز مش hex نضيف
  const lines = response
    .split(/[\r\n]+/)
    .map((line) => line.replace(/\s/g, '').toUpperCase())
    .filter((line) => line.length > 0 && /^[0-9A-F]+$/.test(line));

  const codes: string[] = [];
  for (const hexPart of lines) {
    const idx = hexPart.indexOf('43');
    if (idx === -1) continue;
    const payload = hexPart.substring(idx + 2);
    const dtcBytes = payload.match(/.{1,2}/g) || [];
    for (let i = 0; i + 1 < dtcBytes.length; i += 2) {
      const byte1 = parseInt(dtcBytes[i], 16);
      const byte2 = parseInt(dtcBytes[i + 1], 16);
      if (byte1 === 0 && byte2 === 0) continue; // بايتات padding فاضية
      const code = byteToDTC(byte1, byte2);
      if (code) codes.push(code);
    }
  }
  return [...new Set(codes)];
};

const byteToDTC = (b1: number, b2: number): string | null => {
  const typeBits = (b1 >> 6) & 0x03;
  const type = ['P', 'C', 'B', 'U'][typeBits];
  const firstDigit = (b1 >> 4) & 0x03;
  const secondDigit = b1 & 0x0F;
  const thirdDigit = (b2 >> 4) & 0x0F;
  const fourthDigit = b2 & 0x0F;
  const digits = [firstDigit, secondDigit, thirdDigit, fourthDigit]
    .map(d => d.toString(16).toUpperCase())
    .join('');
  return `${type}${digits}`;
};

// ── High-level OBD functions ──

export const getEngineDTCs = async (): Promise<{ code: string; module: string }[]> => {
  try {
    await sendOBDCommand('ATSH7E0', 500);
    const response = await sendOBDCommand('03', 1500);
    return parseDTCs(response).map((code) => ({ code, module: 'Engine Control Module (ECM)' }));
  } catch (error) {
    console.warn('[BLE] Engine DTC scan failed:', error);
    return [];
  }
};

export const getTransmissionDTCs = async (): Promise<{ code: string; module: string }[]> => {
  try {
    await sendOBDCommand('ATSH7E1', 500);
    const response = await sendOBDCommand('03', 1500);
    return parseDTCs(response).map((code) => ({ code, module: 'Transmission Control Module (TCM)' }));
  } catch (error) {
    console.warn('[BLE] Transmission DTC scan failed:', error);
    return [];
  } finally {
    // CRITICAL: this is the only ECU switch here that doesn't already rest
    // on 7E0. GlobalSafetyWatchdog and the Live Data RPM polling loop both
    // assume the header is back on Engine — skipping this reset (or letting
    // an exception above skip it) would silently break both after every
    // transmission scan.
    try {
      await sendOBDCommand('ATSH7E0', 500);
    } catch (error) {
      console.warn('[BLE] Failed to reset header to 7E0 after transmission scan:', error);
    }
  }
};

export type LiveDataKey = 'rpm' | 'coolant' | 'voltage' | 'engineLoad' | 'maf' | 'o2' | 'fuelTrim';

export const getLiveData = async (selectedKeys: LiveDataKey[]) => {
  const want = (key: LiveDataKey) => selectedKeys.includes(key);

  const safeRequest = async (pid: string): Promise<number | null> => {
    try {
      return await requestPID(pid);
    } catch (error) {
      console.warn(`[BLE] Live data PID ${pid} failed:`, error);
      return null;
    }
  };

  // Only request PIDs the user actually selected — an unselected parameter
  // sends ZERO OBD commands, which is the core fix for the bandwidth/JS-thread
  // choke described in this request.
  const rpm = want('rpm') ? await safeRequest('010C') : null;
  const coolant = want('coolant') ? await safeRequest('0105') : null;
  const o2 = want('o2') ? await safeRequest('0114') : null;
  const fuelTrim = want('fuelTrim') ? await safeRequest('0106') : null;
  const engineLoad = want('engineLoad') ? await safeRequest('0104') : null;

  let voltage = 0;
  if (want('voltage')) {
    try {
      const atrvResponse = await sendOBDCommand('ATRV');
      const match = atrvResponse.match(/[\d.]+/);
      if (match) voltage = parseFloat(match[0]);
    } catch (e) {
      console.warn('[BLE] ATRV failed', e);
    }
  }

  // Virtual MAF depends on RPM/MAP/IAT internally to compute it, even if RPM
  // itself isn't separately selected. These are still Mode 01 PIDs on the
  // SAME already-active engine header (no ECU switch), so pulling them only
  // when MAF is selected doesn't reintroduce the bandwidth problem — it's
  // just the 3 PIDs this one derived value genuinely needs.
  let maf = 0;
  if (want('maf')) {
    const rpmForMaf = rpm !== null ? rpm : await safeRequest('010C');
    const map = await safeRequest('010B');
    const iat = await safeRequest('010F');

    if (rpmForMaf !== null && map !== null && iat !== null && rpmForMaf > 0) {
      const VE = 0.80;
      const ED = 1.499;
      const iatKelvin = iat + 273.15;
      const gasConstant = 8.314;
      const airMolarMass = 28.97;
      const imap = (rpmForMaf * map) / 120;
      maf = imap * VE * ED * (airMolarMass / (gasConstant * iatKelvin));
    }
  }

  return {
    rpm,
    coolant,
    voltage: parseFloat(voltage.toFixed(1)),
    engineLoad,
    maf: parseFloat(maf.toFixed(2)),
    o2,
    fuelTrim,
  };
};

const requestPID = async (pid: string): Promise<number | null> => {
  const response = await sendOBDCommand(pid);
  const upperRaw = response.toUpperCase();
  // أي رد فيه NO DATA / ERROR / UNABLE يبقى فشل صريح — لازم null مش صفر وهمي
  if (
    upperRaw.includes('NO DATA') ||
    upperRaw.includes('ERROR') ||
    upperRaw.includes('UNABLE') ||
    upperRaw.includes('CAN ERROR') ||
    upperRaw.includes('BUS INIT')
  ) {
    return null;
  }
  const hex = response.replace(/\s/g, '').toUpperCase();
  // الـECU بيرد بـ (mode + 0x40) مش بنفس بايتات الطلب — مثلاً طلب '010C' يرجع رد يبدأ بـ '410C'
  const modeByte = parseInt(pid.substring(0, 2), 16);
  const responseMode = (modeByte + 0x40).toString(16).toUpperCase().padStart(2, '0');
  const expected = responseMode + pid.substring(2).toUpperCase();
  const idx = hex.indexOf(expected);
  if (idx === -1) return null;
  const data = hex.substring(idx + expected.length);
  const bytes = data.match(/.{1,2}/g) || [];
  const numbers = bytes.map(b => parseInt(b, 16));

  switch (pid) {
    case '010B': // MAP (Manifold Absolute Pressure) - kPa
      if (numbers.length < 1) return null;
      return numbers[0];
    case '010F': // IAT (Intake Air Temperature) - °C
      if (numbers.length < 1) return null;
      return numbers[0] - 40;
    case '0104': // Engine Load (%)
      if (numbers.length < 1) return null;
      return (numbers[0] * 100) / 255;
    case '010C':
      if (numbers.length < 2) return null;
      return ((numbers[0] * 256) + numbers[1]) / 4;
    case '0105':
      if (numbers.length < 1) return null;
      return numbers[0] - 40;
    case '0142':
      if (numbers.length < 1) return null;
      return numbers[0] * 0.1;
    case '0110':
      if (numbers.length < 2) return null;
      return ((numbers[0] * 256) + numbers[1]) / 100;
    case '0114':
      if (numbers.length < 2) return null;
      return numbers[0] * 0.005;
    case '0106':
      if (numbers.length < 1) return null;
      return (numbers[0] - 128) * 100 / 128;
    default:
      return null;
  }
};

export const getReadiness = async () => {
  const response = await sendOBDCommand('0101');
  const hex = response.replace(/\s/g, '').toUpperCase();
  const idx = hex.indexOf('4101'); // الرد بيبدأ بـ '41 01 ...' مش بصدى الطلب '01 01'
  if (idx === -1) return {
    misfire: false,
    fuel: false,
    catalyst: false,
    evap: false,
    o2sensor: false,
  };
  const data = hex.substring(idx + 4);
  const bytes = data.match(/.{1,2}/g) || [];
  const numbers = bytes.map(b => parseInt(b, 16));

  // Byte A = numbers[0] (MIL + DTC count) — غير مستخدم هنا
  const byteB = numbers[1] || 0; // continuous monitors: bit0=misfire support, bit1=fuel support, bit4=misfire not-ready, bit5=fuel not-ready
  const byteC = numbers[2] || 0; // non-continuous monitors: supported bits
  const byteD = numbers[3] || 0; // non-continuous monitors: not-ready bits (نفس مواضع byteC)

  const misfireSupported = (byteB & 0x01) !== 0;
  const misfireNotReady = (byteB & 0x10) !== 0;
  const fuelSupported = (byteB & 0x02) !== 0;
  const fuelNotReady = (byteB & 0x20) !== 0;

  const catalystSupported = (byteC & 0x01) !== 0;
  const catalystNotReady = (byteD & 0x01) !== 0;
  const evapSupported = (byteC & 0x04) !== 0;
  const evapNotReady = (byteD & 0x04) !== 0;
  const o2Supported = (byteC & 0x20) !== 0;
  const o2NotReady = (byteD & 0x20) !== 0;

  // لو المونيتور مش مدعوم أصلاً في العربية دي، بنعتبره "جاهز" (true) بدل ما يفضل شكله عطلان
  return {
    misfire: misfireSupported ? !misfireNotReady : true,
    fuel: fuelSupported ? !fuelNotReady : true,
    catalyst: catalystSupported ? !catalystNotReady : true,
    evap: evapSupported ? !evapNotReady : true,
    o2sensor: o2Supported ? !o2NotReady : true,
  };
};
export const getMisfireCounters = async (): Promise<{ cylinder: number; count: number }[] | null> => {
  const counters: { cylinder: number; count: number }[] = [];
  
  // عناوين السليندرات في Mode 06
  const cylinders = [
    { id: 1, cmd: '06A2', header: '46A2' },
    { id: 2, cmd: '06A3', header: '46A3' },
    { id: 3, cmd: '06A4', header: '46A4' },
    { id: 4, cmd: '06A5', header: '46A5' },
  ];

  for (const cyl of cylinders) {
    try {
      // بنبعت أمر السليندر ونستنى الرد
      const res = await sendOBDCommand(cyl.cmd, 1500); 
      
      // بنمسح كل المسافات، والسطور الجديدة، وأرقام الفريمات زي (0: و 1: و 2:)
      const cleanHex = res.replace(/[\s\r\n]+/g, '').replace(/[0-9a-fA-F]:/g, '').toUpperCase();
      const idx = cleanHex.indexOf(cyl.header);

      if (idx !== -1) {
        // ترتيب البايتات: (46A2) = 4 حروف + (Test ID & Comp ID) = 4 حروف.
        // إذن القيمة الفعلية بتبدأ بعد 8 حروف، وطولها 4 حروف (2 Bytes).
        const valueHex = cleanHex.substring(idx + 8, idx + 12);
        const count = parseInt(valueHex, 16);
        counters.push({ cylinder: cyl.id, count: isNaN(count) ? 0 : count });
      } else {
        // لو مفيش بيانات للسليندر ده، بنحطه بصفر مؤقتاً
        counters.push({ cylinder: cyl.id, count: 0 }); 
      }
    } catch (e) {
      console.warn(`[BLE] Failed to fetch misfire for cyl ${cyl.id}`, e);
      counters.push({ cylinder: cyl.id, count: 0 });
    }
  }
  
  return counters.length > 0 ? counters : null;
};

// دالة جديدة بطيئة (كل 5 ثواني) لتجنب بطء الـ RPM، بتجيب داتا الأمان الحرجة
type SafetyProbeResult = { label: string; raw: string; ok: boolean };

const querySafetyECU = async (
  header: string,
  request: string,
  label: string
): Promise<SafetyProbeResult> => {
  try {
    // AT config commands (ATSH/ATCRA/ATFCSM) are answered instantly by the
    // adapter itself — they never wait on a CAN bus round trip — so 300ms is
    // generous, not risky. Only the UDS `request` below has to wait for a
    // real (or absent) ECU reply, hence its own separate timeout.
    await sendOBDCommand(`ATSH${header}`, 300);

    // Filter incoming frames to ONLY this ECU's reply ID (header + 8, per
    // ISO 15765-4 — e.g. 7E1 -> 7E9). Without this, replies/noise from other
    // modules on the shared bus can land in the buffer and corrupt parsing.
    const replyId = (parseInt(header, 16) + 8).toString(16).toUpperCase();
    await sendOBDCommand(`ATCRA${replyId}`, 300);

    // Explicit automatic flow control — ensures multi-frame ISO-TP replies
    // (UDS payloads >7 bytes) aren't cut short waiting on a Flow Control frame
    await sendOBDCommand('ATFCSM0', 300);

    const raw = await sendOBDCommand(request, 500);
    const upper = raw.toUpperCase();
    const ok = !upper.includes('NO DATA') && !upper.includes('ERROR') && !upper.includes('UNABLE') && !upper.startsWith('7F');

    if (ok) {
      console.log(`[BLE] ${label} raw response: ${raw.trim()}`);
    } else {
      console.warn(`[BLE] ${label}: no data (${raw.trim()})`);
    }
    return { label, raw, ok };
  } catch (error) {
    // A timeout here rejects via queueRawCommand's own setTimeout, which
    // already clears activeCommand and calls processQueue() — so we land
    // here cleanly instead of the queue stalling.
    console.warn(`[BLE] ${label} fetch failed`, error);
    return { label, raw: '', ok: false };
  } finally {
    // Clear this ECU's receive filter before the next module (or the final
    // engine-header fallback) picks its own
    await sendOBDCommand('ATCRA', 300).catch(() => {});
  }
};

export type SafetyDataKey = 'atfTemp';

export const getExtraSafetyData = async (selectedKeys: SafetyDataKey[]) => {
  let atfTemp: number | null = null;

  // Only probe ECUs the user actually selected — if deselected, `targets`
  // is empty and every ATSH switch below is skipped.
  // ABS (7B0) and TPMS (7A0) probes were removed: raw terminal testing
  // confirmed this ELM327 can only reach the Engine (7E0) and Transmission
  // (7E1) ECUs, and querying the other two only produced NO DATA / timeouts.
  const targets: { header: string; request: string; label: string; key: SafetyDataKey }[] = [];
  if (selectedKeys.includes('atfTemp')) {
    targets.push({ header: '7E1', request: '222001', label: 'Transmission (ATF temp)', key: 'atfTemp' });
  }

  try {
    // SEQUENTIAL, not Promise.all. ATSH/ATCRA are global adapter state, not
    // per-request — running probes "concurrently" let one ECU's commands
    // interleave with another's in the shared queue, so a request could fire
    // after a different probe had already overwritten the header. Running
    // them one at a time keeps each ECU's full header->filter->request->clear
    // sequence atomic, which is the actual fix for every parameter returning
    // null once more than one non-engine ECU was selected.
    for (const target of targets) {
      await querySafetyECU(target.header, target.request, target.label);
      // Parsing logic for ATF goes here once we confirm JAC's exact hex
      // format from the [BLE] raw response logs — result.raw holds it.
    }
  } finally {
    // Always reset to the Engine ECU header, even if a probe above threw
    // unexpectedly — guarantees the next engine-PID poll never inherits a
    // stale non-engine header or receive filter.
    if (targets.length > 0) {
      try {
        await sendOBDCommand('ATSH7E0', 300);
      } catch (error) {
        console.warn('[BLE] Failed to reset header to 7E0:', error);
      }
    }
  }

  return { atfTemp };
};