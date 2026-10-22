import type { PlatformConfig } from "homebridge";
import type { LockSettings } from "./lock.js";

export interface GoYaleConfig {
  readonly locks: readonly LockSettings[];
  readonly adapter?: string;
  readonly pollIntervalMs: number;
  readonly idleDisconnectMs: number;
  readonly commandTimeoutMs: number;
}

export interface ConfigProblem {
  readonly index: number;
  readonly message: string;
}

export function parseConfig(config: PlatformConfig): { settings: GoYaleConfig; problems: readonly ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const locks: LockSettings[] = [];
  const entries: unknown[] = Array.isArray(config.locks) ? config.locks : [];
  entries.forEach((entry, index) => {
    const lock = readLock(entry);
    if (typeof lock === "string") {
      problems.push({ index, message: lock });
    } else if (locks.some((existing) => existing.address === lock.address)) {
      problems.push({ index, message: `duplicate address ${lock.address}` });
    } else {
      locks.push(lock);
    }
  });

  return {
    settings: {
      locks,
      adapter: typeof config.adapter === "string" && /^hci\d+$/u.test(config.adapter.trim()) ? config.adapter.trim() : undefined,
      pollIntervalMs: readNumber(config.pollIntervalSeconds, 900, 0, 86400) * 1000,
      idleDisconnectMs: config.keepConnected === true ? -1 : readNumber(config.idleDisconnectSeconds, 30, 0, 3600) * 1000,
      commandTimeoutMs: readNumber(config.commandTimeoutSeconds, 180, 30, 3600) * 1000
    },
    problems
  };
}

export function normalizeAddress(value: string): string | undefined {
  const compact = value.trim().replace(/[:-]/gu, "").toUpperCase();
  return /^[0-9A-F]{12}$/u.test(compact) ? compact.match(/../gu)?.join(":") : undefined;
}

function readLock(entry: unknown): LockSettings | string {
  if (!entry || typeof entry !== "object") {
    return "lock entry must be an object";
  }

  const record = entry as Record<string, unknown>;
  const address = typeof record.address === "string" ? normalizeAddress(record.address) : undefined;
  if (!address) {
    return "address must be a Bluetooth address like A4:C1:38:5E:2D:73";
  }

  const key = typeof record.key === "string" ? record.key.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{32}$/u.test(key)) {
    return "key must be 32 hexadecimal characters";
  }

  const slot = record.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 255) {
    return "slot must be an integer from 0 to 255";
  }

  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Lock";
  return { name, address, key, slot };
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), min), max)
    : fallback;
}
