import { createCipheriv, createDecipheriv, type Cipheriv, type Decipheriv } from "node:crypto";

export const WRITE_CHARACTERISTIC = "bd4ac611-0b45-11e3-8ffd-0800200c9a66";
export const READ_CHARACTERISTIC = "bd4ac612-0b45-11e3-8ffd-0800200c9a66";
export const SECURE_WRITE_CHARACTERISTIC = "bd4ac613-0b45-11e3-8ffd-0800200c9a66";
export const SECURE_READ_CHARACTERISTIC = "bd4ac614-0b45-11e3-8ffd-0800200c9a66";

export const FRAME_LENGTH = 0x12;
export const RESULT_BYTE = 0x0f;

export const Command = {
  GetStatus: 0x02,
  Unlock: 0x0a,
  Lock: 0x0b
} as const;

export const StatusType = {
  LockOnly: 0x02,
  DoorOnly: 0x2e,
  Battery: 0x0f
} as const;

export const SecureCommand = {
  KeyExchange: 0x01,
  KeyExchangeReply: 0x02,
  Initialize: 0x03,
  InitializeReply: 0x04,
  Shutdown: 0x05,
  ShutdownReply: 0x8b
} as const;

export type LockStatus =
  | "unknown"
  | "calibrating"
  | "unlocking"
  | "unlocked"
  | "locking"
  | "locked"
  | "discovering"
  | "jammed"
  | "unlatching"
  | "unlatched"
  | "securemode";

export type DoorStatus = "unknown" | "closed" | "ajar" | "opened";

const LOCK_STATUSES: Readonly<Record<number, LockStatus>> = {
  0x01: "calibrating",
  0x02: "unlocking",
  0x03: "unlocked",
  0x04: "locking",
  0x05: "locked",
  0x06: "discovering",
  0x07: "jammed",
  0x09: "unlatching",
  0x0a: "unlatched",
  0x0c: "securemode"
};

const DOOR_STATUSES: Readonly<Record<number, DoorStatus>> = {
  0x01: "closed",
  0x02: "ajar",
  0x03: "opened"
};

const AA_BATTERY_VOLTAGES: readonly (readonly [number, number])[] = [
  [1.24, 0],
  [1.25, 5],
  [1.26, 10],
  [1.27, 15],
  [1.28, 20],
  [1.29, 25],
  [1.3, 27],
  [1.31, 28],
  [1.32, 30],
  [1.33, 35],
  [1.34, 40],
  [1.35, 45],
  [1.36, 50],
  [1.37, 55],
  [1.38, 60],
  [1.39, 65],
  [1.4, 70],
  [1.45, 75],
  [1.46, 80],
  [1.471, 85],
  [1.49, 90],
  [1.49075, 93],
  [1.547, 94],
  [1.548, 95],
  [1.549, 97],
  [1.55, 100]
];

export type StatusUpdate =
  | { readonly kind: "lock"; readonly status: LockStatus }
  | { readonly kind: "door"; readonly status: DoorStatus }
  | { readonly kind: "battery"; readonly voltage: number; readonly percentage: number };

export type FrameMatcher = (frame: Buffer) => boolean;

export class ProtocolError extends Error {}

export function parseKey(key: string): Buffer {
  if (!/^[0-9a-f]{32}$/iu.test(key)) {
    throw new ProtocolError("Lock key must be 32 hexadecimal characters");
  }

  return Buffer.from(key, "hex");
}

export function buildSecureCommand(opcode: number, slot: number): Buffer {
  const frame = Buffer.alloc(FRAME_LENGTH);
  frame[0x00] = opcode;
  frame[0x10] = 0x0f;
  frame[0x11] = slot;
  return frame;
}

export function buildCommand(opcode: number, commandByte = 0): Buffer {
  const frame = Buffer.alloc(FRAME_LENGTH);
  frame[0x00] = 0xee;
  frame[0x01] = opcode;
  frame[0x04] = commandByte;
  frame[0x10] = 0x02;
  return frame;
}

export function securityChecksum(frame: Buffer): number {
  requireFrame(frame);
  return (0x100000000 - ((frame.readUInt32LE(0x00) + frame.readUInt32LE(0x04) + frame.readUInt32LE(0x08)) % 0x100000000)) % 0x100000000;
}

export function simpleChecksum(frame: Buffer): number {
  requireFrame(frame);
  let sum = 0;
  for (let index = 0; index < FRAME_LENGTH; index++) {
    sum += frame[index] ?? 0;
  }

  return (0x100 - (sum % 0x100)) % 0x100;
}

