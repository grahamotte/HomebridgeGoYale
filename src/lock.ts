import { randomBytes } from "node:crypto";
import type { Bluez, BluezDevice } from "./bluez.js";
import {
  ackMatcher,
  buildCommand,
  buildSecureCommand,
  Command,
  parseKey,
  parseStatusFrame,
  READ_CHARACTERISTIC,
  RESULT_BYTE,
  resultMatcher,
  SECURE_READ_CHARACTERISTIC,
  SECURE_WRITE_CHARACTERISTIC,
  SecureCipher,
  SecureCommand,
  SessionCipher,
  sessionKey,
  statusMatcher,
  StatusType,
  validFrame,
  validSecureFrame,
  WRITE_CHARACTERISTIC,
  writeSecurityChecksum,
  writeSimpleChecksum,
  type FrameMatcher,
  type LockStatus,
  type StatusUpdate
} from "./protocol.js";

export interface LockSettings {
  readonly name: string;
  readonly address: string;
  readonly key: string;
  readonly slot: number;
}

export interface LockTiming {
  readonly discoveryTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly connectAttempts: number;
  readonly responseTimeoutMs: number;
  readonly ackTimeoutMs: number;
  readonly operationTimeoutMs: number;
  readonly cooldownMs: number;
  readonly idleDisconnectMs: number;
}

export interface LockLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface LockSnapshot {
  readonly lock: LockStatus;
  readonly battery?: number;
}

export const DEFAULT_TIMING: LockTiming = {
  discoveryTimeoutMs: 30000,
  connectTimeoutMs: 30000,
  connectAttempts: 4,
  responseTimeoutMs: 10000,
  ackTimeoutMs: 8000,
  operationTimeoutMs: 12000,
  cooldownMs: 250,
  idleDisconnectMs: 30000
};

const OPERATION_ATTEMPTS = 3;
const READ_ATTEMPTS = 2;

export class LockError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

interface Waiter {
  readonly matcher: FrameMatcher;
  readonly resolve: (frame: Buffer) => void;
  readonly reject: (error: Error) => void;
}

class LockConnection {
  private readonly secureCipher: SecureCipher;
  private sessionCipher?: SessionCipher;
  private secureWaiters: Waiter[] = [];
  private waiters: Waiter[] = [];
  private lastFrameAt = 0;
  private open = true;

  private constructor(
    private readonly device: BluezDevice,
    private readonly characteristics: Record<string, string>,
    private readonly settings: LockSettings,
    private readonly timing: LockTiming,
    private readonly log: LockLogger,
    private readonly onState: (update: StatusUpdate) => void,
    private readonly onClose: () => void,
  ) {
    this.secureCipher = new SecureCipher(parseKey(settings.key));
  }

  static async open(
    device: BluezDevice,
    settings: LockSettings,
    timing: LockTiming,
    log: LockLogger,
    onState: (update: StatusUpdate) => void,
    onClose: () => void,
  ): Promise<LockConnection> {
    const characteristics = await device.characteristics([
      WRITE_CHARACTERISTIC,
      READ_CHARACTERISTIC,
      SECURE_WRITE_CHARACTERISTIC,
      SECURE_READ_CHARACTERISTIC
    ]);
    const connection = new LockConnection(device, characteristics, settings, timing, log, onState, onClose);
    device.onDisconnect(() => connection.closed());
    try {
      await connection.handshake();
    } catch (error) {
      await connection.close();
      throw error;
    }

    return connection;
  }

  get isOpen(): boolean {
    return this.open;
  }

  async status(): Promise<LockStatus> {
    const frame = await this.execute(buildCommand(Command.GetStatus, StatusType.LockOnly), statusMatcher(StatusType.LockOnly));
    const update = parseStatusFrame(frame);
    return update?.kind === "lock" ? update.status : "unknown";
  }

  async battery(): Promise<number | undefined> {
    const frame = await this.execute(buildCommand(Command.GetStatus, StatusType.Battery), statusMatcher(StatusType.Battery));
    const update = parseStatusFrame(frame);
    return update?.kind === "battery" ? update.percentage : undefined;
  }

