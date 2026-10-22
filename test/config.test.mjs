import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAddress, parseConfig } from "../dist/config.js";

const KEY = "00112233445566778899AABBCCDDEEFF";

describe("parseConfig", () => {
  it("reads locks and applies defaults", () => {
    const { settings, problems } = parseConfig({
      platform: "GoYale",
      locks: [{ name: " Front Door ", address: "a4-c1-38-5e-2d-73", key: KEY, slot: 1 }]
    });

    assert.deepEqual(problems, []);
    assert.deepEqual(settings, {
      locks: [{ name: "Front Door", address: "A4:C1:38:5E:2D:73", key: KEY.toLowerCase(), slot: 1 }],
      adapter: undefined,
      pollIntervalMs: 900000,
      idleDisconnectMs: 30000,
      commandTimeoutMs: 180000
    });
  });

  it("reports invalid and duplicate locks without dropping valid ones", () => {
    const { settings, problems } = parseConfig({
      platform: "GoYale",
      locks: [
        { address: "A4C1385E2D73", key: KEY, slot: 2 },
        "nope",
        { address: "A4:C1", key: KEY, slot: 1 },
        { address: "A4:C1:38:5E:2D:74", key: "abc", slot: 1 },
        { address: "A4:C1:38:5E:2D:74", key: KEY, slot: 1.5 },
        { address: "a4:c1:38:5e:2d:73", key: KEY, slot: 3 }
      ]
    });

    assert.deepEqual(settings.locks.map((lock) => [lock.name, lock.address, lock.slot]), [["Lock", "A4:C1:38:5E:2D:73", 2]]);
    assert.deepEqual(problems, [
      { index: 1, message: "lock entry must be an object" },
      { index: 2, message: "address must be a Bluetooth address like A4:C1:38:5E:2D:73" },
      { index: 3, message: "key must be 32 hexadecimal characters" },
      { index: 4, message: "slot must be an integer from 0 to 255" },
      { index: 5, message: "duplicate address A4:C1:38:5E:2D:73" }
    ]);
  });

  it("clamps timing, keeps the connection when asked, and validates the adapter", () => {
    const clamped = parseConfig({ platform: "GoYale", pollIntervalSeconds: 999999, idleDisconnectSeconds: -4, commandTimeoutSeconds: 5, adapter: " hci1 " }).settings;
    assert.equal(clamped.pollIntervalMs, 86400000);
    assert.equal(clamped.commandTimeoutMs, 30000);
    assert.equal(clamped.idleDisconnectMs, 0);
    assert.equal(clamped.adapter, "hci1");

    const kept = parseConfig({ platform: "GoYale", keepConnected: true, pollIntervalSeconds: 0, adapter: "../hci0" }).settings;
    assert.equal(kept.idleDisconnectMs, -1);
    assert.equal(kept.pollIntervalMs, 0);
    assert.equal(kept.adapter, undefined);
    assert.deepEqual(kept.locks, []);
  });
});

describe("normalizeAddress", () => {
  it("normalizes separators and case", () => {
    assert.equal(normalizeAddress("a4c1385e2d73"), "A4:C1:38:5E:2D:73");
    assert.equal(normalizeAddress(" a4:c1:38:5e:2d:73 "), "A4:C1:38:5E:2D:73");
    assert.equal(normalizeAddress("A4:C1:38:5E:2D"), undefined);
    assert.equal(normalizeAddress("ZZ:C1:38:5E:2D:73"), undefined);
  });
});
