// Мурчалка — разбор книг: EPUB, FB2 (и .fb2.zip), TXT.
// Без внешних библиотек: ZIP распаковываем сами через DecompressionStream.

const LIMIT = 60000; // примерно столько символов в одной «главе-куске», чтобы вёрстка на телефоне была быстрой

export class BookError extends Error {}

const outDoc = document.implementation.createHTMLDocument('');
const mk = (tag, cls) => { const e = outDoc.createElement(tag); if (cls) e.className = cls; return e; };

/* ---------- общий вход ---------- */

export async function parseBook(file, onStep = () => {}) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const name = (file.name || '').toLowerCase();
  onStep('Нюхаю файл');
  const id = await hashId(buf);
  let res;
  // что внутри — смотрим по содержимому, а не по имени файла (сайты часто путают имена)
  const head = decodeText(u8.subarray(0, 4096));
  const isZip = (u8[0] === 0x50 && u8[1] === 0x4b) || findEocd(u8) >= 0;
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) {
    throw new BookError('PDF — это картинки страниц, а не текст. Поищи эту книгу в EPUB или FB2 🐾');
  } else if (/<FictionBook/i.test(head)) {
    onStep('Листаю главы');
    res = parseFb2(u8);
  } else if (isZip) {
    const zip = openZip(u8);
    onStep('Листаю главы');
    if (zip.has('META-INF/container.xml')) res = await parseEpub(zip);
    else {
      const fb = zip.names.find(n => /\.fb2$/i.test(n));
      const ep = zip.names.find(n => /\.epub$/i.test(n));
      const txt = zip.names.find(n => /\.txt$/i.test(n));
      if (fb) res = parseFb2(await zip.bytes(fb));
      else if (ep) res = await parseEpub(openZip(await zip.bytes(ep)));
      else if (txt) res = parseTxt(await zip.bytes(txt), txt);
      else throw new BookError('В архиве нет книжки — нужен EPUB, FB2 или TXT');
    }
  } else if (/^\s*(<!doctype\s+html|<html|<head|<meta|<script)/i.test(head) || /<html[\s>]/i.test(head.slice(0, 1000))) {
    throw new BookError('Это не книга, а страница сайта: сайт не отдал файл. Скачай ещё раз (лучше EPUB или FB2) или попробуй другой сайт 🐾');
  } else if (/\.(mobi|azw3?|djvu|docx?|rtf|cbz|cbr)$/.test(name)) {
    throw new BookError('Этот формат пока не умею. Скачай книгу в EPUB или FB2 🐾');
  } else if (/\.(fb2|epub|zip)$/.test(name)) {
    throw new BookError('Файл повреждён или скачался не полностью. Скачай книгу ещё раз 🐾');
  } else {
    const ctrl = (head.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
    if (ctrl > head.length * 0.02) throw new BookError('Файл не похож на книгу. Нужен EPUB, FB2 или TXT 🐾');
    onStep('Листаю главы');
    res = parseTxt(u8, file.name);
  }
  onStep('Раскладываю по полочкам');
  return finalize(res, id, file);
}

async function hashId(buf) {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return 'b' + [...new Uint8Array(d).slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // запасной вариант без crypto.subtle (не https)
    const u = new Uint8Array(buf); let h = 2166136261 >>> 0;
    const step = Math.max(1, Math.floor(u.length / 200000));
    for (let i = 0; i < u.length; i += step) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    return 'b' + h.toString(16) + u.length.toString(16);
  }
}

/* ---------- ZIP ---------- */