  async operate(opcode: number, progress: { acknowledged: boolean }): Promise<void> {
    await this.cooldown();
    const command = buildCommand(opcode);
    writeSimpleChecksum(command);
    const encrypted = this.cipher().encrypt(command);
    const ack = this.wait(this.waiters, ackMatcher(opcode), this.timing.ackTimeoutMs, "acknowledgment");
    const result = this.wait(this.waiters, resultMatcher(opcode), this.timing.operationTimeoutMs, "operation result");
    void ack.promise.then(() => {
      progress.acknowledged = true;
    }, () => undefined);
    try {
      await this.device.write(this.characteristics[WRITE_CHARACTERISTIC] ?? "", encrypted);
      await Promise.race([ack.promise, result.promise]);
      const frame = await result.promise;
      const code = frame[RESULT_BYTE] ?? 0;
      if (code !== 0) {
        throw new LockError(`Lock reported operation failure 0x${code.toString(16).padStart(2, "0")}`, false);
      }
    } finally {
      ack.cancel();
      result.cancel();
    }
  }

  async close(): Promise<void> {
    if (this.open && this.sessionCipher) {
      const command = buildSecureCommand(SecureCommand.Shutdown, 0);
      await this.secureExecute(command, Math.min(this.timing.responseTimeoutMs, 2000)).catch(() => undefined);
    }

    this.closed();
    await this.device.disconnect();
  }

  private async handshake(): Promise<void> {
    await this.device.startNotify(this.characteristics[SECURE_READ_CHARACTERISTIC] ?? "", (value) => this.onSecureFrame(value));
    const handshake = randomBytes(16);
    const exchange = buildSecureCommand(SecureCommand.KeyExchange, this.settings.slot);
    handshake.copy(exchange, 0x04, 0x00, 0x08);
    const reply = await this.secureExecute(exchange, this.timing.responseTimeoutMs);
    if (reply[0x00] !== SecureCommand.KeyExchangeReply) {
      throw new LockError("Lock rejected the key; check the key and slot", false);
    }

    const key = sessionKey(handshake, reply);
    this.secureCipher.setKey(key);
    const initialize = buildSecureCommand(SecureCommand.Initialize, this.settings.slot);
    handshake.copy(initialize, 0x04, 0x08, 0x10);
    const initialized = await this.secureExecute(initialize, this.timing.responseTimeoutMs);
    if (initialized[0x00] !== SecureCommand.InitializeReply) {
      throw new LockError("Lock rejected the session; check the key and slot", false);
    }

    this.sessionCipher = new SessionCipher(key);
    await this.device.startNotify(this.characteristics[READ_CHARACTERISTIC] ?? "", (value) => this.onFrame(value));
  }

  private async secureExecute(command: Buffer, timeoutMs: number): Promise<Buffer> {
    writeSecurityChecksum(command);
    const encrypted = this.secureCipher.encrypt(command);
    const reply = this.wait(this.secureWaiters, () => true, timeoutMs, "secure reply");
    try {
      await this.device.write(this.characteristics[SECURE_WRITE_CHARACTERISTIC] ?? "", encrypted);
      return await reply.promise;
    } finally {
      reply.cancel();
    }
  }

  private async execute(command: Buffer, matcher: FrameMatcher): Promise<Buffer> {
    await this.cooldown();
    writeSimpleChecksum(command);
    const encrypted = this.cipher().encrypt(command);
    const reply = this.wait(this.waiters, matcher, this.timing.responseTimeoutMs, "status reply");
    try {
      await this.device.write(this.characteristics[WRITE_CHARACTERISTIC] ?? "", encrypted);
      return await reply.promise;
    } finally {
      reply.cancel();
    }
  }

