import type { IndexRecord } from "./index-core";

/** IndexedDB storage for the local news index (works in the service worker and the panel). */
const DB = "fact-checker-index";
const ITEMS = "items";
const META = "meta";

export type IndexMeta = { lastRefresh: number | null; count: number; feedsOk: number; feedsTotal: number; running: boolean };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: "k" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => {
          db.close();
          resolve(req ? (req.result as T) : undefined);
        };
        t.onerror = () => reject(t.error);
      }),
  );
}

export async function putRecords(records: IndexRecord[]): Promise<void> {
  if (!records.length) return;
  await tx(ITEMS, "readwrite", (s) => {
    for (const r of records) s.put(r);
  });
}

export async function allRecords(): Promise<IndexRecord[]> {
  return (await tx<IndexRecord[]>(ITEMS, "readonly", (s) => s.getAll())) ?? [];
}

export async function deleteKeys(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await tx(ITEMS, "readwrite", (s) => {
    for (const k of keys) s.delete(k);
  });
}

export async function getMeta(): Promise<IndexMeta> {
  return (await tx<IndexMeta>(META, "readonly", (s) => s.get("meta"))) ?? { lastRefresh: null, count: 0, feedsOk: 0, feedsTotal: 0, running: false };
}

export async function setMeta(m: IndexMeta): Promise<void> {
  await tx(META, "readwrite", (s) => s.put(m, "meta"));
}

export async function clearIndex(): Promise<void> {
  await tx(ITEMS, "readwrite", (s) => s.clear());
  await setMeta({ lastRefresh: null, count: 0, feedsOk: 0, feedsTotal: 0, running: false });
}
