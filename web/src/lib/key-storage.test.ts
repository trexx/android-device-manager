import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { TangoKey } from "@yume-chan/adb-credential-web";
import { beforeEach, describe, expect, it } from "vitest";
import { IndexedDbKeyStorage } from "./key-storage";

// Runs against fake-indexeddb (an in-memory, spec-faithful IndexedDB). Each
// test starts from a fresh origin by swapping in a new factory.

async function collect(storage: IndexedDbKeyStorage): Promise<TangoKey[]> {
  const out: TangoKey[] = [];
  for await (const key of storage.load()) out.push(key);
  return out;
}

function open(name: string, version?: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Create exactly the database Tango 2 (`@yume-chan/adb-credential-web` 2.x) wrote. */
async function seedTango2(keys: Uint8Array[]) {
  const db = await open("Tango", 1, (db) => {
    db.createObjectStore("Authentication", { autoIncrement: true });
  });
  const transaction = db.transaction("Authentication", "readwrite");
  for (const key of keys) transaction.objectStore("Authentication").add(key);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

/** Raw view of the database, to check the layout Tango's own storage expects. */
async function dump() {
  const db = await open("Tango");
  const names = Array.from(db.objectStoreNames);
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = db
      .transaction("Authentication", "readonly")
      .objectStore("Authentication")
      .getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const version = db.version;
  db.close();
  return { version, names, records };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe("IndexedDbKeyStorage", () => {
  it("yields nothing on a fresh origin and creates Tango's layout", async () => {
    const storage = new IndexedDbKeyStorage();
    expect(await collect(storage)).toEqual([]);
    expect(await dump()).toEqual({ version: 2, names: ["Authentication"], records: [] });
  });

  it("round-trips keys with their names, in insertion order, across connections", async () => {
    const storage = new IndexedDbKeyStorage();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    await storage.save(a, "Android Device Manager");
    await storage.save(b, undefined);

    const keys = await collect(storage);
    expect(keys).toEqual([
      { privateKey: a, name: "Android Device Manager" },
      { privateKey: b, name: undefined },
    ]);
    expect(keys[0]?.privateKey).toBeInstanceOf(Uint8Array);
    // A further operation still works: nothing reuses a closed connection.
    expect(await collect(storage)).toHaveLength(2);
  });

  it("migrates Tango 2's version-1 layout in place, keeping the key bytes", async () => {
    const old1 = new Uint8Array([9, 8, 7, 6]);
    const old2 = new Uint8Array([5, 4]);
    await seedTango2([old1, old2]);

    const storage = new IndexedDbKeyStorage();
    expect(await collect(storage)).toEqual([
      { privateKey: old1, name: undefined },
      { privateKey: old2, name: undefined },
    ]);
    expect(await dump()).toEqual({
      version: 2,
      names: ["Authentication"],
      records: [
        { privateKey: old1, name: undefined },
        { privateKey: old2, name: undefined },
      ],
    });

    // New keys land beside the migrated ones.
    const fresh = new Uint8Array([1]);
    await storage.save(fresh, "Android Device Manager");
    expect((await collect(storage)).map((key) => key.privateKey)).toEqual([old1, old2, fresh]);
  });

  it("releases the connection when the consumer stops iterating early", async () => {
    const storage = new IndexedDbKeyStorage();
    await storage.save(new Uint8Array([1]), "first");
    await storage.save(new Uint8Array([2]), "second");
    for await (const key of storage.load()) {
      expect(key.name).toBe("first");
      break;
    }
    // A lingering connection would block this version bump indefinitely.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("upgrade blocked by an open connection")), 1000),
    );
    const db = await Promise.race([open("Tango", 3), timeout]);
    expect(db.version).toBe(3);
    db.close();
  });
});