function findEocd(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function openZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const eocd = findEocd(u8);
  if (eocd < 0) throw new BookError('Файл повреждён — не открывается как архив');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let p = dv.getUint32(eocd + 16, true);
  // если перед архивом что-то приклеено (самораспаковка, мусор) — сдвигаем все смещения
  const shift = eocd - cdSize - p;
  if (shift > 0) p += shift;
  const entries = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, lho: lho + (shift > 0 ? shift : 0) });
    p += 46 + nlen + elen + clen;
  }
  const lower = new Map([...entries.keys()].map(n => [n.toLowerCase(), n]));
  const find = n => entries.get(n) || entries.get(lower.get(n.toLowerCase()));
  return {
    names: [...entries.keys()],
    has: n => !!find(n),
    async bytes(n) {
      const e = find(n);
      if (!e) return null;
      const o = e.lho;
      const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
      const data = u8.subarray(start, start + e.csize);
      if (e.method === 0) return data.slice();
      if (e.method === 8) return inflate(data);
      throw new BookError('Непонятное сжатие внутри архива');
    },
    async text(n) { const b = await this.bytes(n); return b ? decodeText(b) : null; },
  };
}

async function inflate(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new BookError('Чтобы открывать EPUB, обнови iOS до 16.4 или новее');
  }
  const s = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ---------- текст и кодировки ---------- */

const latin1 = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };

function decodeText(u8, enc) {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (enc && !/^utf-?8$/i.test(enc)) { try { return new TextDecoder(enc).decode(u8); } catch { /* неизвестная — гадаем ниже */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* не utf-8 */ }
  // русские однобайтовые: в cp1251 строчные буквы 0xE0–0xFF, в KOI8-R — 0xC0–0xDF
  let hi = 0, mid = 0;
  for (let i = 0; i < Math.min(u8.length, 200000); i++) { const b = u8[i]; if (b >= 0xe0) hi++; else if (b >= 0xc0) mid++; }
  return new TextDecoder(hi >= mid ? 'windows-1251' : 'koi8-r').decode(u8);
}

function parseXml(str, type = 'application/xml') {
  const d = new DOMParser().parseFromString(str, type);
  return d.getElementsByTagName('parsererror').length ? null : d;
}

const local = el => (el.localName || el.nodeName || '').toLowerCase().replace(/^fb-/, '');
const kids = (el, n) => [...(el?.children || [])].filter(c => local(c) === n);
const kid = (el, n) => kids(el, n)[0];
const textOf = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
function hrefOf(el) {
  for (const a of el.attributes || []) if (/(^|:)href$/i.test(a.name)) return a.value;
  return null;
}
function byLocal(root, n) {
  const out = [];
  const w = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let e = w.currentNode; e; e = w.nextNode()) if (local(e) === n) out.push(e);
  return out;
}

/* ---------- деление на куски ---------- */

function chunk(el, out) {
  if (el.textContent.length <= LIMIT) { out.push(el); return; }
  const list = [...el.childNodes];
  const only = list.filter(n => n.nodeType === 1 ? (n.tagName === 'IMG' || n.textContent.trim() || n.querySelector('img')) : n.data.trim());
  if (only.length === 1 && only[0].nodeType === 1 && only[0].tagName === 'DIV') {
    // одна большая обёртка — спускаемся внутрь, пустые якоря (id) переносим с собой
    const inner = only[0];
    inner.prepend(...list.slice(0, list.indexOf(inner)).filter(n => n.nodeType === 1));
    if (el.id && !inner.id) inner.id = el.id;
    chunk(inner, out); return;
  }
  let cur = mk('div', 'chunk'), curLen = 0;
  if (el.id) cur.id = el.id;
  const flush = () => {
    if (!cur.childNodes.length) return;
    const c = cur.childNodes;
    if (curLen > LIMIT && c.length === 1 && c[0].nodeType === 1 && c[0].tagName === 'DIV') chunk(c[0], out);
    else out.push(cur);
    cur = mk('div', 'chunk'); curLen = 0;
  };
  for (const k of list) {
    const kl = k.textContent.length;
    const isSec = k.nodeType === 1 && k.classList.contains('sec');
    if (curLen > 0 && (isSec || curLen + kl > LIMIT)) flush();
    cur.append(k); curLen += kl;
    if (isSec) flush();
  }
  flush();
}

/* ---------- FB2 ---------- */

