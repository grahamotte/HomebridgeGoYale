import dbus from "dbus-next";
import type { Message, Variant } from "dbus-next";

const BLUEZ = "org.bluez";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
const ADAPTER = "org.bluez.Adapter1";
const DEVICE = "org.bluez.Device1";
const CHARACTERISTIC = "org.bluez.GattCharacteristic1";

type Properties = Record<string, Variant>;
type ManagedObjects = Record<string, Record<string, Properties>>;
type SignalHandler = (message: Message) => void;

export interface BusConnection {
  call(message: Message): Promise<Message | null>;
  on(event: "message", listener: (message: Message) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  disconnect(): void;
}

export type BusFactory = () => BusConnection;

export class BluetoothError extends Error {
  constructor(message: string, public readonly type = "") {
    super(message);
  }
}

export class Bluez {
  private bus?: BusConnection;
  private readonly signalHandlers = new Set<SignalHandler>();
  private matched?: Promise<void>;

  constructor(
    private readonly createBus: BusFactory = () => dbus.systemBus(),
    private readonly adapterName?: string,
  ) {}

  async device(address: string, timeoutMs: number): Promise<BluezDevice> {
    await this.ensureMatches();
    const adapter = await this.adapterPath();
    const path = `${adapter}/dev_${address.toUpperCase().replace(/:/gu, "_")}`;
    if (!(await this.managedObjects())[path]?.[DEVICE]) {
      await this.discover(adapter, path, timeoutMs);
    }

    return new BluezDevice(this, path);
  }

  close(): void {
    this.bus?.disconnect();
    this.bus = undefined;
    this.matched = undefined;
  }

  async call(path: string, iface: string, member: string, signature = "", body: unknown[] = []): Promise<unknown[]> {
    try {
      const reply = await this.connection().call(new dbus.Message({
        destination: path.startsWith("/org/freedesktop/DBus") ? "org.freedesktop.DBus" : BLUEZ,
        path,
        interface: iface,
        member,
        signature,
        body
      }));
      return reply?.body ?? [];
    } catch (error) {
      throw toBluetoothError(error);
    }
  }

  async property(path: string, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call(path, PROPERTIES, "Get", "ss", [iface, name]);
    return value instanceof dbus.Variant ? value.value : value;
  }

  async managedObjects(): Promise<ManagedObjects> {
    const [objects] = await this.call("/", OBJECT_MANAGER, "GetManagedObjects");
    return (objects ?? {}) as ManagedObjects;
  }

  subscribe(handler: SignalHandler): () => void {
    this.signalHandlers.add(handler);
    return () => this.signalHandlers.delete(handler);
  }

  private connection(): BusConnection {
    if (!this.bus) {
      const bus = this.createBus();
      bus.on("message", (message) => {
        if (message.type === dbus.MessageType.SIGNAL) {
          for (const handler of [...this.signalHandlers]) {
            handler(message);
          }
        }
      });
      bus.on("error", () => {
        if (this.bus === bus) {
          this.bus = undefined;
          this.matched = undefined;
        }
      });
      this.bus = bus;
    }

    return this.bus;
  }

  private ensureMatches(): Promise<void> {
    this.matched ??= Promise.all([
      `type='signal',sender='${BLUEZ}',interface='${PROPERTIES}',member='PropertiesChanged'`,
      `type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}',member='InterfacesAdded'`
    ].map((rule) => this.call("/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [rule])))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.matched = undefined;
        throw error;
      });
    return this.matched;
  }

  private async adapterPath(): Promise<string> {
    const adapters = Object.entries(await this.managedObjects())
      .filter(([, interfaces]) => interfaces[ADAPTER])
      .map(([path]) => path)
      .sort();
    const adapter = this.adapterName
      ? adapters.find((path) => path.endsWith(`/${this.adapterName}`))
      : adapters[0];
    if (!adapter) {
      throw new BluetoothError(this.adapterName ? `Bluetooth adapter ${this.adapterName} not found` : "No Bluetooth adapter found");
    }

    return adapter;
  }

  private async discover(adapter: string, path: string, timeoutMs: number): Promise<void> {
    const found = this.waitFor(timeoutMs, `Lock ${path} was not found within ${timeoutMs / 1000}s`, (message, resolve) => {
      if (message.interface === OBJECT_MANAGER && message.member === "InterfacesAdded" && message.body[0] === path) {
        resolve();
      }
    });
    await this.call(adapter, ADAPTER, "SetDiscoveryFilter", "a{sv}", [{ Transport: new dbus.Variant("s", "le") }]);
    await this.call(adapter, ADAPTER, "StartDiscovery").catch((error: unknown) => {
      if (!(error instanceof BluetoothError && error.type === "org.bluez.Error.InProgress")) {
        throw error;
      }
    });
    try {
      if (!(await this.managedObjects())[path]?.[DEVICE]) {
        await found.promise;
      }
    } finally {
      found.cancel();
      await this.call(adapter, ADAPTER, "StopDiscovery").catch(() => undefined);
    }
  }

  waitFor(
    timeoutMs: number,
    timeoutMessage: string,
    check: (message: Message, resolve: () => void, reject: (error: Error) => void) => void,
  ): { promise: Promise<void>; cancel: () => void } {
    let cancel = () => undefined as void;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancel();
        reject(new BluetoothError(timeoutMessage, "timeout"));
      }, timeoutMs);
      const unsubscribe = this.subscribe((message) => check(message, () => {
        cancel();
        resolve();
      }, (error) => {
        cancel();
        reject(error);
      }));
      cancel = () => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
    promise.catch(() => undefined);
    return { promise, cancel };
  }
}

