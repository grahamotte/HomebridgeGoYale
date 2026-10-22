# Go Yale

Homebridge plugin for Yale and August locks over local Bluetooth. It talks to
the lock directly through BlueZ, with no Yale or August cloud account, bridge,
or Wi-Fi module.

## Features

- Locks and unlocks over Bluetooth Low Energy using the lock's offline key.
- Exposes lock state, jams, and battery level to HomeKit.
- Retries dropped connections and disconnects when idle to save lock battery.

## Requirements

- Linux with BlueZ (`bluetoothd`) running and a Bluetooth adapter in range of the lock.
- The Homebridge user must be allowed to call `org.bluez` on the system D-Bus, which BlueZ permits by default.
- The lock's Bluetooth address, offline key, and key slot. These are the same values
  `yalexs-ble` and Home Assistant's Yale Access Bluetooth integration use. They can be
  read once from the lock's August or Yale Access account.

## Setup

```json
{
  "platform": "GoYale",
  "name": "GoYale",
  "locks": [
    {
      "name": "Front Door",
      "address": "A4:C1:38:5E:2D:73",
      "key": "00112233445566778899aabbccddeeff",
      "slot": 1
    }
  ]
}
```

## Options

- `locks`: each lock's `name`, Bluetooth `address`, offline `key`, and key `slot`.
- `adapter`: optional Bluetooth adapter such as `hci1`. Default: the first adapter.
- `pollIntervalSeconds`: background refresh interval. Use `0` to disable. Default: `900`.
- `idleDisconnectSeconds`: how long to stay connected after a command. Default: `30`.
- `keepConnected`: stay connected for faster commands and live state. Default: `false`.

## Notes

The protocol implementation follows [yalexs-ble](https://github.com/bdraco/yalexs-ble).
Bluetooth range matters: a weak signal shows up as slow or failed connections.
