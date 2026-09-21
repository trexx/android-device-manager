import { Adb, adbDaemonAuthenticate } from "@yume-chan/adb";
import type { AdbDaemonConnection } from "@yume-chan/adb";
import { AdbWebCryptoCredentialManager } from "@yume-chan/adb-credential-web";
import { IndexedDbKeyStorage } from "./key-storage";

// A single RSA credential store backs every connection, regardless of
// transport (USB, network, ADB server). The private key lives only in
// IndexedDB and is never transmitted to any server. The store is our own
// `IndexedDbKeyStorage` rather than Tango's `TangoIndexedDbStorage`: the
// 3.0.0-beta.3 one throws on every load (see key-storage.ts). Ours uses the
// same database layout and also migrates keys written by Tango 2 (what this
// app used before Tango 3), so devices authorized earlier stay authorized.
const CREDENTIAL_APP_NAME = "Android Device Manager";

let credentialManager: AdbWebCryptoCredentialManager | undefined;

function getCredentialManager(): AdbWebCryptoCredentialManager {
  return (credentialManager ??= new AdbWebCryptoCredentialManager(
    new IndexedDbKeyStorage(),
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
