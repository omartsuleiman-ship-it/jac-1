import React, { useEffect, useState } from 'react';
import { InteractionManager, View } from 'react-native';

// Intentionally no MapLibre / expo-audio / RadarProvider imports here.
// Expo Router may evaluate this route file while hiding the splash screen.
export default function RadarScreen() {
  const [node, setNode] = useState<React.ReactNode>(null);

  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => {
      void Promise.all([import('../hooks/useRadarWatchdog'), import('../_radar/RadarScreenInner')]).then(
        ([{ RadarProvider }, { RadarScreenInner }]) => {
          setNode(
            <RadarProvider>
              <RadarScreenInner />
            </RadarProvider>
          );
        }
      );
    });
    return () => handle.cancel();
  }, []);

  return node ?? <View style={{ flex: 1, backgroundColor: '#000000' }} />;
}
