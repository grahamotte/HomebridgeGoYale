import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { describe, YaleLock, type LockSettings, type LockTiming } from "./lock.js";
import type { GoYalePlatform } from "./platform.js";
import type { LockStatus, StatusUpdate } from "./protocol.js";

const LOW_BATTERY_PERCENT = 20;

export class YaleLockAccessory {
  private readonly lock: YaleLock;
  private readonly mechanism: Service;
  private readonly battery: Service;
  private current: number;
  private target: number;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: GoYalePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly settings: LockSettings,
    timing: LockTiming,
  ) {
    const { Characteristic, Service } = platform;
    this.current = Characteristic.LockCurrentState.UNKNOWN;
    this.target = Characteristic.LockTargetState.SECURED;
    this.lock = new YaleLock(platform.bluez, settings, {
      debug: (message) => platform.log.debug(message),
      info: (message) => platform.log.info(message),
      warn: (message) => platform.log.warn(message)
    }, (update) => this.apply(update), timing);
    this.mechanism = accessory.getService(Service.LockMechanism) ?? accessory.addService(Service.LockMechanism);
    this.battery = accessory.getService(Service.Battery) ?? accessory.addService(Service.Battery);

    this.setInfo();
    this.bind();
    this.startPolling();
    this.refresh();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.lock.stop();
  }

  private setInfo(): void {
    const { Characteristic, Service } = this.platform;
    this.accessory
      .getService(Service.AccessoryInformation)
      ?.setCharacteristic(Characteristic.Manufacturer, "Yale")
      .setCharacteristic(Characteristic.Model, "Bluetooth Lock")
      .setCharacteristic(Characteristic.SerialNumber, this.settings.address)
      .setCharacteristic(Characteristic.Name, this.settings.name);
    this.mechanism.setCharacteristic(Characteristic.Name, this.settings.name);
    this.battery.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);
  }

  private bind(): void {
    const { Characteristic } = this.platform;
    this.mechanism.getCharacteristic(Characteristic.LockCurrentState).onGet(() => this.current);
    this.mechanism.getCharacteristic(Characteristic.LockTargetState)
      .onGet(() => this.target)
      .onSet((value) => this.setTarget(value));
  }

  private startPolling(): void {
    if (this.platform.settings.pollIntervalMs === 0) {
      return;
    }

    this.pollTimer = setInterval(() => this.refresh(), this.platform.settings.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private refresh(): void {
    this.lock.refresh()
      .then((snapshot) => {
        this.apply({ kind: "lock", status: snapshot.lock });
        if (snapshot.battery !== undefined) {
          this.apply({ kind: "battery", voltage: 0, percentage: snapshot.battery });
        }
      })
      .catch((error: unknown) => {
        this.platform.log.warn(`${this.settings.name}: refresh failed: ${describe(error)}`);
      });
  }

  private setTarget(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    const locked = Number(value) === Characteristic.LockTargetState.SECURED;
    this.target = locked ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED;
    this.platform.log.info(`${this.settings.name}: ${locked ? "locking" : "unlocking"}`);
    this.lock.setLocked(locked)
      .then(() => {
        this.platform.log.info(`${this.settings.name}: ${locked ? "locked" : "unlocked"}`);
      })
      .catch((error: unknown) => {
        this.platform.log.warn(`${this.settings.name}: ${locked ? "lock" : "unlock"} failed: ${describe(error)}`);
        this.refresh();
      });
  }

  private apply(update: StatusUpdate): void {
    const { Characteristic } = this.platform;
    if (update.kind === "battery") {
      this.battery.getCharacteristic(Characteristic.BatteryLevel).updateValue(update.percentage);
      this.battery.getCharacteristic(Characteristic.StatusLowBattery).updateValue(update.percentage < LOW_BATTERY_PERCENT
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      return;
    }

    if (update.kind !== "lock") {
      return;
    }

    const current = this.currentState(update.status);
    if (current === undefined) {
      return;
    }

    this.current = current;
    this.mechanism.getCharacteristic(Characteristic.LockCurrentState).updateValue(current);
    if (current === Characteristic.LockCurrentState.SECURED || current === Characteristic.LockCurrentState.UNSECURED) {
      this.target = current === Characteristic.LockCurrentState.SECURED
        ? Characteristic.LockTargetState.SECURED
        : Characteristic.LockTargetState.UNSECURED;
      this.mechanism.getCharacteristic(Characteristic.LockTargetState).updateValue(this.target);
    }
  }

  private currentState(status: LockStatus): number | undefined {
    const { LockCurrentState } = this.platform.Characteristic;
    switch (status) {
      case "locked":
      case "securemode":
        return LockCurrentState.SECURED;
      case "unlocked":
      case "unlatched":
        return LockCurrentState.UNSECURED;
      case "jammed":
        return LockCurrentState.JAMMED;
      case "locking":
      case "unlocking":
      case "unlatching":
        return undefined;
      default:
        return LockCurrentState.UNKNOWN;
    }
  }
}
