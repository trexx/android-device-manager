import { Adb, adbDaemonAuthenticate } from "@yume-chan/adb";
import type { AdbDaemonConnection } from "@yume-chan/adb";
import {
  AdbWebCryptoCredentialManager,
  TangoIndexedDbStorage,
} from "@yume-chan/adb-credential-web";

// A single RSA credential store backs every connection, regardless of
// transport (USB, network, ADB server). The private key lives only in
// IndexedDB and is never transmitted to any server. Tango's IndexedDB storage
// migrates keys written by its older layout (what this app used before Tango
// 3), so devices authorized earlier stay authorized.
const CREDENTIAL_APP_NAME = "Android Device Manager";

let credentialManager: AdbWebCryptoCredentialManager | undefined;

function getCredentialManager(): AdbWebCryptoCredentialManager {
  return (credentialManager ??= new AdbWebCryptoCredentialManager(
    new TangoIndexedDbStorage(),
    CREDENTIAL_APP_NAME,
  ));
}

/**
 * Run the ADB authentication handshake over an already-open daemon connection
 * and produce an {@link Adb} instance.
 *
 * This is transport-agnostic on purpose: the USB and network transports both
 * feed a connection in here so every feature panel sees an identical `Adb`
 * object. On first connection the device shows an RSA "Allow USB debugging?"
 * prompt that the user must accept.
 */
export async function authenticate(
  serial: string,
  connection: AdbDaemonConnection,
): Promise<Adb> {
  const transport = await adbDaemonAuthenticate({
    serial,
    connection,
    credentialManager: getCredentialManager(),
  });
  return new Adb(transport);
}
