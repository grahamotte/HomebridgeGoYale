import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service
} from "homebridge";
import { YaleLockAccessory } from "./accessory.js";
import { Bluez, type BusFactory } from "./bluez.js";
import { parseConfig, type GoYaleConfig } from "./config.js";
import { DEFAULT_TIMING, type LockSettings, type LockTiming } from "./lock.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

interface Context {
  address?: string;
}

export class GoYalePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly settings: GoYaleConfig;
  public readonly bluez: Bluez;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly controllers = new Map<string, YaleLockAccessory>();
  private readonly timing: LockTiming;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
    createBus?: BusFactory,
    timing: Partial<LockTiming> = {},
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    const { settings, problems } = parseConfig(config);
    this.settings = settings;
    this.timing = { ...DEFAULT_TIMING, idleDisconnectMs: settings.idleDisconnectMs, ...timing };
    this.bluez = new Bluez(createBus, settings.adapter);
    for (const problem of problems) {
      this.log.error(`Lock ${problem.index + 1} skipped: ${problem.message}.`);
    }

    api.on("didFinishLaunching", () => this.sync());
    api.on("shutdown", () => {
      this.stop().catch(() => undefined);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  sync(): void {
    const seen = new Set<string>();
    for (const lock of this.settings.locks) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${lock.address}`);
      seen.add(uuid);
      const cached = this.accessories.get(uuid);
      const accessory = cached ?? new this.api.platformAccessory(lock.name, uuid);
      (accessory.context as Context).address = lock.address;
      this.attach(uuid, accessory, lock);
      if (cached) {
        this.log.info(`Restored lock ${lock.name} (${lock.address}).`);
      } else {
        this.log.info(`Adding lock ${lock.name} (${lock.address}).`);
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.log.warn(`Removing lock ${accessory.displayName}; it is no longer configured.`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  async stop(): Promise<void> {
    const controllers = [...this.controllers.values()];
    this.controllers.clear();
    await Promise.all(controllers.map((controller) => controller.stop()));
    this.bluez.close();
  }

  private attach(uuid: string, accessory: PlatformAccessory, lock: LockSettings): void {
    const previous = this.controllers.get(uuid);
    previous?.stop().catch(() => undefined);
    this.controllers.set(uuid, new YaleLockAccessory(this, accessory, lock, this.timing));
  }
}
