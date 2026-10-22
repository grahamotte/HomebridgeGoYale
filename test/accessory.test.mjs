import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoYalePlatform } from "../dist/platform.js";
import { ADDRESS, createApi, createLog, FakeBus, FakeLock, FAST_TIMING, KEY, SLOT, until } from "./fakes.mjs";

async function createAccessory(fakeLock = new FakeLock(), config = {}) {
  const { messages, logger } = createLog();
  const api = createApi();
  const bus = new FakeBus(fakeLock);
  const platform = new GoYalePlatform(logger, {
    platform: "GoYale",
    locks: [{ name: "Front Door", address: ADDRESS, key: KEY, slot: SLOT }],
    pollIntervalSeconds: 0,
    ...config
  }, api, () => bus, FAST_TIMING);
  api.emit("didFinishLaunching");
  const accessory = api.registered[0];
  const mechanism = accessory.getService("LockMechanism");
  const battery = accessory.getService("Battery");
  const current = mechanism.getCharacteristic({ name: "LockCurrentState" });
  const target = mechanism.getCharacteristic({ name: "LockTargetState" });
  return { accessory, battery, bus, current, fakeLock, messages, platform, target };
}

describe("YaleLockAccessory", () => {
  it("publishes accessory information and the initial state", async () => {
    const { accessory, battery, current, platform, target } = await createAccessory();
    const info = accessory.getService("AccessoryInformation");

    assert.equal(info.getCharacteristic({ name: "Manufacturer" }).value, "Yale");
    assert.equal(info.getCharacteristic({ name: "SerialNumber" }).value, ADDRESS);
    assert.equal(battery.getCharacteristic({ name: "ChargingState" }).value, 2);
    assert.equal(current.getHandler(), 3);

    await until(() => current.value === 1 && battery.getCharacteristic({ name: "BatteryLevel" }).value !== undefined);
    assert.equal(current.getHandler(), 1);
    assert.equal(target.value, 1);
    assert.equal(target.getHandler(), 1);
    assert.equal(battery.getCharacteristic({ name: "BatteryLevel" }).value, 93);
    assert.equal(battery.getCharacteristic({ name: "StatusLowBattery" }).value, 0);
    await platform.stop();
  });

  it("unlocks and locks from HomeKit", async () => {
    const { current, fakeLock, messages, platform, target } = await createAccessory();
    await until(() => current.value === 1);

    target.setHandler(0);
    assert.equal(target.getHandler(), 0);
    await until(() => current.value === 0);
    assert.equal(fakeLock.status, "unlocked");

    target.setHandler(1);
    await until(() => current.value === 1);
    assert.equal(fakeLock.status, "locked");
    assert.deepEqual(messages.info.filter((message) => message.startsWith("Front Door")), [
      "Front Door: unlocking",
      "Front Door: unlocked",
      "Front Door: locking",
      "Front Door: locked"
    ]);
    await platform.stop();
  });

  it("shows a jam and restores the target when an operation fails", async () => {
    const { current, fakeLock, messages, platform, target } = await createAccessory();
    await until(() => current.value === 1);
    fakeLock.operationResult = 0x1e;

    target.setHandler(0);
    await until(() => messages.warn.length > 0);
    assert.deepEqual(messages.warn, ["Front Door: unlock failed: Lock reported operation failure 0x1e"]);
    assert.equal(current.value, 2);
    await until(() => current.value === 1);
    assert.equal(target.value, 1);
    assert.equal(target.getHandler(), 1);
    await platform.stop();
  });

  it("follows status pushes and low batteries", async () => {
    const fakeLock = new FakeLock();
    fakeLock.batteryMillivolts = 5000;
    const { battery, bus, current, platform, target } = await createAccessory(fakeLock, { keepConnected: true });
    await until(() => battery.getCharacteristic({ name: "StatusLowBattery" }).value !== undefined);
    assert.equal(battery.getCharacteristic({ name: "StatusLowBattery" }).value, 1);
    assert.equal(current.value, 1);

    bus.pushStatus("unlocked");
    await until(() => current.value === 0);
    assert.equal(target.value, 0);

    bus.pushStatus("jammed");
    await until(() => current.value === 2);
    assert.equal(target.value, 0);
    await platform.stop();
  });

  it("runs only the latest request", async () => {
    const { current, fakeLock, messages, platform, target } = await createAccessory();
    await until(() => current.value === 1);

    target.setHandler(0);
    target.setHandler(1);
    await until(() => messages.info.includes("Front Door: locked"));
    assert.equal(fakeLock.commands.includes("10:0"), false);
    assert.equal(fakeLock.status, "locked");
    assert.deepEqual(messages.debug.filter((message) => message.includes("superseded")), ["Front Door: unlock request superseded"]);
    assert.equal(target.getHandler(), 1);
    await platform.stop();
  });

  it("expires a request that cannot reach the lock in time", async (t) => {
    const { current, fakeLock, messages, platform, target } = await createAccessory();
    await until(() => current.value === 1);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });

    target.setHandler(0);
    t.mock.timers.tick(181000);
    await until(() => messages.warn.length > 0);
    assert.deepEqual(messages.warn, ["Front Door: unlock request expired before reaching the lock"]);
    assert.equal(fakeLock.status, "locked");
    assert.equal(target.value, 1);
    assert.equal(target.getHandler(), 1);
    await platform.stop();
  });

  it("skips a background refresh while a request is pending", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { current, fakeLock, messages, platform, target } = await createAccessory(new FakeLock(), { pollIntervalSeconds: 60 });
    await until(() => current.value === 1);
    const before = fakeLock.commands.length;

    t.mock.timers.tick(60000);
    target.setHandler(0);
    await until(() => messages.info.includes("Front Door: unlocked"));
    assert.deepEqual(messages.debug.filter((message) => message.includes("refresh skipped")), ["Front Door: refresh skipped for a lock request"]);
    assert.equal(fakeLock.commands.slice(before).filter((command) => command === "2:2").length, 0);
    await platform.stop();
  });

  it("logs refresh failures", async () => {
    const { messages, platform } = await createAccessory(new FakeLock({ slot: 9 }));

    await until(() => messages.warn.length > 0);
    assert.deepEqual(messages.warn, ["Front Door: refresh failed: Lock rejected the key; check the key and slot"]);
    await platform.stop();
  });
});