  private wait(
    waiters: Waiter[],
    matcher: FrameMatcher,
    timeoutMs: number,
    label: string,
  ): { promise: Promise<Buffer>; cancel: () => void } {
    if (!this.open) {
      const promise = Promise.reject(new LockError("Lock disconnected", true));
      promise.catch(() => undefined);
      return { promise, cancel: () => undefined };
    }

    let waiter!: Waiter;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = () => {
      clearTimeout(timer);
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
      }
    };
    const promise = new Promise<Buffer>((resolve, reject) => {
      waiter = {
        matcher,
        resolve: (frame) => {
          remove();
          resolve(frame);
        },
        reject: (error) => {
          remove();
          reject(error);
        }
      };
      timer = setTimeout(() => waiter.reject(new LockError(`Timed out waiting for the lock's ${label}`, true)), timeoutMs);
      waiters.push(waiter);
    });
    promise.catch(() => undefined);
    return { promise, cancel: remove };
  }

  private onSecureFrame(value: Buffer): void {
    if (value.length !== 0x12) {
      return;
    }

    const frame = this.secureCipher.decrypt(value);
    if (!validSecureFrame(frame)) {
      this.log.debug(`${this.settings.name}: dropping invalid secure frame`);
      return;
    }

    this.secureWaiters[0]?.resolve(frame);
  }

  private onFrame(value: Buffer): void {
    if (!this.sessionCipher || value.length !== 0x12) {
      return;
    }

    const frame = this.sessionCipher.decrypt(value);
    this.lastFrameAt = Date.now();
    if (!validFrame(frame)) {
      this.log.debug(`${this.settings.name}: dropping invalid frame`);
      return;
    }

    const update = parseStatusFrame(frame);
    if (update) {
      this.onState(update);
    }

    this.waiters.find((waiter) => waiter.matcher(frame))?.resolve(frame);
  }

  private cipher(): SessionCipher {
    if (!this.sessionCipher || !this.open) {
      throw new LockError("Lock disconnected", true);
    }

    return this.sessionCipher;
  }

  private async cooldown(): Promise<void> {
    const remaining = this.timing.cooldownMs - (Date.now() - this.lastFrameAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private closed(): void {
    if (!this.open) {
      return;
    }

    this.open = false;
    for (const waiter of [...this.secureWaiters, ...this.waiters]) {
      waiter.reject(new LockError("Lock disconnected", true));
    }

    this.device.close();
    this.onClose();
  }
}

export class YaleLock {
  private connection?: LockConnection;
  private connecting?: Promise<LockConnection>;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly bluez: Bluez,
    readonly settings: LockSettings,
    private readonly log: LockLogger,
    private readonly onState: (update: StatusUpdate) => void,
    private readonly timing: LockTiming = DEFAULT_TIMING,
  ) {}

  refresh(): Promise<LockSnapshot> {
    return this.run(READ_ATTEMPTS, async (connection) => ({
      lock: await connection.status(),
      battery: await connection.battery().catch((error: unknown) => {
        this.log.debug(`${this.settings.name}: battery read failed: ${describe(error)}`);
        return undefined;
      })
    }));
  }

  setLocked(locked: boolean): Promise<void> {
    const opcode = locked ? Command.Lock : Command.Unlock;
    return this.run(OPERATION_ATTEMPTS, async (connection) => {
      const progress = { acknowledged: false };
      try {
        await connection.operate(opcode, progress);
      } catch (error) {
        if (progress.acknowledged && error instanceof LockError && error.retryable) {
          throw new LockError(`${error.message} after the lock acknowledged the command`, false);
        }

        throw error;
      }

      this.onState({ kind: "lock", status: locked ? "locked" : "unlocked" });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    await this.queue.catch(() => undefined);
    await this.disconnect();
  }

  private run<T>(attempts: number, task: (connection: LockConnection) => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(() => this.attempt(attempts, task));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async attempt<T>(attempts: number, task: (connection: LockConnection) => Promise<T>): Promise<T> {
    if (this.stopped) {
      throw new LockError("Lock is stopped", false);
    }

    clearTimeout(this.idleTimer);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await task(await this.connect());
        } catch (error) {
          const retryable = !(error instanceof LockError) || error.retryable;
          if (!retryable || attempt >= attempts) {
            throw error;
          }

          this.log.debug(`${this.settings.name}: retrying after ${describe(error)}`);
          await this.disconnect();
        }
      }
    } finally {
      this.scheduleIdleDisconnect();
    }
  }

  private async connect(): Promise<LockConnection> {
    if (this.connection?.isOpen) {
      return this.connection;
    }

    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<LockConnection> {
    const started = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.timing.connectAttempts; attempt++) {
      try {
        const device = await this.bluez.device(this.settings.address, this.timing.discoveryTimeoutMs);
        await device.connect(this.timing.connectTimeoutMs).catch(async (error: unknown) => {
          device.close();
          throw error;
        });
        const connection = await LockConnection.open(device, this.settings, this.timing, this.log, this.onState, () => {
          if (this.connection && !this.connection.isOpen) {
            this.connection = undefined;
          }
        });
        this.connection = connection;
        this.log.debug(`${this.settings.name}: connected in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return connection;
      } catch (error) {
        if (error instanceof LockError && !error.retryable) {
          throw error;
        }

        lastError = error;
        this.log.debug(`${this.settings.name}: connect attempt ${attempt} failed: ${describe(error)}`);
      }
    }

    throw new LockError(`Could not connect to the lock: ${describe(lastError)}`, true);
  }

  private scheduleIdleDisconnect(): void {
    clearTimeout(this.idleTimer);
    if (this.stopped || this.timing.idleDisconnectMs < 0) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.queue = this.queue.catch(() => undefined).then(() => this.disconnect());
    }, this.timing.idleDisconnectMs);
    this.idleTimer.unref?.();
  }

  private async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close().catch(() => undefined);
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
