import type { CapacitorConfig } from '@capacitor/cli';

// Native iOS-App (Capacitor). Die Web-Oberfläche aus `dist/` läuft im WKWebView,
// Bluetooth geht über @capacitor-community/bluetooth-le (siehe src/ble/capacitor-bluetooth.ts).
const config: CapacitorConfig = {
  appId: 'de.steinerkn.whoopplus',
  appName: 'Whoop Plus',
  webDir: 'dist',
  backgroundColor: '#05070a',
  ios: {
    // Die Oberfläche berücksichtigt die Safe Area selbst (env(safe-area-inset-*)).
    contentInset: 'never',
    backgroundColor: '#05070a',
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Suche WHOOP-Band …',
        cancel: 'Abbrechen',
        availableDevices: 'Gefundene Geräte',
        noDeviceFound: 'Kein Band gefunden',
      },
    },
  },
};

export default config;
