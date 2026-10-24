// Web-Bluetooth-Teilmenge auf Basis von @capacitor-community/bluetooth-le (native iOS-App).
// WhoopDevice spricht weiterhin nur die Web-Bluetooth-Form (src/ble/web-bluetooth.d.ts); dieser Adapter
// übersetzt sie auf BleClient (CoreBluetooth). Zuordnung:
//   bluetooth.requestDevice(filters)      → BleClient.requestDevice (nativer Auswahldialog), Gerät wird gemerkt
//   bluetooth.getDevices()                → gemerktes Gerät über BleClient.getDevices([id]) (ohne Dialog)
//   gatt.connect()/disconnect()           → BleClient.connect(id, onDisconnect) / BluetoothLe.disconnect
//   'gattserverdisconnected'              → onDisconnect-Callback des Plugins bzw. disconnect()
//   getPrimaryService/getCharacteristic   → BleClient.getServices (nach dem Verbinden bereits entdeckt)
//   startNotifications + 'characteristicvaluechanged' → BleClient.startNotifications, `.value` = DataView
//   writeValueWithResponse/writeValue     → BleClient.write, writeValueWithoutResponse → writeWithoutResponse

import { BleClient, BluetoothLe, numberToUUID, type BleService, type RequestBleDeviceOptions } from '@capacitor-community/bluetooth-le';

export const DEVICE_STORAGE_KEY = 'whoop-plus.ble-device';

export interface CapacitorBluetoothOptions {
  /** Speicher für das zuletzt gewählte Gerät (Standard: localStorage). `null` = nichts merken. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Plugin-Timeout für connect – unter WhoopDevice' 20 s, damit ein aufgegebener Aufbau die Plugin-Warteschlange freigibt. */
  connectTimeoutMs?: number;
  /** Plugin-Timeout für Writes/Reads/Notifications – unter WhoopDevice' 10 s (writeTimeoutMs). */
  operationTimeoutMs?: number;
  /** Plugin-Timeout nur für den ersten Write einer Verbindung (iOS-Kopplungsdialog) – unter WhoopDevice' 30 s. */
  pairingWriteTimeoutMs?: number;
}

// Warum die Timeouts knapp UNTER denen von WhoopDevice liegen: BleClient schickt alle Aufrufe durch eine
// globale Warteschlange, und ein natives disconnect bricht einen laufenden connect nicht ab. Gibt WhoopDevice
// eine Operation auf, blockiert sie die Warteschlange noch bis zum Plugin-Timeout – so nur kurz.
// Die Warteschlange bleibt bewusst aktiv (Plugin-Standard): Das iOS-Plugin verwaltet Rückrufe pro
// Operation+Characteristic; ohne Warteschlange könnten sich z. B. ein verspäteter und ein neuer connect
// gegenseitig überschreiben. WhoopDevice serialisiert Writes ohnehin, Geschwindigkeit kostet sie also nicht.

/** Die Meldung des iOS-Plugins bei Zeitüberschreitung im connect. */
const PLUGIN_CONNECT_TIMEOUT = /connection timeout/i;

interface StoredDevice {
  id: string;
  name?: string;
}

/** Web-Bluetooth-Namen der genutzten Standard-UUIDs. */
const NAMED: Record<string, number> = {
  generic_access: 0x1800,
  generic_attribute: 0x1801,
  device_information: 0x180a,
  heart_rate: 0x180d,
  battery_service: 0x180f,
  heart_rate_measurement: 0x2a37,
  body_sensor_location: 0x2a38,
  battery_level: 0x2a19,
};