function parseFb2(u8) {
  const head = latin1(u8.subarray(0, 300));
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i);
  const str = decodeText(u8, m && m[1]);
  let x = parseXml(str);
  if (!x) {
    // кривой XML: читаем «по-html», заранее переименовав опасные для html-парсера теги
    const fixed = str
      .replace(/<\?xml[^>]*>/, '')
      .replace(/<(\/?)(title|body|style|image)\b/gi, '<$1fb-$2')
      .replace(/<([\w:-]+)([^<>]*?)\/>/g, '<$1$2></$1>');
    x = new DOMParser().parseFromString(fixed, 'text/html');
  }
  const root = local(x.documentElement) === 'fictionbook' ? x.documentElement : byLocal(x, 'fictionbook')[0];
  if (!root) throw new BookError('Это не похоже на FB2');

  const desc = kid(root, 'description');
  const ti = kid(desc, 'title-info');
  const title = textOf(kid(ti, 'book-title')) || 'Без названия';
  const author = kids(ti, 'author').map(a => {
    const n = ['first-name', 'middle-name', 'last-name'].map(k => textOf(kid(a, k))).filter(Boolean).join(' ');
    return n || textOf(kid(a, 'nickname'));
  }).filter(Boolean).join(', ');
  const lang = textOf(kid(ti, 'lang')) || 'ru';

  const bins = new Map();
  for (const b of kids(root, 'binary')) {
    const id = b.getAttribute('id');
    if (!id) continue;
    bins.set(id, { type: b.getAttribute('content-type') || 'image/jpeg', b64: b.textContent });
  }
  const loadBin = id => {
    const b = bins.get(id);
    if (!b) return null;
    try {
      const s = atob(b.b64.replace(/\s+/g, ''));
      const data = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) data[i] = s.charCodeAt(i);
      return { type: b.type, data: data.buffer };
    } catch { return null; }
  };
  const coverHref = hrefOf(kid(kid(ti, 'coverpage'), 'image') || {}) || '';

  const ctx = { secN: 0, toc: [] };
  const bodies = kids(root, 'body');
  const main = bodies.find(b => !/notes|comments/i.test(b.getAttribute('name') || '')) || bodies[0];
  if (!main) throw new BookError('В FB2 нет текста');
  const chapters = [];

  // главный текст: каждая секция верхнего уровня — отдельная глава
  let pre = mk('div', 'sec');
  let first = true;
  for (const n of main.children) {
    if (local(n) === 'section') {
      const c = mk('div', 'sec');
      if (first && pre.childNodes.length) { c.append(...pre.childNodes); }
      first = false;
      fbNode(n, c, ctx, 0);
      chunk(c.childNodes.length === 1 && c.firstChild.classList?.contains('sec') ? c.firstChild : c, chapters);
    } else {
      fbNode(n, first ? pre : (chapters.length ? null : pre), ctx, 0, true);
    }
  }
  if (first && pre.childNodes.length) chunk(pre, chapters);

  const notesFrom = chapters.length;
  for (const b of bodies) {
    if (b === main) continue;
    const c = mk('div', 'sec notes');
    const h = mk('h2'); h.textContent = /comment/i.test(b.getAttribute('name') || '') ? 'Комментарии' : 'Примечания';
    const g = 's' + (++ctx.secN); h.id = g;
    ctx.toc.push({ t: h.textContent, g, d: 1 });
    c.append(h);
    for (const n of b.children) if (local(n) !== 'title') fbNode(n, c, { ...ctx, toc: [] }, 2);
    chunk(c, chapters);
  }

  return {
    title, author, lang, format: 'FB2', chapters, toc: ctx.toc, notesFrom: notesFrom < chapters.length ? notesFrom : null,
    cover: coverHref.replace(/^#/, ''),
    loadRes: key => loadBin(key),
  };
}

const FB_MAP = {
  p: 'p', subtitle: 'p.subtitle', 'text-author': 'p.author', 'empty-line': 'p.empty', poem: 'div.poem',
  stanza: 'div.stanza', v: 'p.v', date: 'p.date', cite: 'blockquote', epigraph: 'blockquote.epigraph',
  emphasis: 'em', strong: 'strong', strikethrough: 's', sup: 'sup', sub: 'sub', code: 'code', style: 'span',
  table: 'table', tr: 'tr', td: 'td', th: 'th', annotation: 'div',
};

