// Мурчалка — хранилище на IndexedDB.
// books: описание книги; chapters: [id, n] → html; res: [id, путь] → {type, data}; progress: где остановилась.
//
// Safari на iPhone иногда сам закрывает соединение с базой, если приложение долго было в фоне
// («Connection to Indexed Database server lost»). Поэтому каждое действие при такой ошибке
// один раз переоткрывает базу и повторяется — запись прогресса не теряется.

let dbp = null;

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('murchalka', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('chapters');
      d.createObjectStore('res');
      d.createObjectStore('progress', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); dbp = null; };
      d.onclose = () => { dbp = null; };
      resolve(d);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

export function db() {
  if (!dbp) dbp = open().catch(e => { dbp = null; throw e; });
  return dbp;
}

const lost = e => e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || e.name === 'TransactionInactiveError' ||
  /connection|closing|lost/i.test(e.message || ''));

// выполнить действие с базой; если соединение потеряно — переоткрыть и попробовать ещё раз
async function run(fn) {
  try {
    return await fn(await db());
  } catch (e) {
    if (!lost(e)) throw e;
    dbp = null;
    return fn(await db());
  }
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('transaction aborted')); });

export const get = (store, key) => run(d => req(d.transaction(store).objectStore(store).get(key)));
export const getAll = store => run(d => req(d.transaction(store).objectStore(store).getAll()));

export const put = (store, val, key) => run(d => {
  const t = d.transaction(store, 'readwrite');
  key === undefined ? t.objectStore(store).put(val) : t.objectStore(store).put(val, key);
  return done(t);
});

export const saveBook = ({ meta, chapters, resources, cover }) => run(d => {
  const t = d.transaction(['books', 'chapters', 'res'], 'readwrite');
  t.objectStore('books').put(meta);
  chapters.forEach((h, i) => t.objectStore('chapters').put(h, [meta.id, i]));
  for (const [k, r] of resources) t.objectStore('res').put(r, [meta.id, k]);
  if (cover) t.objectStore('res').put(cover, [meta.id, '__cover']);
  return done(t);
});

// Прогресс (страница и закладки) при удалении НЕ стираем: если книжку добавят снова, место найдётся.
export const deleteBook = id => run(d => {
  const t = d.transaction(['books', 'chapters', 'res'], 'readwrite');
  t.objectStore('books').delete(id);
  t.objectStore('chapters').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  t.objectStore('res').delete(IDBKeyRange.bound([id, ''], [id, '￿']));
  return done(t);
});