/** UUID wie Web Bluetooth normalisieren: Name, 16/32-Bit-Zahl oder Kurzform → 128-Bit, klein geschrieben. */
export function toUuid(u: BluetoothServiceUUID): string {
  if (typeof u === 'number') return numberToUUID(u);
  const named = NAMED[u];
  if (named !== undefined) return numberToUUID(named);
  const s = u.toLowerCase();
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}-0000-1000-8000-00805f9b34fb`;
  return s;
}

function domError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toDataView(v: ArrayBuffer | ArrayBufferView): DataView {
  if (v instanceof DataView) return v;
  if (ArrayBuffer.isView(v)) return new DataView(v.buffer, v.byteOffset, v.byteLength);
  return new DataView(v);
}

/**
 * Übersetzt Web-Bluetooth-Filter (ODER-verknüpft) in die eine Filtermenge des Plugins (UND-verknüpft).
 * - ein Filter → 1:1
 * - mehrere Filter, alle mit Diensten → Vereinigung der Dienste (CoreBluetooth verknüpft Dienste mit ODER)
 * - sonst → der erste Filter mit Name/Namenspräfix (nur Namensprüfung, alle Dienste beim Scan erlaubt)
 */
export function toRequestOptions(options: RequestDeviceOptions): RequestBleDeviceOptions {
  const out: RequestBleDeviceOptions = { displayMode: 'list' };
  const optional = (options.optionalServices ?? []).map(toUuid);
  if (optional.length) out.optionalServices = optional;
  const filters = options.acceptAllDevices ? [] : options.filters ?? [];
  if (filters.length === 0) return out;
  let pick: BluetoothLEScanFilter;
  if (filters.length === 1) pick = filters[0];
  else if (filters.every((f) => f.services?.length && !f.name && !f.namePrefix)) {
    pick = { services: [...new Set(filters.flatMap((f) => f.services ?? []).map(toUuid))] };
  } else pick = filters.find((f) => f.name || f.namePrefix) ?? filters[0];
  if (pick.services?.length) out.services = pick.services.map(toUuid);
  if (pick.name) out.name = pick.name;
  if (pick.namePrefix) out.namePrefix = pick.namePrefix;
  return out;
}

class CapCharacteristic extends EventTarget implements BluetoothRemoteGATTCharacteristic {
  value?: DataView;
  constructor(
    readonly service: CapService,
    readonly uuid: string,
    readonly properties: Record<string, boolean>,
  ) {
    super();
  }

  private get ids(): [string, string, string] {
    return [this.service.device.id, this.service.uuid, this.uuid];
  }

  private get timeout() {
    return { timeout: this.service.device.bt.operationTimeoutMs };
  }

  /** Der erste bestätigte Write einer Verbindung löst ggf. den Kopplungsdialog aus und darf länger dauern. */
  private async write(v: ArrayBuffer | ArrayBufferView, withResponse: boolean): Promise<void> {
    const server = this.service.server;
    server.requireConnected();
    const pairing = withResponse && server.pairingWritePending;
    if (pairing) server.pairingWritePending = false;
    const bt = this.service.device.bt;
    const opts = { timeout: pairing ? bt.pairingWriteTimeoutMs : bt.operationTimeoutMs };
    if (withResponse) await BleClient.write(...this.ids, toDataView(v), opts);
    else await BleClient.writeWithoutResponse(...this.ids, toDataView(v), opts);
  }

  async startNotifications(): Promise<this> {
    this.service.server.requireConnected();
    // Der Plugin-Callback liefert bereits eine DataView – sie wird ohne weitere Kopie durchgereicht.
    await BleClient.startNotifications(...this.ids, (v) => this.deliver(v), this.timeout);
    return this;
  }

  async stopNotifications(): Promise<this> {
    if (this.service.server.connected) await BleClient.stopNotifications(...this.ids);
    return this;
  }

  async readValue(): Promise<DataView> {
    this.service.server.requireConnected();
    const v = await BleClient.read(...this.ids, this.timeout);
    this.deliver(v);
    return v;
  }

  writeValue(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.writeValueWithResponse(v);
  }

  writeValueWithResponse(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.write(v, true);
  }

  writeValueWithoutResponse(v: ArrayBuffer | ArrayBufferView): Promise<void> {
    return this.write(v, false);
  }

  private deliver(v: DataView): void {
    this.value = v;
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class CapService implements BluetoothRemoteGATTService {
  private chars = new Map<string, CapCharacteristic>();
  constructor(
    readonly server: CapGattServer,
    readonly device: CapDevice,
    readonly uuid: string,
    private readonly raw: BleService,
  ) {}

  async getCharacteristic(characteristic: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic> {
    this.server.requireConnected();
    const uuid = toUuid(characteristic);
    const raw = this.raw.characteristics.find((c) => c.uuid.toLowerCase() === uuid);
    if (!raw) throw domError('NotFoundError', `Characteristic ${uuid} nicht gefunden`);
    let ch = this.chars.get(uuid);
    if (!ch) {
      ch = new CapCharacteristic(this, uuid, { ...raw.properties });
      this.chars.set(uuid, ch);
    }
    return ch;
  }

  async getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]> {
    return Promise.all(this.raw.characteristics.map((c) => this.getCharacteristic(c.uuid)));
  }
}

class CapGattServer implements BluetoothRemoteGATTServer {
  connected = false;
  /** Steht noch der erste bestätigte Write dieser Verbindung aus (Kopplungsdialog)? */
  pairingWritePending = false;
  /** Zählt Auf-/Abbauten, damit veraltete Callbacks (alte Verbindung) nichts mehr auslösen. */
  private gen = 0;
  private services: Promise<Map<string, CapService>> | null = null;
  /** Laufender Verbindungsaufbau – ein zweites connect() bekommt dasselbe Promise. */
  private pending: Promise<BluetoothRemoteGATTServer> | null = null;

  constructor(readonly device: CapDevice) {}

  connect(): Promise<BluetoothRemoteGATTServer> {
    if (this.connected) return Promise.resolve(this);
    if (!this.pending) {
      const p = this.doConnect();
      this.pending = p;
      const clear = () => {
        if (this.pending === p) this.pending = null;
      };
      p.then(clear, clear);
    }
    return this.pending;
  }

  private async doConnect(): Promise<BluetoothRemoteGATTServer> {
    const gen = ++this.gen;
    await this.device.bt.ensureReady();
    if (gen !== this.gen) throw domError('NetworkError', 'Verbindungsaufbau abgebrochen');
    try {
      await BleClient.connect(this.device.id, () => this.onLinkLost(gen), { timeout: this.device.bt.connectTimeoutMs });
    } catch (e) {
      if (PLUGIN_CONNECT_TIMEOUT.test(errMsg(e))) {
        throw domError('NetworkError', 'Band nicht erreichbar (Zeitüberschreitung beim Verbinden). Ist es in der Nähe und nicht mit einer anderen App verbunden?');
      }
      throw e;
    }
    if (gen !== this.gen) {
      // Während des Aufbaus wurde disconnect() aufgerufen.
      void BluetoothLe.disconnect({ deviceId: this.device.id }).catch(() => {});
      throw domError('NetworkError', 'Verbindungsaufbau abgebrochen');
    }
    this.connected = true;
    this.pairingWritePending = true;
    this.services = null;
    return this;
  }

  disconnect(): void {
    this.gen++;
    // Ein danach aufgerufenes connect() startet neu und hängt sich nicht an den abgebrochenen Aufbau.
    this.pending = null;
    // Direkt am Plugin vorbei an der BleClient-Warteschlange: ein hängender Write soll den Abbau nicht blockieren.
    void BluetoothLe.disconnect({ deviceId: this.device.id }).catch(() => {});
    this.markDisconnected();
  }

  async getPrimaryService(service: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService> {
    const uuid = toUuid(service);
    const svc = (await this.loadServices()).get(uuid);
    if (!svc) throw domError('NotFoundError', `Dienst ${uuid} nicht gefunden`);
    return svc;
  }

  async getPrimaryServices(service?: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService[]> {
    const all = [...(await this.loadServices()).values()];
    return service === undefined ? all : all.filter((s) => s.uuid === toUuid(service));
  }

  requireConnected(): void {
    if (!this.connected) throw domError('NetworkError', 'GATT-Server ist nicht verbunden');
  }

  private loadServices(): Promise<Map<string, CapService>> {
    this.requireConnected();
    if (!this.services) {
      const gen = this.gen;
      this.services = BleClient.getServices(this.device.id).then((list) => {
        const map = new Map<string, CapService>();
        for (const s of list) {
          const uuid = s.uuid.toLowerCase();
          map.set(uuid, new CapService(this, this.device, uuid, s));
        }
        return map;
      });
      this.services.catch(() => {
        if (gen === this.gen) this.services = null;
      });
    }
    return this.services;
  }

  private onLinkLost(gen: number): void {
    if (gen !== this.gen) return;
    this.markDisconnected();
  }

  private markDisconnected(): void {
    this.services = null;
    this.pairingWritePending = false;
    if (!this.connected) return;
    this.connected = false;
    this.device.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

class CapDevice extends EventTarget implements BluetoothDevice {
  readonly gatt: CapGattServer;
  constructor(
    readonly bt: CapacitorBluetooth,
    readonly id: string,
    public name: string | undefined,
  ) {
    super();
    this.gatt = new CapGattServer(this);
  }
}

export class CapacitorBluetooth implements Bluetooth {
  readonly connectTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly pairingWriteTimeoutMs: number;
  private readonly storage: CapacitorBluetoothOptions['storage'];
  private ready: Promise<void> | null = null;
  private devices = new Map<string, CapDevice>();

  constructor(opts: CapacitorBluetoothOptions = {}) {
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 18_000;
    this.operationTimeoutMs = opts.operationTimeoutMs ?? 9_000;
    this.pairingWriteTimeoutMs = opts.pairingWriteTimeoutMs ?? 29_000;
    this.storage = opts.storage !== undefined ? opts.storage : safeLocalStorage();
  }

  /** Initialisiert CoreBluetooth einmalig (iOS fragt dabei nach der Bluetooth-Erlaubnis). */
  async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = BleClient.initialize().catch((e) => {
        this.ready = null;
        const msg = errMsg(e);
        if (/permission|unauthori/i.test(msg)) {
          throw new Error('Bluetooth-Zugriff nicht erlaubt – in den iOS-Einstellungen → Whoop Plus → Bluetooth erlauben');
        }
        throw new Error(`Bluetooth nicht verfügbar (${msg})`);
      });
    }
    await this.ready;
    if (!(await BleClient.isEnabled())) throw new Error('Bluetooth ist ausgeschaltet');
  }

  async getAvailability(): Promise<boolean> {
    try {
      await this.ensureReady();
      return true;
    } catch {
      return false;
    }
  }

  async requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice> {
    await this.ensureReady();
    let picked;
    try {
      picked = await BleClient.requestDevice(toRequestOptions(options));
    } catch (e) {
      const msg = errMsg(e);
      if (/cancel/i.test(msg)) throw domError('NotFoundError', `Gerätewahl abgebrochen (${msg})`);
      throw e;
    }
    const dev = this.device(picked.deviceId, picked.name);
    this.remember({ id: dev.id, name: dev.name });
    return dev;
  }

  /** Liefert das zuletzt gewählte Band (sofern iOS es noch kennt) – für das Verbinden ohne Dialog. */
  async getDevices(): Promise<BluetoothDevice[]> {
    const stored = this.stored();
    if (!stored) return [];
    await this.ensureReady();
    const found = await BleClient.getDevices([stored.id]);
    return found
      .filter((d) => d.deviceId === stored.id)
      .map((d) => this.device(d.deviceId, d.name ?? stored.name));
  }

  /** Vergisst das gemerkte Band (nächstes Verbinden zeigt wieder den Auswahldialog). */
  forget(): void {
    try {
      this.storage?.removeItem(DEVICE_STORAGE_KEY);
    } catch {
      /* egal */
    }
  }

  private device(id: string, name?: string): CapDevice {
    let dev = this.devices.get(id);
    if (!dev) {
      dev = new CapDevice(this, id, name);
      this.devices.set(id, dev);
    } else if (name) dev.name = name;
    return dev;
  }

  private stored(): StoredDevice | null {
    try {
      const raw = this.storage?.getItem(DEVICE_STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<StoredDevice>;
      return typeof v.id === 'string' && v.id ? { id: v.id, name: typeof v.name === 'string' ? v.name : undefined } : null;
    } catch {
      return null;
    }
  }

  private remember(d: StoredDevice): void {
    try {
      this.storage?.setItem(DEVICE_STORAGE_KEY, JSON.stringify(d));
    } catch {
      /* Speicher voll/gesperrt – dann eben mit Dialog */
    }
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createCapacitorBluetooth(opts?: CapacitorBluetoothOptions): CapacitorBluetooth {
  return new CapacitorBluetooth(opts);
}
