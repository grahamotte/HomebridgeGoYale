import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { Bluez } from "../dist/bluez.js";
import { LockError, RequestCancelled, YaleLock } from "../dist/lock.js";
import { ADDRESS, createLog, FakeBus, FakeLock, FAST_TIMING, KEY, settle, SLOT } from "./fakes.mjs";

function createLock(options = {}) {
  const fakeLock = options.lock ?? new FakeLock();
  const bus = new FakeBus(fakeLock, options.bus);
  const { messages, logger } = createLog();
  const updates = [];
  const lock = new YaleLock(
    new Bluez(() => bus),
    { name: "Front Door", address: ADDRESS, key: options.key ?? KEY, slot: options.slot ?? SLOT },
    logger,
    (update) => updates.push(update),
    { ...FAST_TIMING, ...options.timing },
  );
  return { bus, fakeLock, lock, messages, updates };
}

describe("YaleLock", () => {
  it("handshakes and reads lock state and battery", async () => {
    const { fakeLock, lock, updates } = createLock();

    assert.deepEqual(await lock.refresh(), { lock: "locked", battery: 93 });
    assert.deepEqual(fakeLock.commands, ["secure:1", "secure:3", "2:2", "2:15"]);
    assert.deepEqual(updates, [
      { kind: "lock", status: "locked" },
      { kind: "battery", voltage: 6, percentage: 93 }
    ]);
    await lock.stop();
    assert.deepEqual(fakeLock.commands.slice(-1), ["secure:5"]);
  });

  it("unlocks and locks over one session", async () => {
    const { bus, fakeLock, lock, updates } = createLock();

    await lock.setLocked(false);
    assert.equal(fakeLock.status, "unlocked");
    await lock.setLocked(true);
    assert.equal(fakeLock.status, "locked");
    assert.deepEqual(fakeLock.commands, ["secure:1", "secure:3", "10:0", "11:0"]);
    assert.deepEqual(updates.map((update) => update.status), ["unlocked", "locked"]);
    assert.equal(bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length, 1);
    await lock.stop();
  });

  it("completes an operation when the acknowledgment is missing", async () => {
    const { fakeLock, lock } = createLock();
    fakeLock.dropAck = true;

    await lock.setLocked(false);
    assert.equal(fakeLock.status, "unlocked");
    await lock.stop();
  });

  it("does not retry an operation the lock reports as failed", async () => {
    const { fakeLock, lock, updates } = createLock();
    fakeLock.operationResult = 0x1e;

    await assert.rejects(lock.setLocked(false), (error) => error instanceof LockError && /0x1e/u.test(error.message));
    assert.deepEqual(fakeLock.commands, ["secure:1", "secure:3", "10:0"]);
    assert.deepEqual(updates, [{ kind: "lock", status: "jammed" }]);
    await lock.stop();
  });

  it("retries connection failures", async () => {
    const { bus, lock, messages } = createLock({ bus: { connectFailures: ["le-connection-abort-by-local", "Software caused connection abort"] } });

    assert.equal((await lock.refresh()).lock, "locked");
    assert.equal(bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length, 3);
    assert.deepEqual(messages.debug.filter((message) => message.includes("connect attempt")), [
      "Front Door: connect attempt 1 failed: le-connection-abort-by-local",
      "Front Door: connect attempt 2 failed: Software caused connection abort"
    ]);
    await lock.stop();
  });

  it("gives up after the configured connection attempts", async () => {
    const { lock } = createLock({
      bus: { connectFailures: ["one", "two", "three", "four", "five", "six"] },
      timing: { connectAttempts: 2 }
    });

    await assert.rejects(lock.refresh(), /Could not connect to the lock: four/u);
    await lock.stop();
  });

  it("rejects a wrong slot without retrying", async () => {
    const { bus, lock } = createLock({ slot: 4 });

    await assert.rejects(lock.refresh(), (error) => error instanceof LockError && !error.retryable && /check the key and slot/u.test(error.message));
    assert.equal(bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length, 1);
    assert.equal(bus.connected, false);
    await lock.stop();
  });

  it("retries an operation when the lock disconnects before acknowledging", async () => {
    const { bus, fakeLock, lock } = createLock();
    await lock.refresh();
    bus.disconnectOnWrite = 1;

    await lock.setLocked(false);
    assert.equal(fakeLock.status, "unlocked");
    assert.equal(bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length, 2);
    await lock.stop();
  });

  it("reports unsolicited status pushes while connected", async () => {
    const { bus, lock, updates } = createLock();
    await lock.refresh();
    updates.length = 0;

    bus.pushStatus("unlocked");
    await settle();
    assert.deepEqual(updates, [{ kind: "lock", status: "unlocked" }]);
    assert.equal((await lock.refresh()).lock, "unlocked");
    await lock.stop();
  });

  it("reconnects after the lock drops an idle connection", async () => {
    const { bus, lock } = createLock();
    await lock.refresh();
    bus.dropConnection();
    await settle();

    assert.equal((await lock.refresh()).lock, "locked");
    assert.equal(bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length, 2);
    await lock.stop();
  });

  it("disconnects after the idle delay", async () => {
    const { bus, lock } = createLock({ timing: { idleDisconnectMs: 0 } });
    const dropped = once(bus, "dropped");
    await lock.refresh();
    await dropped;

    assert.equal(bus.connected, false);
    await lock.stop();
  });

  it("drops a request that is no longer wanted without connecting", async () => {
    const { bus, fakeLock, lock } = createLock();

    await assert.rejects(lock.setLocked(false, () => false), RequestCancelled);
    assert.equal(bus.calls.includes("org.bluez.Device1.Connect"), false);
    assert.equal(fakeLock.status, "locked");
    await lock.stop();
  });

  it("stops connecting once a request is no longer wanted", async () => {
    const { bus, lock } = createLock({ bus: { connectFailures: ["one", "two", "three"] } });
    const connects = () => bus.calls.filter((call) => call === "org.bluez.Device1.Connect").length;

    await assert.rejects(lock.setLocked(false, () => connects() < 1), RequestCancelled);
    assert.equal(connects(), 1);
    await lock.stop();
  });

  it("refuses work after stopping", async () => {
    const { lock } = createLock();
    await lock.stop();

    await assert.rejects(lock.refresh(), /Lock is stopped/u);
  });
});
