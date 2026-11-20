// IndexedDB: свои меню (с фото), очередь фото на распознавание.
const DB_NAME = "menu-pt";
const VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("menus")) db.createObjectStore("menus", { keyPath: "id" });
      if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  all: (store) => tx(store, "readonly", (s) => wrap(s.getAll())),
  get: (store, id) => tx(store, "readonly", (s) => wrap(s.get(id))),
  put: (store, value) => tx(store, "readwrite", (s) => wrap(s.put(value))),
  del: (store, id) => tx(store, "readwrite", (s) => wrap(s.delete(id))),
};

// Фото храним отдельно: { id, blob }.
const urlCache = new Map();
export async function photoURL(ref) {
  if (!ref) return "";
  if (/^(https?:|photos\/)/.test(ref)) return ref; // фото уже лежит в репозитории
  if (urlCache.has(ref)) return urlCache.get(ref);
  const rec = await db.get("photos", ref);
  if (!rec) return "";
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(ref, url);
  return url;
}

export async function persist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* не критично */ }
}
