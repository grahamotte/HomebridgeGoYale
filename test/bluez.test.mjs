import assert from "node:assert/strict";
import { describe, it } from "node:test";
import dbus from "dbus-next";
import { BluetoothError, Bluez } from "../dist/bluez.js";
import { ADDRESS, DEVICE, FakeBus, settle } from "./fakes.mjs";

const WRITE = "bd4ac611-0b45-11e3-8ffd-0800200c9a66";
const READ = "bd4ac612-0b45-11e3-8ffd-0800200c9a66";

describe("Bluez", () => {
  it("finds a known device without scanning", async () => {
    const bus = new FakeBus();
    const bluez = new Bluez(() => bus);
    const device = await bluez.device(ADDRESS.toLowerCase(), 1000);

    assert.equal(device.path, DEVICE);
    assert.equal(bus.calls.includes("org.bluez.Adapter1.StartDiscovery"), false);
    assert.equal(bus.calls.filter((call) => call === "org.freedesktop.DBus.AddMatch").length, 2);
    await bluez.device(ADDRESS, 1000);
    assert.equal(bus.calls.filter((call) => call === "org.freedesktop.DBus.AddMatch").length, 2);
  });

  it("scans for an unknown device and stops scanning", async () => {
    const bus = new FakeBus(undefined, { known: false });
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);

    assert.equal(device.path, DEVICE);
    assert.deepEqual(bus.calls.filter((call) => call.startsWith("org.bluez.Adapter1")), [
      "org.bluez.Adapter1.SetDiscoveryFilter",
      "org.bluez.Adapter1.StartDiscovery",
      "org.bluez.Adapter1.StopDiscovery"
    ]);
  });

  it("selects the configured adapter and reports a missing one", async () => {
    const named = await new Bluez(() => new FakeBus(undefined, { adapters: ["/org/bluez/hci1", "/org/bluez/hci0"] }), "hci0").device(ADDRESS, 1000);
    assert.equal(named.path, DEVICE);

    const first = await new Bluez(() => new FakeBus(undefined, { adapters: ["/org/bluez/hci0", "/org/bluez/hci1"] })).device(ADDRESS, 1000);
    assert.equal(first.path, DEVICE);

    await assert.rejects(new Bluez(() => new FakeBus(), "hci3").device(ADDRESS, 1000), /Bluetooth adapter hci3 not found/u);
    await assert.rejects(new Bluez(() => new FakeBus(undefined, { adapters: [] })).device(ADDRESS, 1000), /No Bluetooth adapter found/u);
  });

  it("connects, waits for services, and finds characteristics", async () => {
    const bus = new FakeBus(undefined, { resolveLater: true });
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    await device.connect(1000);

    const characteristics = await device.characteristics([WRITE, READ]);
    assert.equal(characteristics[WRITE], `${DEVICE}/service0010/char0011`);
    assert.equal(characteristics[READ], `${DEVICE}/service0010/char0013`);
    await assert.rejects(device.characteristics(["0000ffff-0000-1000-8000-00805f9b34fb"]), /characteristics missing/u);
  });

  it("trusts the lock so BlueZ keeps its service cache", async () => {
    const bus = new FakeBus();
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    await device.connect(1000);

    assert.equal(bus.trusted, true);
  });

  it("reuses an existing connection with resolved services", async () => {
    const bus = new FakeBus();
    bus.connected = true;
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    await device.connect(1000);

    assert.deepEqual(bus.calls.filter((call) => call.startsWith("org.bluez.Device1")), []);
  });

  it("waits for a connection that is still discovering services instead of dropping it", async () => {
    const bus = new FakeBus(undefined, { resolveLater: true });
    bus.connected = true;
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    const connecting = device.connect(1000);
    await settle();
    bus.resolveServices();
    await connecting;

    assert.deepEqual(bus.calls.filter((call) => call.startsWith("org.bluez.Device1")), []);
  });

  it("waits when BlueZ reports a connection already in progress", async () => {
    const bus = new FakeBus(undefined, { resolveLater: true });
    bus.connectError = "org.bluez.Error.InProgress";
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    const connecting = device.connect(1000);
    await settle();
    bus.connected = true;
    bus.resolveServices();
    await connecting;
  });

  it("fails fast when the lock drops during service discovery", async () => {
    const bus = new FakeBus(undefined, { resolveLater: true });
    bus.connected = true;
    const device = await new Bluez(() => bus).device(ADDRESS, 60000);
    const connecting = device.connect(60000);
    await settle();
    bus.dropConnection();

    await assert.rejects(connecting, /Lock disconnected during service discovery/u);
  });

  it("converts D-Bus failures into Bluetooth errors", async () => {
    const bus = new FakeBus(undefined, { connectFailures: ["le-connection-abort-by-local"] });
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    const error = await device.connect(1000).catch((caught) => caught);

    assert.equal(error instanceof BluetoothError, true);
    assert.equal(error.message, "le-connection-abort-by-local");
    assert.equal(error.type, "org.bluez.Error.Failed");
  });

  it("delivers notifications and disconnects, then stops after close", async () => {
    const bus = new FakeBus();
    const device = await new Bluez(() => bus).device(ADDRESS, 1000);
    await device.connect(1000);
    const characteristics = await device.characteristics([READ]);
    const values = [];
    let disconnects = 0;
    await device.startNotify(characteristics[READ], (value) => values.push(value.toString("hex")));
    device.onDisconnect(() => disconnects++);

    bus.notify(characteristics[READ], Buffer.from("abcd", "hex"));
    bus.changed(characteristics[READ], "org.bluez.GattCharacteristic1", { Notifying: new dbus.Variant("b", true) });
    bus.dropConnection();
    await settle();
    assert.deepEqual(values, ["abcd"]);
    assert.equal(disconnects, 1);

    device.close();
    bus.connected = true;
    bus.dropConnection();
    assert.equal(disconnects, 1);
  });

  it("writes with a response and closes the bus", async () => {
    const bus = new FakeBus();
    const bluez = new Bluez(() => bus);
    const device = await bluez.device(ADDRESS, 1000);
    await device.disconnect();
    await assert.rejects(device.write(`${DEVICE}/service0010/char0011`, Buffer.alloc(18)), /Not connected/u);

    bluez.close();
    assert.equal(bus.disconnected, true);
  });

  it("reconnects the bus after a bus error", async () => {
    const buses = [new FakeBus(), new FakeBus()];
    let created = 0;
    const bluez = new Bluez(() => buses[created++]);
    await bluez.device(ADDRESS, 1000);
    buses[0].emit("error", new Error("bus closed"));
    await bluez.device(ADDRESS, 1000);

    assert.equal(created, 2);
    assert.equal(buses[1].calls.filter((call) => call === "org.freedesktop.DBus.AddMatch").length, 2);
  });
});
