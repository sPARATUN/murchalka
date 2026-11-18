// Мурчалка — хранилище на IndexedDB.
// books: описание книги; chapters: [id, n] → html; res: [id, путь] → {type, data}; progress: где остановилась.

let dbp;
export function db() {
  return dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('murchalka', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('chapters');
      d.createObjectStore('res');
      d.createObjectStore('progress', { keyPath: 'id' });
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); resolve(d); };
    r.onerror = () => { dbp = null; reject(r.error); };
  });
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export async function get(store, key) {
  const d = await db();
  return req(d.transaction(store).objectStore(store).get(key));
}
export async function getAll(store) {
  const d = await db();
  return req(d.transaction(store).objectStore(store).getAll());
}
export async function put(store, val, key) {
  const d = await db();
  const t = d.transaction(store, 'readwrite');
  key === undefined ? t.objectStore(store).put(val) : t.objectStore(store).put(val, key);
  return done(t);
}

export async function saveBook({ meta, chapters, resources, cover }) {
  const d = await db();
  const t = d.transaction(['books', 'chapters', 'res'], 'readwrite');
  t.objectStore('books').put(meta);
  chapters.forEach((h, i) => t.objectStore('chapters').put(h, [meta.id, i]));
  for (const [k, r] of resources) t.objectStore('res').put(r, [meta.id, k]);
  if (cover) t.objectStore('res').put(cover, [meta.id, '__cover']);
  return done(t);
}

// Прогресс (страница и закладки) при удалении НЕ стираем: если книжку добавят снова, место найдётся.
export async function deleteBook(id) {
  const d = await db();
  const t = d.transaction(['books', 'chapters', 'res'], 'readwrite');
  t.objectStore('books').delete(id);
  t.objectStore('chapters').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  t.objectStore('res').delete(IDBKeyRange.bound([id, ''], [id, '￿']));
  return done(t);
}
