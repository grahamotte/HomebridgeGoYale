import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ackMatcher,
  batteryPercentage,
  buildCommand,
  buildSecureCommand,
  parseDoorStatus,
  parseKey,
  parseLockStatus,
  parseStatusFrame,
  resultMatcher,
  SecureCipher,
  securityChecksum,
  SessionCipher,
  sessionKey,
  simpleChecksum,
  statusMatcher,
  validFrame,
  validSecureFrame,
  writeSecurityChecksum,
  writeSimpleChecksum
} from "../dist/protocol.js";

const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const SEQUENCE = Buffer.from(Array.from({ length: 18 }, (_, index) => index + 1));

describe("checksums", () => {
  it("matches the yalexs-ble reference values", () => {
    assert.equal(securityChecksum(SEQUENCE), 3890933233);
    assert.equal(securityChecksum(Buffer.alloc(18, 0xff)), 3);
    assert.equal(simpleChecksum(SEQUENCE), 85);
    assert.equal(simpleChecksum(buildCommand(0x0b)), 5);
  });

  it("writes checksums that validate", () => {
    const secure = buildSecureCommand(0x01, 7);
    writeSecurityChecksum(secure);
    assert.equal(validSecureFrame(secure), true);
    secure[0x05] ^= 0xff;
    assert.equal(validSecureFrame(secure), false);

    const frame = buildCommand(0x02, 0x02);
    frame[0x00] = 0xbb;
    writeSimpleChecksum(frame);
    assert.equal(simpleChecksum(frame), 0);
    assert.equal(validFrame(frame), true);
    frame[0x00] = 0xee;
    writeSimpleChecksum(frame);
    assert.equal(validFrame(frame), false);
  });

  it("rejects frames of the wrong length", () => {
    assert.throws(() => simpleChecksum(Buffer.alloc(17)), /18-byte frame/u);
    assert.equal(validFrame(Buffer.alloc(19)), false);
    assert.equal(validSecureFrame(Buffer.alloc(16)), false);
  });
});

describe("frames", () => {
  it("builds secure and session commands", () => {
    assert.equal(buildSecureCommand(0x03, 9).toString("hex"), "030000000000000000000000000000000f09");
    assert.equal(buildCommand(0x02, 0x0f).toString("hex"), "ee0200000f00000000000000000000000200");
  });

  it("derives the session key from both handshake halves", () => {
    const handshake = Buffer.from("0102030405060708a1a2a3a4a5a6a7a8", "hex");
    const reply = Buffer.alloc(18);
    reply[0] = 0x02;
    Buffer.from("1112131415161718", "hex").copy(reply, 4);
    assert.equal(sessionKey(handshake, reply).toString("hex"), "01020304050607081112131415161718");
  });

  it("parses keys", () => {
    assert.deepEqual(parseKey("00112233445566778899AABBCCDDEEFF"), KEY);
    assert.throws(() => parseKey("0011"), /32 hexadecimal/u);
  });
});

describe("ciphers", () => {
  it("encrypts the first block with ECB and leaves the trailer", () => {
    const encrypted = new SecureCipher(KEY).encrypt(SEQUENCE);
    assert.equal(encrypted.subarray(0, 16).toString("hex"), "bf6529be6d7553abe7b4e048c65b3135");
    assert.deepEqual(encrypted.subarray(16), SEQUENCE.subarray(16));
    assert.deepEqual(new SecureCipher(KEY).decrypt(encrypted), SEQUENCE);
  });

  it("switches secure keys", () => {
    const cipher = new SecureCipher(Buffer.alloc(16));
    cipher.setKey(KEY);
    assert.equal(cipher.encrypt(SEQUENCE).subarray(0, 16).toString("hex"), "bf6529be6d7553abe7b4e048c65b3135");
  });

  it("chains CBC across frames like the lock", () => {
    const cipher = new SessionCipher(KEY);
    const first = cipher.encrypt(buildCommand(0x0b));
    const second = cipher.encrypt(SEQUENCE);
    assert.equal(first.subarray(0, 16).toString("hex"), "9d09f915b7203c82bae543343d5af4c0");
    assert.equal(second.subarray(0, 16).toString("hex"), "6cd2e8d8c948bdc14c34d9788e0be4e5");

    const decipher = new SessionCipher(KEY);
    assert.deepEqual(decipher.decrypt(first), buildCommand(0x0b));
    assert.deepEqual(decipher.decrypt(second), SEQUENCE);
  });
});

describe("status parsing", () => {
  it("maps lock and door codes", () => {
    assert.equal(parseLockStatus(0x05), "locked");
    assert.equal(parseLockStatus(0x03), "unlocked");
    assert.equal(parseLockStatus(0x07), "jammed");
    assert.equal(parseLockStatus(0x44), "unknown");
    assert.equal(parseDoorStatus(0x01), "closed");
    assert.equal(parseDoorStatus(0x09), "unknown");
  });

  it("converts cell voltage to battery percentage", () => {
    assert.equal(batteryPercentage(1.6), 100);
    assert.equal(batteryPercentage(1.5), 93);
    assert.equal(batteryPercentage(1.36), 45);
    assert.equal(batteryPercentage(1.1), 0);
  });

  it("parses status, battery, and operation frames", () => {
    assert.deepEqual(parseStatusFrame(statusFrame(0x02, 0x05)), { kind: "lock", status: "locked" });
    assert.deepEqual(parseStatusFrame(statusFrame(0x2f, 0x03)), { kind: "lock", status: "unlocked" });
    assert.deepEqual(parseStatusFrame(statusFrame(0x2e, 0x02)), { kind: "door", status: "ajar" });
    const battery = statusFrame(0x0f, 0);
    battery.writeUInt16LE(6000, 8);
    assert.deepEqual(parseStatusFrame(battery), { kind: "battery", voltage: 6, percentage: 93 });

    const failure = Buffer.alloc(18);
    failure[0] = 0xbb;
    failure[1] = 0x0b;
    failure[0x0f] = 0x1e;
    assert.deepEqual(parseStatusFrame(failure), { kind: "lock", status: "jammed" });
    failure[0x0f] = 0;
    assert.equal(parseStatusFrame(failure), undefined);
    assert.equal(parseStatusFrame(statusFrame(0x44, 0)), undefined);
  });

  it("matches replies to the command that asked for them", () => {
    assert.equal(statusMatcher(0x02)(statusFrame(0x02, 5)), true);
    assert.equal(statusMatcher(0x0f)(statusFrame(0x02, 5)), false);
    const ack = Buffer.alloc(18);
    ack[0] = 0xaa;
    ack[1] = 0x0a;
    assert.equal(ackMatcher(0x0a)(ack), true);
    assert.equal(ackMatcher(0x0b)(ack), false);
    assert.equal(resultMatcher(0x0a)(ack), false);
    ack[0] = 0xbb;
    assert.equal(resultMatcher(0x0a)(ack), true);
  });
});

function statusFrame(type, value) {
  const frame = Buffer.alloc(18);
  frame[0] = 0xbb;
  frame[1] = 0x02;
  frame[4] = type;
  frame[8] = value;
  return frame;
}
