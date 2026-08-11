import { BleManager, Device, Characteristic } from 'react-native-ble-plx';

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

// ── Scan functions (unchanged) ──
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
    // Store device and characteristic
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

  // Write command (AT commands or OBD request)
  // Most ELM327 adapters expect ASCII command followed by \r\n
  const writeData = command + '\r\n';
  await obdCharacteristic.writeWithResponse(Buffer.from(writeData, 'ascii'));

  // Read response – we need to monitor the characteristic notifications
  // Since we are using react-native-ble-plx, we must set up a subscription
  // For simplicity, we'll wait for a single notification.
  // In production, you'd manage a more robust listener.
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
        // Convert base64 to string
        const raw = Buffer.from(characteristic.value, 'base64').toString('ascii');
        // In ELM327 responses, there may be multiple lines; we collect until we get a '>' prompt.
        // For simplicity, we just return the raw string.
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
  // Typical response: "43 01 02 03 04 05 06 07" where bytes after "43" are DTCs.
  // DTCs are 2 bytes each; we convert to standard OBD-II codes (P, C, B, U).
  const hexPart = response.replace(/\s/g, ''); // remove spaces
  // Look for "43" at start (Mode 03 response)
  const idx = hexPart.indexOf('43');
  if (idx === -1) return [];
  const payload = hexPart.substring(idx + 2); // after "43"
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
  // DTC format: first byte bits 7-6 = type (00=P, 01=C, 10=B, 11=U)
  // bits 5-4 = first digit (0-3), bits 3-0 = second digit (0-F)
  // second byte = third digit (0-F) and fourth digit (0-F)
  const typeBits = (b1 >> 6) & 0x03;
  const type = ['P', 'C', 'B', 'U'][typeBits];
  const firstDigit = (b1 >> 4) & 0x03;
  const secondDigit = b1 & 0x0F;
  const thirdDigit = (b2 >> 4) & 0x0F;
  const fourthDigit = b2 & 0x0F;
  // Convert digits to hex characters
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
  // We request multiple PIDs in one command if supported, but for simplicity we request separately.
  // Or use Mode 01 PID 00 to get supported PIDs, then request the ones we need.
  // For demonstration, we'll request each PID individually.
  const rpm = await requestPID('010C'); // Engine RPM
  const coolant = await requestPID('0105'); // Coolant temp
  const voltage = await requestPID('0142'); // Control module voltage
  const maf = await requestPID('0110'); // MAF air flow
  const o2 = await requestPID('0114'); // O2 sensor (Bank1 Sensor1)
  const fuelTrim = await requestPID('0106'); // Short term fuel trim bank1

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
  // Parse response based on PID
  // Example: "410C 1A 2B" -> RPM = ((A*256)+B)/4
  const hex = response.replace(/\s/g, '').toUpperCase();
  // Find the mode+pid part
  const expected = pid.toUpperCase();
  const idx = hex.indexOf(expected);
  if (idx === -1) return 0;
  const data = hex.substring(idx + expected.length);
  // Depending on PID, length varies
  const bytes = data.match(/.{1,2}/g) || [];
  const numbers = bytes.map(b => parseInt(b, 16));

  switch (pid) {
    case '010C': // RPM
      if (numbers.length < 2) return 0;
      return ((numbers[0] * 256) + numbers[1]) / 4;
    case '0105': // Coolant temp
      if (numbers.length < 1) return 0;
      return numbers[0] - 40;
    case '0142': // Voltage
      if (numbers.length < 1) return 0;
      return numbers[0] * 0.1; // actual voltage = value * 0.1
    case '0110': // MAF
      if (numbers.length < 2) return 0;
      return ((numbers[0] * 256) + numbers[1]) / 100;
    case '0114': // O2 sensor voltage
      if (numbers.length < 2) return 0;
      return numbers[0] * 0.005; // voltage = A * 0.005
    case '0106': // Short term fuel trim
      if (numbers.length < 1) return 0;
      return (numbers[0] - 128) * 100 / 128;
    default:
      return 0;
  }
};

export const getReadiness = async () => {
  // Mode 01 PID 01 - Monitor status since DTCs cleared
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
  // PID 01 returns up to 4 bytes; we need bits for monitors.
  // Simplified: we'll check byte 0 and byte 1 for readiness.
  // For a real implementation, consult SAE J1979.
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
  // Mode $06 - Test results. We'll request specific test ID for misfire per cylinder.
  // This is more complex; we'll return dummy for now, but comment that real implementation needed.
  // For demonstration, we return simulated counts.
  // In a real implementation, you'd request Mode 06 with appropriate TID/CID.
  console.warn('Mode 06 not fully implemented; returning simulated counts.');
  return [
    { cylinder: 1, count: Math.floor(Math.random() * 3) },
    { cylinder: 2, count: Math.floor(Math.random() * 3) },
    { cylinder: 3, count: Math.floor(Math.random() * 6) },
    { cylinder: 4, count: Math.floor(Math.random() * 3) },
  ];
};