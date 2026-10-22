import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import dbus from "dbus-next";

export const ADDRESS = "A4:C1:38:5E:2D:73";
export const KEY = "00112233445566778899aabbccddeeff";
export const SLOT = 1;
export const ADAPTER = "/org/bluez/hci0";
export const DEVICE = `${ADAPTER}/dev_A4_C1_38_5E_2D_73`;

const PROPERTIES = "org.freedesktop.DBus.Properties";
const CHARACTERISTICS = {
  "bd4ac611-0b45-11e3-8ffd-0800200c9a66": `${DEVICE}/service0010/char0011`,
  "bd4ac612-0b45-11e3-8ffd-0800200c9a66": `${DEVICE}/service0010/char0013`,
  "bd4ac613-0b45-11e3-8ffd-0800200c9a66": `${DEVICE}/service0010/char0016`,
  "bd4ac614-0b45-11e3-8ffd-0800200c9a66": `${DEVICE}/service0010/char0018`
};
const STATUS_CODES = { unlocked: 0x03, locked: 0x05, jammed: 0x07 };

export class FakeLock {
  constructor({ key = KEY, slot = SLOT } = {}) {
    this.key = Buffer.from(key, "hex");
    this.slot = slot;
    this.status = "locked";
    this.batteryMillivolts = 6000;
    this.operationResult = 0;
    this.dropAck = false;
    this.commands = [];
    this.secureKey = this.key;
    this.encryptor = undefined;
    this.decryptor = undefined;
  }

  reset() {
    this.secureKey = this.key;
    this.encryptor = undefined;
    this.decryptor = undefined;
  }

  secureWrite(value) {
    const frame = ecb(createDecipheriv, this.secureKey, value);
    const opcode = frame[0];
    this.commands.push(`secure:${opcode}`);
    if (frame.readUInt32LE(0x0c) !== securityChecksum(frame)) {
      return [];
    }

    if (opcode === 0x01) {
      if (frame[0x11] !== this.slot) {
        return [this.secureReply(Buffer.alloc(18, 0))];
      }

      const random = randomBytes(8);
      const reply = Buffer.alloc(18);
      reply[0] = 0x02;
      random.copy(reply, 4);
      const encrypted = this.secureReply(reply);
      this.secureKey = Buffer.concat([frame.subarray(4, 12), random]);
      return [encrypted];
    }

    if (opcode === 0x03) {
      const reply = Buffer.alloc(18);
      reply[0] = 0x04;
      const encrypted = this.secureReply(reply);
      this.encryptor = createCipheriv("aes-128-cbc", this.secureKey, Buffer.alloc(16)).setAutoPadding(false);
      this.decryptor = createDecipheriv("aes-128-cbc", this.secureKey, Buffer.alloc(16)).setAutoPadding(false);
      return [encrypted];
    }

    if (opcode === 0x05) {
      const reply = Buffer.alloc(18);
      reply[0] = 0x8b;
      return [this.secureReply(reply)];
    }

    return [];
  }

  write(value) {
    const frame = Buffer.from(value);
    this.decryptor.update(value.subarray(0, 16)).copy(frame, 0);
    if (simpleChecksum(frame) !== 0 || frame[0] !== 0xee) {
      this.commands.push("invalid");
      return [];
    }

    const opcode = frame[1];
    const type = frame[4];
    this.commands.push(`${opcode}:${type}`);
    if (opcode === 0x02) {
      const reply = this.reply(0xbb, opcode, type);
      if (type === 0x0f) {
        reply.writeUInt16LE(this.batteryMillivolts, 8);
      } else {
        reply[8] = STATUS_CODES[this.status];
      }

      return [this.encrypt(reply)];
    }

    if (opcode === 0x0a || opcode === 0x0b) {
      const frames = this.dropAck ? [] : [this.encrypt(this.reply(0xaa, opcode, 0))];
      const result = this.reply(0xbb, opcode, 0);
      result[0x0f] = this.operationResult;
      if (this.operationResult === 0) {
        this.status = opcode === 0x0b ? "locked" : "unlocked";
      }

      frames.push(this.encrypt(result));
      return frames;
    }

    return [];
  }

  push(status) {
    this.status = status;
    const reply = this.reply(0xbb, 0x02, 0x02);
    reply[8] = STATUS_CODES[status];
    return this.encrypt(reply);
  }

  reply(flag, opcode, type) {
    const reply = Buffer.alloc(18);
    reply[0] = flag;
    reply[1] = opcode;
    reply[4] = type;
    reply[0x10] = 0x02;
    return reply;
  }

