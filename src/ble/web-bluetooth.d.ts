// Minimale Typdeklarationen für die genutzte Web-Bluetooth-API (TS' DOM-Lib enthält sie nicht).
// Bewusst schmal gehalten, damit der Simulator (src/sim/fake-strap.ts) sie vollständig erfüllen kann.

type BluetoothServiceUUID = string | number;
type BluetoothCharacteristicUUID = string | number;

interface BluetoothLEScanFilter {
  services?: BluetoothServiceUUID[];
  name?: string;
  namePrefix?: string;
}

interface RequestDeviceOptions {
  filters?: BluetoothLEScanFilter[];
  optionalServices?: BluetoothServiceUUID[];
  acceptAllDevices?: boolean;
}

interface Bluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
  /** Nicht überall vorhanden (z. B. Bluefy/Safari) – vor Nutzung prüfen. */
  getDevices?(): Promise<BluetoothDevice[]>;
  getAvailability?(): Promise<boolean>;
}

interface BluetoothDevice {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  addEventListener(type: 'gattserverdisconnected', listener: (ev: Event) => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: (ev: Event) => void): void;
}

interface BluetoothRemoteGATTServer {
  readonly device: BluetoothDevice;
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothRemoteGATTService {
  readonly uuid: string;
  getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTCharacteristic {
  readonly uuid: string;
  /** Zuletzt gelesener/benachrichtigter Wert; ist beim Auslösen von 'characteristicvaluechanged' gesetzt. */
  readonly value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  readValue(): Promise<DataView>;
  writeValue(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  writeValueWithResponse?(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  writeValueWithoutResponse?(value: ArrayBuffer | ArrayBufferView): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
