import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import type { AdbDaemonConnection } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

// A single RSA credential store backs every connection, regardless of
// transport (USB now, WebSocket in Phase 2). The private key lives only in
// IndexedDB and is never transmitted to any server.
const CREDENTIAL_APP_NAME = "Android Device Manager";

let credentialStore: AdbWebCredentialStore | undefined;

function getCredentialStore(): AdbWebCredentialStore {
  return (credentialStore ??= new AdbWebCredentialStore(CREDENTIAL_APP_NAME));
}

/**
 * Run the ADB authentication handshake over an already-open daemon connection
 * and produce an {@link Adb} instance.
 *
 * This is transport-agnostic on purpose: both the USB transport and the future
 * WebSocket transport feed a connection in here so every feature panel sees an
 * identical `Adb` object. On first connection the device shows an RSA "Allow
 * USB debugging?" prompt that the user must accept.
 */
export async function authenticate(
  serial: string,
  connection: AdbDaemonConnection,
): Promise<Adb> {
  const transport = await AdbDaemonTransport.authenticate({
    serial,
    connection,
    credentialStore: getCredentialStore(),
  });
  return new Adb(transport);
}
