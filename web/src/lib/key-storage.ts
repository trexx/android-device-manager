import type { TangoKey, TangoKeyStorage } from "@yume-chan/adb-credential-web";

/**
 * IndexedDB-backed store for the browser's ADB RSA private key.
 *
 * Tango ships `TangoIndexedDbStorage` for this, but the 3.0.0-beta.3 version is
 * unusable: its `load()` returns a promise from the callback of its own
 * transaction helper, and that helper rejects promise results outright
 * ("callback must not be an async function"), so every authentication attempt
 * failed before a key was even looked up. It also caches one connection and
 * closes it after each operation, so a second operation would hit a closed
 * connection. Upstream `main` still has both problems (checked 2026-09-21).
 *
 * This replacement uses exactly Tango's layout — database "Tango", version 2,
 * object store "Authentication" with auto-increment keys and
 * `{ privateKey, name }` records — and upgrades Tango 2's version-1 layout
 * (bare `Uint8Array` values in the same store) in place. Keys that devices have
 * already authorized keep working, and the app can go back to Tango's own
 * storage once a fixed release exists. Every operation opens and closes its own
 * connection; nothing is cached.
 */

const DATABASE_NAME = "Tango";
const STORE_NAME = "Authentication";
const VERSION = 2;

function waitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function waitTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Rewrite Tango 2 records (bare key bytes) into `{ privateKey, name }` records. */
function migrateV1(store: IDBObjectStore): void {
  const cursorRequest = store.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const value: unknown = cursor.value;
    if (value instanceof Uint8Array) {
      cursor.update({ privateKey: value, name: undefined } satisfies TangoKey);
    }
    cursor.continue();
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, VERSION);
    let blocked = false;

    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1 || !db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      } else if (event.oldVersion < 2) {
        // `transaction` is always set inside onupgradeneeded.
        migrateV1(request.transaction!.objectStore(STORE_NAME));
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(
        new Error(
          "The key store is open in another tab with an older version; close other tabs of this app and retry",
        ),
      );
    };
    request.onsuccess = () => {
      if (blocked) {
        // The other tab eventually released it; nobody is waiting any more.
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open the key store"));
  });
}

export class IndexedDbKeyStorage implements TangoKeyStorage {
  async save(privateKey: Uint8Array, name: string | undefined): Promise<undefined> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).add({ privateKey, name } satisfies TangoKey);
      await waitTransaction(transaction);
    } finally {
      db.close();
    }
  }

  async *load(): AsyncGenerator<TangoKey, void, void> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const keys = await waitRequest(
        transaction.objectStore(STORE_NAME).getAll() as IDBRequest<TangoKey[]>,
      );
      yield* keys;
    } finally {
      db.close();
    }
  }
}
