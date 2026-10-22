import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoYalePlatform } from "../dist/platform.js";
import { ADDRESS, createApi, createLog, FakeBus, FakeLock, FakePlatformAccessory, FAST_TIMING, KEY, SLOT, until } from "./fakes.mjs";

const UUID = `uuid:homebridge-go-yale:${ADDRESS}`;

function createPlatform(config = {}, bus = new FakeBus(new FakeLock())) {
  const { messages, logger } = createLog();
  const api = createApi();
  const platform = new GoYalePlatform(logger, {
    platform: "GoYale",
    locks: [{ name: "Front Door", address: ADDRESS, key: KEY, slot: SLOT }],
    pollIntervalSeconds: 0,
    ...config
  }, api, () => bus, FAST_TIMING);
  return { api, bus, messages, platform };
}

describe("GoYalePlatform", () => {
  it("registers configured locks and logs skipped entries", async () => {
    const { api, messages, platform } = createPlatform({
      locks: [{ name: "Front Door", address: ADDRESS, key: KEY, slot: SLOT }, { name: "Back Door", address: "nope" }]
    });
    api.emit("didFinishLaunching");

    assert.deepEqual(api.registered.map((accessory) => [accessory.displayName, accessory.UUID, accessory.context.address]), [
      ["Front Door", UUID, ADDRESS]
    ]);
    assert.deepEqual(messages.error, ["Lock 2 skipped: address must be a Bluetooth address like A4:C1:38:5E:2D:73."]);
    assert.deepEqual(messages.info, [`Adding lock Front Door (${ADDRESS}).`]);
    await platform.stop();
  });

  it("restores cached locks and removes ones no longer configured", async () => {
    const { api, messages, platform } = createPlatform();
    const cached = new FakePlatformAccessory("Front Door", UUID);
    const stale = new FakePlatformAccessory("Garage", "uuid:homebridge-go-yale:00:11:22:33:44:55");
    platform.configureAccessory(cached);
    platform.configureAccessory(stale);
    api.emit("didFinishLaunching");

    assert.deepEqual(api.registered, []);
    assert.deepEqual(api.unregistered, [stale]);
    assert.deepEqual(messages.info, [`Restored lock Front Door (${ADDRESS}).`]);
    assert.deepEqual(messages.warn, ["Removing lock Garage; it is no longer configured."]);
    await platform.stop();
  });

  it("stops locks and closes the bus on shutdown", async () => {
    const { api, bus } = createPlatform();
    api.emit("didFinishLaunching");
    await until(() => bus.calls.includes("org.bluez.Device1.Connect"));
    api.emit("shutdown");

    await until(() => bus.disconnected);
    assert.equal(bus.connected, false);
  });
});
