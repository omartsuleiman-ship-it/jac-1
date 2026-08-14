import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { BleManager, Characteristic, Device } from 'react-native-ble-plx';

// ── BLE Manager ──
export const bleManager = new BleManager();

// ── OBD-II Service & Characteristic UUIDs ──
const OBD_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const OBD_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

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

// ── Must match STORAGE_KEY_ODOMETER in maintenance.tsx / trip.tsx exactly ──
const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';

// ── State ──
let connectedDevice: Device | null = null;
let writeCharacteristic: Characteristic | null = null;
let notifyCharacteristic: Characteristic | null = null;
let writeWithoutResponseMode = false;

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

// ── ELM327 init sequence: reset, echo off, linefeeds off, auto-detect protocol ──
const initializeELM327 = async () => {
  try {
    await queueRawCommand('ATZ', 3000);
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
    Alert.alert('BLE Success', `Write: ${writeChar.uuid}\nNotify: ${notifyChar.uuid}`);
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

export const getDTCs = async (): Promise<string[]> => {
  const response = await sendOBDCommand('03');
  return parseDTCs(response);
};

export const getLiveData = async () => {
  const safeRequest = async (pid: string): Promise<number | null> => {
    try {
      return await requestPID(pid);
    } catch (error) {
      console.warn(`[BLE] Live data PID ${pid} failed:`, error);
      return null;
    }
  };

  // 1. Fetch Basic Engine Data
  const rpm = await safeRequest('010C');
  const coolant = await safeRequest('0105');
  const o2 = await safeRequest('0114');
  const fuelTrim = await safeRequest('0106');
  const engineLoad = await safeRequest('0104');

  // 2. Direct Battery Voltage via ELM327 ATRV command
  let voltage = 0;
  try {
    const atrvResponse = await sendOBDCommand('ATRV');
    // ATRV returns string like "14.1V"
    const match = atrvResponse.match(/[\d.]+/);
    if (match) voltage = parseFloat(match[0]);
  } catch (e) {
    console.warn('[BLE] ATRV failed', e);
  }

  // 3. Virtual MAF (Speed-Density) for JAC S3 1.5L
  let maf = 0;
  const map = await safeRequest('010B'); // MAP in kPa
  const iat = await safeRequest('010F'); // IAT in °C

  if (rpm !== null && map !== null && iat !== null && rpm > 0) {
    const VE = 0.80; // Volumetric Efficiency (~80% average for 1.5L NA)
    const ED = 1.499; // Engine Displacement in Liters (JAC S3)
    const iatKelvin = iat + 273.15;
    const gasConstant = 8.314; 
    const airMolarMass = 28.97;
    
    // Speed-Density Formula to calculate MAF (g/s)
    const imap = (rpm * map) / 120;
    maf = imap * VE * ED * (airMolarMass / (gasConstant * iatKelvin));
  }

  return {
    rpm: rpm ?? 0,
    coolant: coolant ?? 0,
    voltage: parseFloat(voltage.toFixed(1)),
    engineLoad: engineLoad ?? 0,
    maf: parseFloat(maf.toFixed(2)),
    o2: o2 ?? 0,
    fuelTrim: fuelTrim ?? 0,
  };
};

const requestPID = async (pid: string): Promise<number> => {
  const response = await sendOBDCommand(pid);
  const hex = response.replace(/\s/g, '').toUpperCase();
  // الـECU بيرد بـ (mode + 0x40) مش بنفس بايتات الطلب — مثلاً طلب '010C' يرجع رد يبدأ بـ '410C'
  const modeByte = parseInt(pid.substring(0, 2), 16);
  const responseMode = (modeByte + 0x40).toString(16).toUpperCase().padStart(2, '0');
  const expected = responseMode + pid.substring(2).toUpperCase();
  const idx = hex.indexOf(expected);
  if (idx === -1) return 0;
  const data = hex.substring(idx + expected.length);
  const bytes = data.match(/.{1,2}/g) || [];
  const numbers = bytes.map(b => parseInt(b, 16));

  switch (pid) {
    case '010B': // MAP (Manifold Absolute Pressure) - kPa
      if (numbers.length < 1) return 0;
      return numbers[0];
    case '010F': // IAT (Intake Air Temperature) - °C
      if (numbers.length < 1) return 0;
      return numbers[0] - 40;
    case '0104': // Engine Load (%)
      if (numbers.length < 1) return 0;
      return (numbers[0] * 100) / 255;
    case '010C':
      if (numbers.length < 2) return 0;
      return ((numbers[0] * 256) + numbers[1]) / 4;
    case '0105':
      if (numbers.length < 1) return 0;
      return numbers[0] - 40;
    case '0142':
      if (numbers.length < 1) return 0;
      return numbers[0] * 0.1;
    case '0110':
      if (numbers.length < 2) return 0;
      return ((numbers[0] * 256) + numbers[1]) / 100;
    case '0114':
      if (numbers.length < 2) return 0;
      return numbers[0] * 0.005;
    case '0106':
      if (numbers.length < 1) return 0;
      return (numbers[0] - 128) * 100 / 128;
    default:
      return 0;
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