import type { Adb } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import type { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { authenticate } from "./adb-manager";

/**
 * Whether the current runtime can talk to USB devices. WebUSB is only available
 * in Chromium-based browsers served over HTTPS (or http://localhost).
 */
export function isWebUsbSupported(): boolean {
  return AdbDaemonWebUsbDeviceManager.BROWSER !== undefined;
}

function manager(): AdbDaemonWebUsbDeviceManager {
  const instance = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!instance) {
    throw new Error(
      "WebUSB is not available. Use a Chromium-based browser served over HTTPS or http://localhost.",
    );
  }
  return instance;
}

/**
 * Prompt the user to pick a USB device. Must be called from a user gesture
 * (e.g. a click). Returns `undefined` if the user dismisses the picker.
 *
 * The manager merges the default ADB interface filter automatically, so the
 * picker only lists devices exposing an ADB interface.
 */
export function requestUsbDevice(): Promise<AdbDaemonWebUsbDevice | undefined> {
  return manager().requestDevice();
}

/**
 * List devices the user has already authorized in this browser (no prompt).
 */
export function getAuthorizedUsbDevices(): Promise<AdbDaemonWebUsbDevice[]> {
  return manager().getDevices();
}

/**
 * Open a USB device and run the ADB handshake, yielding a ready `Adb` instance.
 *
 * Note: kill any local `adb` server first (`adb kill-server`) — the OS lets
 * only one process claim the device's USB interface at a time.
 */
export async function connectUsb(device: AdbDaemonWebUsbDevice): Promise<Adb> {
  const connection = await device.connect();
  return authenticate(device.serial, connection);
}