  encrypt(frame) {
    frame[3] = 0;
    frame[3] = simpleChecksum(frame);
    const output = Buffer.from(frame);
    this.encryptor.update(frame.subarray(0, 16)).copy(output, 0);
    return output;
  }

  secureReply(frame) {
    frame.writeUInt32LE(securityChecksum(frame), 0x0c);
    return ecb(createCipheriv, this.secureKey, frame);
  }
}

export class FakeBus extends EventEmitter {
  constructor(lock = new FakeLock(), { known = true, connectFailures = [], adapters = [ADAPTER], resolveLater = false } = {}) {
    super();
    this.lock = lock;
    this.known = known;
    this.connectFailures = [...connectFailures];
    this.adapters = adapters;
    this.resolveLater = resolveLater;
    this.connected = false;
    this.calls = [];
    this.notifying = new Set();
    this.connectError = undefined;
    this.disconnectOnWrite = 0;
    this.disconnected = false;
  }

  async call(message) {
    const name = `${message.interface}.${message.member}`;
    this.calls.push(name);
    switch (name) {
      case "org.freedesktop.DBus.AddMatch":
        return reply();
      case "org.freedesktop.DBus.ObjectManager.GetManagedObjects":
        return reply(this.objects());
      case `${PROPERTIES}.Get`:
        return reply(new dbus.Variant("b", this.property(message.path, message.body[1])));
      case "org.bluez.Adapter1.SetDiscoveryFilter":
      case "org.bluez.Adapter1.StopDiscovery":
        return reply();
      case "org.bluez.Adapter1.StartDiscovery":
        if (!this.known) {
          this.known = true;
          setImmediate(() => this.signal(dbus.Message.newSignal("/", "org.freedesktop.DBus.ObjectManager", "InterfacesAdded", "oa{sa{sv}}", [DEVICE, {}])));
        }

        return reply();
      case "org.bluez.Device1.Connect":
        return this.connect();
      case "org.bluez.Device1.Disconnect":
        this.dropConnection();
        return reply();
      case "org.bluez.GattCharacteristic1.StartNotify":
        this.notifying.add(message.path);
        return reply();
      case "org.bluez.GattCharacteristic1.WriteValue":
        return this.writeValue(message.path, message.body[0]);
      default:
        throw new dbus.DBusError("org.freedesktop.DBus.Error.UnknownMethod", `Unknown method ${name}`);
    }
  }

  disconnect() {
    this.disconnected = true;
  }

  resolveServices() {
    this.resolveLater = false;
    this.changed(DEVICE, "org.bluez.Device1", { ServicesResolved: new dbus.Variant("b", true) });
  }

  connect() {
    if (this.connectError) {
      throw new dbus.DBusError(this.connectError, "error");
    }

    const failure = this.connectFailures.shift();
    if (failure) {
      throw new dbus.DBusError("org.bluez.Error.Failed", failure);
    }

    this.connected = true;
    this.lock.reset();
    this.changed(DEVICE, "org.bluez.Device1", { Connected: new dbus.Variant("b", true) });
    if (this.resolveLater) {
      setImmediate(() => this.changed(DEVICE, "org.bluez.Device1", { ServicesResolved: new dbus.Variant("b", true) }));
    }

    return reply();
  }

  dropConnection() {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    this.notifying.clear();
    this.changed(DEVICE, "org.bluez.Device1", { Connected: new dbus.Variant("b", false) });
    this.emit("dropped");
  }

  writeValue(path, value) {
    if (!this.connected) {
      throw new dbus.DBusError("org.bluez.Error.Failed", "Not connected");
    }

    if (this.disconnectOnWrite > 0) {
      this.disconnectOnWrite--;
      setImmediate(() => this.dropConnection());
      return reply();
    }

    const secure = path === CHARACTERISTICS["bd4ac613-0b45-11e3-8ffd-0800200c9a66"];
    const target = secure ? CHARACTERISTICS["bd4ac614-0b45-11e3-8ffd-0800200c9a66"] : CHARACTERISTICS["bd4ac612-0b45-11e3-8ffd-0800200c9a66"];
    const frames = secure ? this.lock.secureWrite(value) : this.lock.write(value);
    setImmediate(() => {
      for (const frame of frames) {
        this.notify(target, frame);
      }
    });
    return reply();
  }

  notify(path, frame) {
    if (this.notifying.has(path)) {
      this.changed(path, "org.bluez.GattCharacteristic1", { Value: new dbus.Variant("ay", frame) });
    }
  }

  pushStatus(status) {
    this.notify(CHARACTERISTICS["bd4ac612-0b45-11e3-8ffd-0800200c9a66"], this.lock.push(status));
  }

