import { BleManager, Device } from 'react-native-ble-plx';

// إنشاء نسخة واحدة من مدير البلوتوث للتطبيق كله
export const bleManager = new BleManager();

export const startBleScan = (
  onDeviceFound: (device: Device) => void,
  onError: (error: any) => void
) => {
  // التأكد من تشغيل البلوتوث أولاً
  bleManager.state().then((state) => {
    if (state !== 'PoweredOn') {
      onError(new Error('يرجى تشغيل البلوتوث أولاً من إعدادات الآيفون.'));
      return;
    }

    // بدء البحث عن الأجهزة
    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        onError(error);
        return;
      }
      
      // إرسال أي جهاز يتم العثور عليه (وله اسم) للواجهة
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
    // إيقاف البحث قبل الاتصال لتوفير الطاقة وتقليل المشاكل
    stopBleScan();
    
    // الاتصال بالجهاز
    const connectedDevice = await device.connect();
    
    // اكتشاف كل الخدمات والخصائص المتاحة في قطعة الـ OBD
    await connectedDevice.discoverAllServicesAndCharacteristics();
    
    return connectedDevice;
  } catch (error) {
    throw error;
  }
};

export const disconnectBleDevice = async (deviceId: string) => {
  try {
    await bleManager.cancelDeviceConnection(deviceId);
  } catch (error) {
    console.error('Error disconnecting:', error);
  }
};