import { BleManager, Characteristic, Device } from 'react-native-ble-plx';

// ── BLE Manager ──
export const bleManager = new BleManager();

// ── OBD-II Service & Characteristic UUIDs ──
const OBD_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
const OBD_CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';

// ── State ──
let connectedDevice: Device | null = null;
let obdCharacteristic: Characteristic | null = null;

// ── Set the connected device after successful connection ──
export const setOBDDevice = (device: Device) => {
  connectedDevice = device;
  // Discover services and get characteristic
  device.discoverAllServicesAndCharacteristics().then(() => {
    device
      .characteristicForUUID(OBD_SERVICE_UUID, OBD_CHARACTERISTIC_UUID)
      .then((char) => {
        obdCharacteristic = char;
      })
      .catch(console.error);
  });
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
    setOBDDevice(connected);
    return connected;
  } catch (error) {
    throw error;
  }
};

export const disconnectBleDevice = async (deviceId: string) => {
  try {
    await bleManager.cancelDeviceConnection(deviceId);
    connectedDevice = null;
    obdCharacteristic = null;
  } catch (error) {
    console.error('Error disconnecting:', error);
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

  const writeData = command + '\r\n';
  await obdCharacteristic.writeWithResponse(Buffer.from(writeData, 'ascii'));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.remove();
      reject(new Error('OBD command timeout'));
    }, timeoutMs);

    const subscription = obdCharacteristic!.monitor((error, characteristic) => {
      if (error) {
        clearTimeout(timeout);
        subscription.remove();
        reject(error);
        return;
      }
      if (characteristic && characteristic.value) {
        const raw = Buffer.from(characteristic.value, 'base64').toString('ascii');
        clearTimeout(timeout);
        subscription.remove();
        resolve(raw);
      }
    });
  });
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