export class BluezDevice {
  private readonly notifyHandlers = new Map<string, (value: Buffer) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly bluez: Bluez, readonly path: string) {
    this.unsubscribe = bluez.subscribe((message) => this.handleSignal(message));
  }

  async connect(timeoutMs: number): Promise<void> {
    const resolved = this.bluez.waitFor(timeoutMs, "Lock services were not resolved", (message, resolve, reject) => {
      if (message.path !== this.path) {
        return;
      }

      const properties = changed(message, DEVICE);
      if (properties.ServicesResolved?.value === true) {
        resolve();
      } else if (properties.Connected?.value === false) {
        reject(new BluetoothError("Lock disconnected during service discovery"));
      }
    });
    try {
      if (!(await this.bluez.property(this.path, DEVICE, "Connected"))) {
        await this.bluez.call(this.path, DEVICE, "Connect").catch((error: unknown) => {
          if (!(error instanceof BluetoothError && error.type === "org.bluez.Error.InProgress")) {
            throw error;
          }
        });
      }

      if (!(await this.bluez.property(this.path, DEVICE, "ServicesResolved"))) {
        await resolved.promise;
      }
    } finally {
      resolved.cancel();
    }
  }

  async characteristics(uuids: readonly string[]): Promise<Record<string, string>> {
    const objects = await this.bluez.managedObjects();
    const found: Record<string, string> = {};
    for (const [path, interfaces] of Object.entries(objects)) {
      const uuid = interfaces[CHARACTERISTIC]?.UUID?.value;
      if (path.startsWith(`${this.path}/`) && typeof uuid === "string" && uuids.includes(uuid.toLowerCase())) {
        found[uuid.toLowerCase()] = path;
      }
    }

    const missing = uuids.filter((uuid) => !found[uuid]);
    if (missing.length > 0) {
      throw new BluetoothError(`Lock characteristics missing: ${missing.join(", ")}`);
    }

    return found;
  }

  async write(path: string, value: Buffer): Promise<void> {
    await this.bluez.call(path, CHARACTERISTIC, "WriteValue", "aya{sv}", [value, { type: new dbus.Variant("s", "request") }]);
  }

  async startNotify(path: string, handler: (value: Buffer) => void): Promise<void> {
    this.notifyHandlers.set(path, handler);
    await this.bluez.call(path, CHARACTERISTIC, "StartNotify");
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.add(handler);
  }

  async disconnect(): Promise<void> {
    this.close();
    await this.bluez.call(this.path, DEVICE, "Disconnect").catch(() => undefined);
  }

  close(): void {
    this.unsubscribe();
    this.notifyHandlers.clear();
    this.disconnectHandlers.clear();
  }

  private handleSignal(message: Message): void {
    if (message.path === this.path) {
      if (changed(message, DEVICE).Connected?.value === false) {
        for (const handler of [...this.disconnectHandlers]) {
          handler();
        }
      }

      return;
    }

    const handler = this.notifyHandlers.get(message.path);
    const value = changed(message, CHARACTERISTIC).Value?.value;
    if (handler && Buffer.isBuffer(value)) {
      handler(value);
    }
  }
}

function changed(message: Message, iface: string): Properties {
  return message.interface === PROPERTIES && message.member === "PropertiesChanged" && message.body[0] === iface
    ? (message.body[1] ?? {}) as Properties
    : {};
}

function toBluetoothError(error: unknown): BluetoothError {
  if (error instanceof BluetoothError) {
    return error;
  }

  if (error instanceof dbus.DBusError) {
    return new BluetoothError(error.text || error.type, error.type);
  }

  return new BluetoothError(error instanceof Error ? error.message : String(error));
}