export function writeSecurityChecksum(frame: Buffer): void {
  frame.writeUInt32LE(securityChecksum(frame), 0x0c);
}

export function writeSimpleChecksum(frame: Buffer): void {
  frame[0x03] = 0;
  frame[0x03] = simpleChecksum(frame);
}

export function validSecureFrame(frame: Buffer): boolean {
  return frame.length === FRAME_LENGTH && frame.readUInt32LE(0x0c) === securityChecksum(frame);
}

export function validFrame(frame: Buffer): boolean {
  return frame.length === FRAME_LENGTH &&
    simpleChecksum(frame) === 0 &&
    (frame[0x00] === 0xbb || frame[0x00] === 0xaa);
}

export class SecureCipher {
  private key: Buffer;

  constructor(key: Buffer) {
    this.key = key;
  }

  setKey(key: Buffer): void {
    this.key = key;
  }

  encrypt(frame: Buffer): Buffer {
    return transform(createCipheriv("aes-128-ecb", this.key, null).setAutoPadding(false), frame);
  }

  decrypt(frame: Buffer): Buffer {
    return transform(createDecipheriv("aes-128-ecb", this.key, null).setAutoPadding(false), frame);
  }
}

export class SessionCipher {
  private readonly encryptor: Cipheriv;
  private readonly decryptor: Decipheriv;

  constructor(key: Buffer) {
    this.encryptor = createCipheriv("aes-128-cbc", key, Buffer.alloc(16)).setAutoPadding(false);
    this.decryptor = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16)).setAutoPadding(false);
  }

  encrypt(frame: Buffer): Buffer {
    return transform(this.encryptor, frame);
  }

  decrypt(frame: Buffer): Buffer {
    return transform(this.decryptor, frame);
  }
}

export function sessionKey(handshake: Buffer, reply: Buffer): Buffer {
  return Buffer.concat([handshake.subarray(0x00, 0x08), reply.subarray(0x04, 0x0c)]);
}

export function statusMatcher(type: number): FrameMatcher {
  return (frame) => frame[0x00] === 0xbb && frame[0x01] === Command.GetStatus && frame[0x04] === type;
}

export function ackMatcher(opcode: number): FrameMatcher {
  return (frame) => frame[0x00] === 0xaa && frame[0x01] === opcode && frame[0x04] === 0x00;
}

export function resultMatcher(opcode: number): FrameMatcher {
  return (frame) => frame[0x00] === 0xbb && frame[0x01] === opcode;
}

export function parseLockStatus(value: number): LockStatus {
  return LOCK_STATUSES[value] ?? "unknown";
}

export function parseDoorStatus(value: number): DoorStatus {
  return DOOR_STATUSES[value] ?? "unknown";
}

export function batteryPercentage(cellVoltage: number): number {
  let percentage = AA_BATTERY_VOLTAGES[0]?.[1] ?? 0;
  for (const [voltage, value] of AA_BATTERY_VOLTAGES) {
    if (voltage >= cellVoltage) {
      break;
    }

    percentage = value;
  }

  return percentage;
}

export function parseStatusFrame(frame: Buffer): StatusUpdate | undefined {
  if (frame[0x00] === 0xbb && (frame[0x01] === Command.Lock || frame[0x01] === Command.Unlock)) {
    return frame[RESULT_BYTE] === 0 ? undefined : { kind: "lock", status: "jammed" };
  }

  if (frame[0x00] !== 0xbb || frame[0x01] !== Command.GetStatus) {
    return undefined;
  }

  switch (frame[0x04]) {
    case StatusType.LockOnly:
      return { kind: "lock", status: parseLockStatus(frame[0x08] ?? 0) };
    case StatusType.DoorOnly:
      return { kind: "door", status: parseDoorStatus(frame[0x08] ?? 0) };
    case 0x2f:
      return { kind: "lock", status: parseLockStatus(frame[0x08] ?? 0) };
    case StatusType.Battery: {
      const voltage = frame.readUInt16LE(0x08) / 1000;
      return { kind: "battery", voltage, percentage: batteryPercentage(voltage / 4) };
    }
    default:
      return undefined;
  }
}

function transform(cipher: Cipheriv | Decipheriv, frame: Buffer): Buffer {
  requireFrame(frame);
  const output = Buffer.from(frame);
  cipher.update(frame.subarray(0x00, 0x10)).copy(output, 0x00);
  return output;
}

function requireFrame(frame: Buffer): void {
  if (frame.length !== FRAME_LENGTH) {
    throw new ProtocolError(`Expected an ${FRAME_LENGTH}-byte frame, got ${frame.length} bytes`);
  }
}