  property(path, name) {
    if (path === DEVICE && name === "Connected") {
      return this.connected;
    }

    if (path === DEVICE && name === "ServicesResolved") {
      return this.connected && !this.resolveLater;
    }

    throw new dbus.DBusError("org.freedesktop.DBus.Error.UnknownObject", `Unknown property ${name}`);
  }

  objects() {
    const objects = {};
    for (const adapter of this.adapters) {
      objects[adapter] = { "org.bluez.Adapter1": {} };
    }

    if (this.known) {
      objects[DEVICE] = { "org.bluez.Device1": {} };
    }

    if (this.connected) {
      for (const [uuid, path] of Object.entries(CHARACTERISTICS)) {
        objects[path] = { "org.bluez.GattCharacteristic1": { UUID: new dbus.Variant("s", uuid.toUpperCase()) } };
      }
    }

    return objects;
  }

  changed(path, iface, properties) {
    this.signal(dbus.Message.newSignal(path, PROPERTIES, "PropertiesChanged", "sa{sv}as", [iface, properties, []]));
  }

  signal(message) {
    this.emit("message", message);
  }
}

export const FAST_TIMING = {
  discoveryTimeoutMs: 5000,
  connectTimeoutMs: 5000,
  connectAttempts: 3,
  responseTimeoutMs: 5000,
  ackTimeoutMs: 5000,
  operationTimeoutMs: 5000,
  cooldownMs: 0,
  idleDisconnectMs: -1
};

export function createLog() {
  const messages = { debug: [], error: [], info: [], warn: [] };
  const logger = {
    debug: (...parts) => messages.debug.push(parts.join(" ")),
    error: (...parts) => messages.error.push(parts.join(" ")),
    info: (...parts) => messages.info.push(parts.join(" ")),
    warn: (...parts) => messages.warn.push(parts.join(" "))
  };
  return { messages, logger };
}

export async function until(predicate) {
  for (let index = 0; index < 1000; index++) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error("condition was never met");
}

export async function settle() {
  for (let index = 0; index < 20; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function reply(...body) {
  return { body };
}

function ecb(factory, key, frame) {
  const output = Buffer.from(frame);
  factory("aes-128-ecb", key, null).setAutoPadding(false).update(frame.subarray(0, 16)).copy(output, 0);
  return output;
}

function securityChecksum(frame) {
  return (0x100000000 - ((frame.readUInt32LE(0) + frame.readUInt32LE(4) + frame.readUInt32LE(8)) % 0x100000000)) % 0x100000000;
}

function simpleChecksum(frame) {
  let sum = 0;
  for (let index = 0; index < 18; index++) {
    sum += frame[index];
  }

  return (0x100 - (sum % 0x100)) % 0x100;
}

export function createApi() {
  const handlers = {};
  const api = {
    hap: {
      Characteristic: {
        BatteryLevel: { name: "BatteryLevel" },
        ChargingState: { name: "ChargingState", NOT_CHARGEABLE: 2 },
        LockCurrentState: { name: "LockCurrentState", UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 },
        LockTargetState: { name: "LockTargetState", UNSECURED: 0, SECURED: 1 },
        Manufacturer: { name: "Manufacturer" },
        Model: { name: "Model" },
        Name: { name: "Name" },
        SerialNumber: { name: "SerialNumber" },
        StatusLowBattery: { name: "StatusLowBattery", BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }
      },
      Service: {
        AccessoryInformation: "AccessoryInformation",
        Battery: "Battery",
        LockMechanism: "LockMechanism"
      },
      uuid: {
        generate: (value) => `uuid:${value}`
      }
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
    emit: (event) => handlers[event]?.(),
    platformAccessory: FakePlatformAccessory,
    registered: [],
    unregistered: [],
    registerPlatformAccessories: (_plugin, _platform, accessories) => api.registered.push(...accessories),
    unregisterPlatformAccessories: (_plugin, _platform, accessories) => api.unregistered.push(...accessories)
  };
  return api;
}

export class FakePlatformAccessory {
  constructor(displayName, uuid) {
    this.context = {};
    this.displayName = displayName;
    this.UUID = uuid;
    this.services = new Map();
    this.addService("AccessoryInformation");
  }

  addService(name) {
    const service = new FakeService();
    this.services.set(name, service);
    return service;
  }

  getService(name) {
    return this.services.get(name);
  }
}

class FakeService {
  constructor() {
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type.name)) {
      this.characteristics.set(type.name, new FakeCharacteristic());
    }

    return this.characteristics.get(type.name);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

class FakeCharacteristic {
  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}