function fbNode(n, out, ctx, depth, top = false) {
  if (!out) return;
  if (n.nodeType === 3) {
    if (n.data.trim() || /^(P|EM|STRONG|S|SUP|SUB|CODE|SPAN|A|TD|TH|H\d)$/.test(out.tagName)) out.append(n.data);
    return;
  }
  if (n.nodeType !== 1) return;
  const name = local(n);
  let el;
  if (name === 'section') {
    el = mk('div', 'sec');
    for (const c of n.childNodes) fbNode(c, el, ctx, depth + 1);
  } else if (name === 'title') {
    el = mk('h' + Math.min(1 + Math.max(depth, 1), 4));
    if (top) el = mk('h1', 'book-title');
    const ps = kids(n, 'p');
    if (ps.length) ps.forEach((p, i) => { if (i) el.append(mk('br')); for (const c of p.childNodes) fbNode(c, el, ctx, depth); });
    else for (const c of n.childNodes) fbNode(c, el, ctx, depth);
    if (!top) {
      const g = 's' + (++ctx.secN); el.id = g;
      const t = ps.length ? ps.map(textOf).filter(Boolean).join(' — ') : textOf(el);
      if (t) ctx.toc.push({ t: t.length > 90 ? t.slice(0, 88) + '…' : t, g, d: Math.max(depth, 1) });
    }
  } else if (name === 'image' || name === 'img') {
    const h = (hrefOf(n) || '').replace(/^#/, '');
    if (!h) return;
    el = mk('img'); el.dataset.res = h; el.alt = n.getAttribute('alt') || '';
  } else if (name === 'a') {
    el = mk('a');
    const h = hrefOf(n) || '';
    if (h.startsWith('#')) {
      el.dataset.link = 'n-' + h.slice(1);
      if ((n.getAttribute('type') || '') === 'note') el.dataset.note = '1';
    } else if (/^https?:/i.test(h)) { el.href = h; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    for (const c of n.childNodes) fbNode(c, el, ctx, depth);
  } else if (FB_MAP[name]) {
    const [tag, cls] = FB_MAP[name].split('.');
    el = mk(tag, cls);
    if (name === 'empty-line') el.append(' ');
    for (const c of n.childNodes) fbNode(c, el, ctx, depth);
  } else {
    for (const c of n.childNodes) fbNode(c, out, ctx, depth);
    return;
  }
  const id = n.getAttribute?.('id');
  if (id && !el.id) el.id = 'n-' + id;
  out.append(el);
}

/* ---------- EPUB ---------- */

function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function resolvePath(base, rel) {
  let r = rel.split('#')[0];
  try { r = decodeURIComponent(r); } catch { /* оставляем как есть */ }
  const parts = (r.startsWith('/') ? [] : base.split('/')).concat(r.split('/'));
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
const fragOf = h => { const i = h.indexOf('#'); if (i < 0) return ''; try { return decodeURIComponent(h.slice(i + 1)); } catch { return h.slice(i + 1); } };

async function parseEpub(zip) {
  const cont = parseXml(await zip.text('META-INF/container.xml'));
  const opfPath = cont && byLocal(cont, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new BookError('EPUB повреждён: нет описания книги');
  const opfStr = await zip.text(opfPath);
  const opf = opfStr && (parseXml(opfStr) || new DOMParser().parseFromString(opfStr, 'text/html'));
  if (!opf) throw new BookError('EPUB повреждён');
  const base = dirname(opfPath);
  const md = n => textOf(byLocal(opf, n)[0]);
  const title = md('title') || 'Без названия';
  const author = byLocal(opf, 'creator').map(textOf).filter(Boolean).join(', ');
  const lang = (md('language') || 'ru').slice(0, 5);

  const items = new Map();
  for (const it of byLocal(opf, 'item')) {
    items.set(it.getAttribute('id'), {
      href: resolvePath(base, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const spine = byLocal(opf, 'itemref')
    .map(r => items.get(r.getAttribute('idref')))
    .filter(it => it && /html|xml/i.test(it.type) && !/ncx/.test(it.type));
  if (!spine.length) throw new BookError('В EPUB не нашлось глав');

  // обложка
  let cover = [...items.values()].find(i => /cover-image/.test(i.props));
  if (!cover) {
    const metaCover = byLocal(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
    if (metaCover) cover = items.get(metaCover.getAttribute('content'));
  }
  if (!cover) cover = [...items.entries()].find(([k, v]) => /cover/i.test(k + v.href) && /^image\//.test(v.type))?.[1];

  const fileIdx = new Map(spine.map((it, i) => [it.href, i]));
  const gidFor = (path, frag) => {
    const i = fileIdx.get(path);
    if (i == null) return null;
    return frag ? `f${i}-${frag}` : `f${i}-top`;
  };
  const types = new Map([...items.values()].map(i => [i.href, i.type]));

  const chapters = [];
  for (let i = 0; i < spine.length; i++) {
    const it = spine[i];
    const str = await zip.text(it.href);
    if (!str) continue;
    const d = parseXml(str, 'application/xhtml+xml') || new DOMParser().parseFromString(str, 'text/html');
    const body = byLocal(d, 'body')[0];
    if (!body) continue;
    const c = mk('div', 'sec');
    const top = mk('span'); top.id = `f${i}-top`; c.append(top);
    const ctx = { base: dirname(it.href), prefix: `f${i}-`, gidFor };
    for (const n of body.childNodes) htmlNode(n, c, ctx);
    if (!c.textContent.trim() && !c.querySelector('img')) continue;
    chunk(c, chapters);
    if (i % 4 === 3) await new Promise(r => setTimeout(r)); // даём интерфейсу подышать
  }

  // оглавление: EPUB3 nav или EPUB2 ncx
  const toc = [];
  const navItem = [...items.values()].find(i => /\bnav\b/.test(i.props));
  if (navItem) {
    const s = await zip.text(navItem.href);
    const d = s && (parseXml(s, 'application/xhtml+xml') || new DOMParser().parseFromString(s, 'text/html'));
    if (d) {
      const navs = byLocal(d, 'nav');
      const nav = navs.find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
      const walk = (ol, depth) => {
        for (const li of kids(ol, 'li')) {
          const a = kid(li, 'a') || kid(li, 'span');
          const h = a && a.getAttribute('href');
          const t = textOf(a);
          if (h && t) {
            const g = gidFor(resolvePath(dirname(navItem.href), h), fragOf(h));
            if (g) toc.push({ t, g, d: depth });
          }
          const sub = kid(li, 'ol');
          if (sub) walk(sub, depth + 1);
        }
      };
      const ol = nav && byLocal(nav, 'ol')[0];
      if (ol) walk(ol, 1);
    }
  }
  if (!toc.length) {
    const ncx = items.get(spineEl?.getAttribute('toc')) || [...items.values()].find(i => /ncx/.test(i.type));
    const s = ncx && await zip.text(ncx.href);
    const d = s && parseXml(s);
    if (d) {
      const walk = (el, depth) => {
        for (const np of kids(el, 'navpoint')) {
          const t = textOf(kid(kid(np, 'navlabel'), 'text'));
          const h = kid(np, 'content')?.getAttribute('src');
          if (h && t) {
            const g = gidFor(resolvePath(dirname(ncx.href), h), fragOf(h));
            if (g) toc.push({ t, g, d: depth });
          }
          walk(np, depth + 1);
        }
      };
      const map = byLocal(d, 'navmap')[0];
      if (map) walk(map, 1);
    }
  }

  return {
    title, author, lang, format: 'EPUB', chapters, toc, notesFrom: null,
    cover: cover?.href || '',
    loadRes: async key => {
      const data = await zip.bytes(key);
      if (!data) return null;
      return { type: types.get(key) || guessType(key), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    },
  };
}

function guessType(p) {
  const e = p.split('.').pop().toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[e] || 'application/octet-stream';
}

const KEEP = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'em', 'i', 'strong', 'b', 'u', 's',
  'sup', 'sub', 'small', 'br', 'hr', 'span', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure',
  'figcaption', 'dl', 'dt', 'dd', 'cite', 'q', 'mark']);
const RENAME = { section: 'div', article: 'div', main: 'div', header: 'div', footer: 'div', aside: 'div', nav: 'div', center: 'div',
  strike: 's', del: 's', ins: 'u', big: 'span', font: 'span', tt: 'code', abbr: 'span', var: 'em', dfn: 'em', kbd: 'code', samp: 'code', address: 'p', caption: 'p' };
const DROP = new Set(['script', 'style', 'link', 'meta', 'title', 'head', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'select', 'textarea', 'video', 'audio', 'canvas', 'noscript', 'template', 'math', 'map', 'area']);
const WS_DROP = /^(DIV|UL|OL|TABLE|THEAD|TBODY|TFOOT|TR|DL|FIGURE|BLOCKQUOTE)$/;

function htmlNode(n, out, ctx) {
  if (n.nodeType === 3 || n.nodeType === 4) {
    if (!n.data.trim() && WS_DROP.test(out.tagName)) return;
    out.append(n.data);
    return;
  }
  if (n.nodeType !== 1) return;
  const name = local(n);
  if (DROP.has(name)) return;
  let el;
  if (name === 'img' || name === 'image') {
    const src = n.getAttribute('src') || hrefOf(n);
    if (!src || /^data:|^https?:/i.test(src)) return;
    el = mk('img'); el.dataset.res = resolvePath(ctx.base, src); el.alt = n.getAttribute('alt') || '';
  } else if (name === 'svg') {
    const im = byLocal(n, 'image')[0];
    if (im) htmlNode(im, out, ctx);
    return;
  } else if (name === 'a') {
    el = mk('a');
    const h = n.getAttribute('href') || '';
    if (/^(https?|mailto):/i.test(h)) { el.href = h; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    else if (h) {
      const g = h.startsWith('#') ? ctx.prefix + fragOf(h) : ctx.gidFor(resolvePath(ctx.base, h), fragOf(h));
      if (g) el.dataset.link = g;
      const et = n.getAttribute('epub:type') || n.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '';
      if (/noteref/.test(et) || /note/i.test(n.getAttribute('class') || '')) el.dataset.note = '1';
    }
  } else if (KEEP.has(name) || RENAME[name]) {
    el = mk(RENAME[name] || name);
    if (name === 'center') el.className = 'c';
    const st = (n.getAttribute('style') || '') + ' ' + (n.getAttribute('class') || '');
    if (/text-align\s*:\s*center|\bcenter|centr/i.test(st) && name !== 'center') el.className = 'c';
    else if (/text-align\s*:\s*right|\bright\b/i.test(st)) el.className = 'r';
  } else {
    // неизвестный тег — берём только содержимое
    for (const c of n.childNodes) htmlNode(c, out, ctx);
    return;
  }
  const id = n.getAttribute('id');
  if (id) el.id = ctx.prefix + id;
  if (name !== 'img' && name !== 'image') for (const c of n.childNodes) htmlNode(c, el, ctx);
  out.append(el);
}

/* ---------- TXT ---------- */

const HEAD_RE = /^\s*((глава|часть|книга|том|пролог|эпилог|предисловие|послесловие|вступление|заключение|chapter|part|book|prologue|epilogue)(?!\p{L}).{0,70}|[IVXLC]{1,7}\.?|\*\s*\*\s*\*)\s*$/iu;

function parseTxt(u8, fileName) {
  const s = decodeText(u8).replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  const nonEmpty = lines.filter(l => l.trim());
  const blank = lines.length - nonEmpty.length;
  const avg = nonEmpty.reduce((a, l) => a + l.length, 0) / Math.max(1, nonEmpty.length);
  let paras;
  if (blank > lines.length * 0.12 && avg < 100) {
    // жёсткие переносы строк внутри абзацев — склеиваем
    paras = s.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  } else {
    paras = nonEmpty.map(l => l.trim());
  }
  const root = mk('div', 'sec');
  let sec = root;
  const toc = [];
  let n = 0;
  for (const p of paras) {
    if (p.length < 80 && HEAD_RE.test(p)) {
      if (/^\*\s*\*\s*\*$/.test(p)) { const e = mk('p', 'c'); e.textContent = '* * *'; sec.append(e); continue; }
      sec = mk('div', 'sec'); root.append(sec);
      const h = mk('h2'); h.textContent = p; h.id = 't' + (++n); sec.append(h);
      toc.push({ t: p, g: h.id, d: 1 });
    } else {
      const e = mk('p'); e.textContent = p; sec.append(e);
    }
  }
  const chapters = [];
  chunk(root, chapters);
  const { title, author } = nameToTitle(fileName);
  return { title, author, lang: 'ru', format: 'TXT', chapters, toc, notesFrom: null, cover: '', loadRes: () => null };
}

// «Эриксон Эрик. Детство и общество - royallib.com.fb2.zip» → автор «Эриксон Эрик», название «Детство и общество»
export function nameToTitle(fileName) {
  let t = (fileName || 'Книжка').replace(/_/g, ' ');
  for (let i = 0; i < 4; i++) t = t.replace(/\.(zip|fb2|epub|txt|html?|download|crdownload)$/i, '');
  t = t.replace(/[\s.\-–—(\[]*(www\.)?[a-z0-9-]+\.(com|ru|net|org|me|info|club|biz|su|ws|to|cc|io)[)\]]*$/i, '').trim();
  let author = '';
  let m = t.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,})$/);
  if (m) { author = m[1].trim(); t = m[2].trim(); }
  else if ((m = t.match(/^([А-ЯЁA-Z][\p{L}'-]+(?:\s+[А-ЯЁA-Z][\p{L}.'-]*){1,2})\.\s+(.{2,})$/u))) { author = m[1].trim(); t = m[2].trim(); }
  return { title: t || 'Книжка', author };
}

/* ---------- сборка ---------- */

async function finalize(res, id, file) {
  if (!res.chapters.length) throw new BookError('В книжке не нашлось текста 😿');
  if (!res.title || res.title === 'Без названия') {
    const n = nameToTitle(file.name);
    res.title = n.title;
    res.author = res.author || n.author;
  }
  // оставляем только те id, на которые кто-то ссылается
  const targets = new Set(res.toc.map(t => t.g));
  for (const c of res.chapters) for (const a of c.querySelectorAll('a[data-link]')) targets.add(a.dataset.link);
  const ids = {};
  res.chapters.forEach((c, i) => {
    for (const e of [c, ...c.querySelectorAll('[id]')]) {
      if (!e.id) continue;
      if (targets.has(e.id)) { if (!(e.id in ids)) ids[e.id] = i; }
      else e.removeAttribute('id');
    }
  });
  let toc = res.toc.filter(t => t.g in ids).map(t => ({ ...t, ch: ids[t.g] }));
  if (!toc.length) {
    res.chapters.forEach((c, i) => {
      const h = c.querySelector('h1,h2,h3');
      const t = textOf(h);
      if (!t) return;
      if (!h.id) h.id = 'auto-' + i;
      ids[h.id] = i;
      toc.push({ t: t.slice(0, 90), g: h.id, d: 1, ch: i });
    });
  }
  const resKeys = new Set();
  for (const c of res.chapters) for (const im of c.querySelectorAll('img[data-res]')) resKeys.add(im.dataset.res);
  const html = res.chapters.map(c => c.outerHTML);
  const tmp = mk('div');
  const lens = html.map(h => { tmp.innerHTML = h; return tmp.textContent.length; });

  const resources = [];
  for (const k of resKeys) {
    const r = await res.loadRes(k);
    if (r) resources.push([k, r]);
  }
  const cover = res.cover ? await res.loadRes(res.cover) : null;

  return {
    meta: {
      id, title: res.title, author: res.author, lang: res.lang || 'ru', format: res.format,
      chapterLens: lens, totalLen: lens.reduce((a, b) => a + b, 0) || 1,
      toc, ids, notesFrom: res.notesFrom ?? null,
      hasCover: !!cover, fileName: file.name || '', size: file.size || 0,
      addedAt: Date.now(), openedAt: 0,
    },
    chapters: html,
    resources,
    cover,
  };
}
