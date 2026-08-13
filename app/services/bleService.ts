import AsyncStorage from '@react-native-async-storage/async-storage';
import { BleManager, Characteristic, Device } from 'react-native-ble-plx';

// ── BLE Manager ──
export const bleManager = new BleManager();

// ── OBD-II Service & Characteristic UUIDs ──
const OBD_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const OBD_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

// ── Must match STORAGE_KEY_ODOMETER in maintenance.tsx / trip.tsx exactly ──
const STORAGE_KEY_ODOMETER = '@car_app/current_odometer_v1';

// ── State ──
let connectedDevice: Device | null = null;
let obdCharacteristic: Characteristic | null = null;
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

  if (!obdCharacteristic) {
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

  const payload = Buffer.from(current.command + '\r', 'ascii').toString('base64');
  const writePromise = writeWithoutResponseMode
    ? obdCharacteristic.writeWithoutResponse(payload)
    : obdCharacteristic.writeWithResponse(payload);

  console.log(`[BLE] > ${current.command}`);
  writePromise.catch((error) => {
    clearActiveCommand();
    current.reject(error);
    processQueue();
  });
};

// ── Single persistent listener; buffers chunks until the '>' prompt closes the reply ──
const startNotifyListener = () => {
  if (!obdCharacteristic) return;
  notifySubscription?.remove();
  notifySubscription = obdCharacteristic.monitor((error, characteristic) => {
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
      responseBuffer += Buffer.from(characteristic.value, 'base64').toString('ascii');
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
const discoverOBDCharacteristic = async (device: Device): Promise<Characteristic | null> => {
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

  // Prefer the known FFE0/FFE1 pair, but only trust it if it's actually notifiable + writable on this dongle
  const knownChar = await device
    .characteristicForUUID(OBD_SERVICE_UUID, OBD_CHARACTERISTIC_UUID)
    .catch(() => null);
  if (knownChar && knownChar.isNotifiable && (knownChar.isWritableWithResponse || knownChar.isWritableWithoutResponse)) {
    console.log(`[BLE] Using known characteristic ${knownChar.uuid}`);
    return knownChar;
  }

  // Fall back to scanning every service for a notifiable + writable characteristic (typical UART bridge)
  for (const service of services) {
    const characteristics = await service.characteristics();
    for (const char of characteristics) {
      if (char.isNotifiable && (char.isWritableWithResponse || char.isWritableWithoutResponse)) {
        console.log(`[BLE] Auto-selected characteristic ${char.uuid} on service ${service.uuid}`);
        return char;
      }
    }
  }

  return null;
};

// ── Set the connected device after successful connection ──
export const setOBDDevice = async (device: Device) => {
  connectedDevice = device;
  await device.discoverAllServicesAndCharacteristics();
  try {
    const char = await discoverOBDCharacteristic(device);
    if (!char) {
      console.error('[BLE] No notifiable + writable characteristic found on this device');
      return;
    }
    obdCharacteristic = char;
    writeWithoutResponseMode = !char.isWritableWithResponse && char.isWritableWithoutResponse;
    console.log(`[BLE] Selected ${char.uuid}, writeWithoutResponse=${writeWithoutResponseMode}`);
    responseBuffer = '';
    startNotifyListener();
    await initializeELM327();
    await fetchAndSaveTrueOdometer();
  } catch (error) {
    console.error(error);
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
    obdCharacteristic = null;
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
  if (!obdCharacteristic) {
    throw new Error('OBD characteristic not available. Device not connected?');
  }
  return queueRawCommand(command, timeoutMs);
};

/**
 * Parse Mode 03 response to extract DTC codes (7-digit hex).
 */
export const parseDTCs = (response: string): string[] => {
  const hexPart = response.replace(/\s/g, '');
  const idx = hexPart.indexOf('43');
  if (idx === -1) return [];
  const payload = hexPart.substring(idx + 2);
  const dtcBytes = payload.match(/.{1,2}/g) || [];
  const codes: string[] = [];
  for (let i = 0; i < dtcBytes.length; i += 2) {
    if (i + 1 >= dtcBytes.length) break;
    const byte1 = parseInt(dtcBytes[i], 16);
    const byte2 = parseInt(dtcBytes[i + 1], 16);
    const code = byteToDTC(byte1, byte2);
    if (code) codes.push(code);
  }
  return codes;
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
  const rpm = await requestPID('010C');
  const coolant = await requestPID('0105');
  const voltage = await requestPID('0142');
  const maf = await requestPID('0110');
  const o2 = await requestPID('0114');
  const fuelTrim = await requestPID('0106');

  return {
    rpm,
    coolant,
    voltage,
    maf,
    o2,
    fuelTrim,
  };
};

const requestPID = async (pid: string): Promise<number> => {
  const response = await sendOBDCommand(pid);
  const hex = response.replace(/\s/g, '').toUpperCase();
  const expected = pid.toUpperCase();
  const idx = hex.indexOf(expected);
  if (idx === -1) return 0;
  const data = hex.substring(idx + expected.length);
  const bytes = data.match(/.{1,2}/g) || [];
  const numbers = bytes.map(b => parseInt(b, 16));

  switch (pid) {
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
  const idx = hex.indexOf('0101');
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
  const b0 = numbers[0] || 0;
  const b1 = numbers[1] || 0;
  return {
    misfire: (b0 & 0x80) !== 0,
    fuel: (b0 & 0x40) !== 0,
    catalyst: (b0 & 0x20) !== 0,
    evap: (b1 & 0x01) !== 0,
    o2sensor: (b1 & 0x04) !== 0,
  };
};

export const getMisfireCounters = async () => {
  // Mode $06 – placeholder; real implementation would request TID/CID
  console.warn('Mode 06 not fully implemented; returning simulated counts.');
  return [
    { cylinder: 1, count: Math.floor(Math.random() * 3) },
    { cylinder: 2, count: Math.floor(Math.random() * 3) },
    { cylinder: 3, count: Math.floor(Math.random() * 6) },
    { cylinder: 4, count: Math.floor(Math.random() * 3) },
  ];
};