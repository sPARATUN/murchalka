// Мурчалка — полка и читалка.
import * as DB from './db.js';
import { parseBook, BookError } from './parsers.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduceMQ = matchMedia('(prefers-reduced-motion: reduce)');
const motionOK = () => !reduceMQ.matches;
const safeJSON = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* ничего */ } };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const icon = (id, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.append(u); return s; };

const library = $('#library'), reader = $('#reader'), pager = $('#pager'), flow = $('#flow');

/* ===================== настройки ===================== */

const DEF = { fs: 1.15, font: 'serif', lh: '1.55', margin: 'm', justify: '1', theme: 'auto', bright: 100, warm: 0, light: 'milk', dark: 'night' };
const S = { ...DEF, ...safeJSON(lsGet('settings')) };
const saveSettings = () => lsSet('settings', JSON.stringify(S));
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const DARK = new Set(['night', 'black']);
const effTheme = () => (S.theme === 'auto' ? (darkMQ.matches ? S.dark : S.light) : S.theme);

function applyTheme() {
  const t = effTheme();
  document.documentElement.dataset.theme = t;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  $('meta[name="theme-color"]')?.setAttribute('content', bg);
  const dark = DARK.has(t);
  for (const b of $$('.theme-btn')) {
    b.setAttribute('aria-pressed', String(dark));
    b.setAttribute('aria-label', dark ? 'Светлая тема' : 'Тёмная тема');
    b.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  }
}
darkMQ.addEventListener('change', () => { if (S.theme === 'auto') applyTheme(); });

// яркость и тёплый свет: на iPhone сайт не может менять подсветку экрана, поэтому мягко затемняем сам экран
function applyLight() {
  const root = document.documentElement.style;
  root.setProperty('--dim', ((100 - S.bright) / 100 * 0.82).toFixed(3));
  root.setProperty('--warm', (S.warm / 100 * 0.34).toFixed(3));
}

// тёмная тема одной кнопкой: круг расходится от пальца
function toggleDark(btn) {
  const goDark = !DARK.has(effTheme());
  const apply = () => { S.theme = goDark ? S.dark : S.light; saveSettings(); applyTheme(); syncSettingsUI(); };
  $$('.theme-btn').forEach(b => { b.classList.add('spin'); setTimeout(() => b.classList.remove('spin'), 500); });
  if (!document.startViewTransition || !motionOK() || document.visibilityState !== 'visible') { apply(); return; }
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const rad = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.documentElement.classList.add('theme-vt');
  const vt = document.startViewTransition(apply);
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${rad}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(.22,.8,.24,1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
  vt.finished.catch(() => {}).finally(() => document.documentElement.classList.remove('theme-vt'));
  setTimeout(() => { try { vt.skipTransition(); } catch { /* уже */ } }, 1500);
}
document.addEventListener('click', e => { const b = e.target.closest('.theme-btn'); if (b) toggleDark(b); });

function applyReaderStyle() {
  reader.style.setProperty('--fs', S.fs + 'rem');
  reader.style.setProperty('--lh', S.lh);
  reader.style.setProperty('--rfont', S.font === 'sans' ? 'var(--sans)' : S.font === 'round' ? 'var(--ui)' : 'var(--serif)');
  reader.classList.toggle('justify', S.justify === '1');
}

function syncSettingsUI() {
  for (const box of $$('[data-set]')) {
    const key = box.dataset.set;
    for (const b of $$('button[data-v]', box)) b.setAttribute('aria-pressed', String(b.dataset.v === String(S[key])));
  }
  const fsPct = Math.round(S.fs / DEF.fs * 100);
  setRange('#fs', fsPct, fsPct + '%', '#fs-val');
  setRange('#bright', S.bright, S.bright + '%', '#bright-val');
  setRange('#warm', S.warm, S.warm ? S.warm + '%' : 'выкл', '#warm-val');
}
function setRange(sel, v, label, out) {
  const r = $(sel);
  if (!r) return;
  r.value = v;
  r.style.setProperty('--v', (v - r.min) / (r.max - r.min));
  $(out).value = label;
}

// пересчёт страниц не чаще раза в 120 мс, пока тянут ползунок
let relayoutT = null;
function relayoutSoon() {
  if (relayoutT) return;
  relayoutT = setTimeout(() => { relayoutT = null; relayout(); }, 120);
}
function setFsPct(p) {
  p = Math.max(70, Math.min(200, Math.round(p / 5) * 5));
  S.fs = Math.round(DEF.fs * p / 100 * 1000) / 1000;
  saveSettings(); syncSettingsUI(); applyReaderStyle(); relayoutSoon();
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-set] button[data-v]');
  if (b) {
    const key = b.closest('[data-set]').dataset.set;
    S[key] = b.dataset.v;
    if (key === 'theme' && DARK.has(b.dataset.v)) S.dark = b.dataset.v;
    if (key === 'theme' && ['milk', 'caramel'].includes(b.dataset.v)) S.light = b.dataset.v;
    saveSettings(); syncSettingsUI();
    if (key === 'theme') applyTheme(); else { applyReaderStyle(); relayout(); }
    return;
  }
  const f = e.target.closest('[data-fs]');
  if (f) setFsPct(Math.round(S.fs / DEF.fs * 100) + Number(f.dataset.fs) * 5);
});
$('#fs').addEventListener('input', e => setFsPct(+e.target.value));
$('#bright').addEventListener('input', e => { S.bright = +e.target.value; saveSettings(); syncSettingsUI(); applyLight(); });
$('#warm').addEventListener('input', e => { S.warm = +e.target.value; saveSettings(); syncSettingsUI(); applyLight(); });

/* ===================== тосты и листы ===================== */

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch { /* без popover */ }
  clearTimeout(toastT);
  toastT = setTimeout(() => { try { t.hidePopover(); } catch { /* ничего */ } }, 2800);
}

// Листы закрываются тремя способами, и ни один не зависит от поддержки браузером:
// крестик в шапке, тап мимо листа, свайп вниз за шапку.
function setupSheet(d) {
  // содержимое — в карточку; сам dialog растянут на весь экран и прозрачен
  const panel = document.createElement('div');
  panel.className = 'sheet-panel';
  panel.append(...d.childNodes);
  d.append(panel);

  d.addEventListener('click', e => { if (e.target.closest?.('[data-close]')) d.close(); });
  if (d.getAttribute('closedby') !== 'any') return;

  // тап мимо карточки: он попадает в сам dialog — обычный элемент, iPhone его точно доставит
  let downOnLayer = false;
  d.addEventListener('pointerdown', e => { downOnLayer = e.target === d; });
  d.addEventListener('pointerup', e => {
    if (downOnLayer && e.target === d) d.close();
    downOnLayer = false;
  });
  d.addEventListener('click', e => { if (e.target === d && d.open) d.close(); });

  // свайп вниз за шапку (у шапки touch-action: none, поэтому прокрутка его не перехватывает)
  const head = d.querySelector('.sheet-head');
  if (!head) return;
  let y0 = null, dy = 0, t0 = 0;
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    y0 = e.clientY; dy = 0; t0 = performance.now();
    d.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch { /* ничего */ }
  });
  head.addEventListener('pointermove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    panel.style.translate = `0 ${dy}px`;
  });
  const end = () => {
    if (y0 == null) return;
    const fast = dy / Math.max(1, performance.now() - t0) > 0.5;
    y0 = null;
    d.classList.remove('dragging');
    panel.style.translate = '';
    if (dy > 60 || (fast && dy > 20)) d.close();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  head.addEventListener('lostpointercapture', end);
}
$$('dialog.sheet').forEach(setupSheet);

function confirmDlg(title, text, yes = 'Убрать') {
  return new Promise(res => {
    const d = $('#dlg-confirm');
    $('#cf-title').textContent = title;
    $('#cf-text').textContent = text;
    $('#cf-yes').textContent = yes;
    d.returnValue = '';
    d.addEventListener('close', () => { res(d.returnValue === 'yes'); d.returnValue = ''; }, { once: true });
    d.showModal();
  });
}

/* ===================== прогресс ===================== */

let progMap = new Map();
function bestProg(id, idbRec) {
  const l = safeJSON(lsGet('p:' + id));
  if (l.ts && (!idbRec || l.ts > idbRec.ts)) return l;
  return idbRec || null;
}

/* ===================== полка ===================== */

let books = [];
let firstRender = true;
const coverURLs = new Map();

async function coverURL(id) {
  if (coverURLs.has(id)) return coverURLs.get(id);
  const r = await DB.get('res', [id, '__cover']).catch(() => null);
  const u = r ? URL.createObjectURL(new Blob([r.data], { type: r.type })) : null;
  coverURLs.set(id, u);
  return u;
}
const hue = id => (parseInt(id.slice(1, 6), 16) || 0) % 360;

function genCover(b) {
  const g = el('div', 'gen-cover');
  g.append(el('b', '', b.title), el('span', '', b.author || ''), icon('cat-face'));
  return g;
}
function coverEl(b, pct) {
  const c = el('div', 'cover');
  c.style.setProperty('--h', hue(b.id));
  const inner = el('div', 'cover-in');
  if (b.hasCover) {
    const img = new Image();
    img.alt = '';
    inner.append(img);
    // обложка уже загружалась — ставим сразу, без пустого кадра (иначе после выхода из книги обложки мигали)
    const known = coverURLs.get(b.id);
    if (known) img.src = known;
    else coverURL(b.id).then(u => { if (u) img.src = u; else img.replaceWith(genCover(b)); });
  } else inner.append(genCover(b));
  c.append(inner);
  if (pct >= 0.995) c.append(el('span', 'done', 'Прочитано'));
  return c;
}
function meter(pct) {
  const m = el('span', 'meter');
  m.style.setProperty('--p', pct.toFixed(4));
  m.append(el('span'), icon('i-paw'));
  return m;
}
const pctText = p => (p >= 0.995 ? 100 : Math.floor(p * 100)) + '%';
function ring(pct) {
  const r = el('span', 'ring' + (pct < 0.005 ? ' zero' : ''));
  r.style.setProperty('--p', pct.toFixed(4));
  r.innerHTML = '<svg viewBox="0 0 46 46" aria-hidden="true"><circle class="bg" cx="23" cy="23" r="19" pathLength="100"/><circle class="fg" cx="23" cy="23" r="19" pathLength="100"/></svg>';
  r.append(el('span', '', pctText(pct)));
  return r;
}
const normKey = (t, a) => ((t || '') + '|' + (a || '')).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}|]+/gu, '');
const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

function cardEl(b, i, isNew) {
  const pct = progMap.get(b.id)?.pct ?? 0;
  const li = el('li', 'card' + (isNew ? ' new' : ''));
  li.dataset.id = b.id;
  li.style.setProperty('--i', Math.min(i, 12));
  const open = el('button', 'card-open');
  open.type = 'button';
  open.dataset.open = b.id;
  const prog = el('span', 'card-prog');
  prog.append(meter(pct), el('span', '', pctText(pct)));
  open.append(coverEl(b, pct), el('span', 'card-title', b.title), el('span', 'card-author', b.author || b.format), prog);
  const more = el('button', 'icon-btn card-more');
  more.type = 'button';
  more.dataset.more = b.id;
  more.setAttribute('aria-label', `Действия: ${b.title}`);
  more.append(icon('i-more'));
  li.append(open, more);
  return li;
}

async function renderLibrary({ added = [] } = {}) {
  books = await DB.getAll('books');
  const progs = await DB.getAll('progress');
  progMap = new Map(progs.map(p => [p.id, p]));
  for (const b of books) { const best = bestProg(b.id, progMap.get(b.id)); if (best) progMap.set(b.id, best); }
  books.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));

  const hero = $('#hero');
  const cur = books.find(b => b.openedAt && (progMap.get(b.id)?.pct ?? 0) < 0.995);
  hero.replaceChildren();
  if (cur) {
    const p = progMap.get(cur.id);
    const pct = p?.pct ?? 0;
    const btn = el('button', 'hero');
    btn.type = 'button';
    btn.dataset.open = cur.id;
    const body = el('span', 'hero-body');
    const metaRow = el('span', 'hero-meta');
    metaRow.append(ring(pct), el('span', '', 'читала ' + ago(p?.ts || cur.openedAt)));
    body.append(el('span', 'hero-kicker', 'Читаю сейчас'), el('span', 'hero-title', cur.title), el('span', 'hero-author', cur.author || ''), metaRow, el('span', 'btn', 'Продолжить'));
    const grid = el('span', 'hero-grid');
    grid.append(coverEl(cur, pct), body);
    btn.append(grid);
    hero.append(btn);
  }
  hero.hidden = !cur;

  const grid = $('#grid');
  const addedIds = new Set(added);
  grid.replaceChildren(...books.map((b, i) => cardEl(b, i, addedIds.has(b.id))));
  if (!firstRender) grid.classList.add('calm');
  firstRender = false;
  $('#count').textContent = books.length ? String(books.length) : '';
  $('#empty').hidden = books.length > 0;
  $('#how-add').hidden = books.length === 0;
  maybeBackupHint();
}

function maybeBackupHint() {
  const now = Date.now();
  if (!lsGet('first-use')) lsSet('first-use', String(now));
  const since = +lsGet('backup-at') || +lsGet('first-use') || now, snooze = +lsGet('backup-snooze') || 0;
  const reading = [...progMap.values()].some(p => (p.pct || 0) > 0.01);
  // раз в две недели мягко напоминаем (первый раз — через неделю пользования)
  const gap = lsGet('backup-at') ? 14 : 7;
  $('#backup-hint').hidden = !(books.length && reading && now - since > gap * 864e5 && now > snooze);
}
$('#backup-hint-close').addEventListener('click', () => { lsSet('backup-snooze', String(Date.now() + 7 * 864e5)); $('#backup-hint').hidden = true; });
$('#backup-hint-save').addEventListener('click', () => doBackup());

function celebrate() {
  const m = $('.mascot');
  m.classList.remove('happy', 'sad');
  void m.getBoundingClientRect();
  m.classList.add('happy');
  setTimeout(() => m.classList.remove('happy'), 1200);
}
function sadCat() {
  const m = $('.mascot');
  m.classList.remove('happy', 'sad');
  void m.getBoundingClientRect();
  m.classList.add('sad');
  setTimeout(() => m.classList.remove('sad'), 1300);
}

library.addEventListener('click', e => {
  const o = e.target.closest('[data-open]');
  if (o) { openBook(o.dataset.open, o); return; }
  const m = e.target.closest('[data-more]');
  if (m) bookSheet(m.dataset.more, m.closest('.card'));
});

let sheetBook = null;
function bookSheet(id, card) {
  const b = books.find(x => x.id === id);
  if (!b) return;
  sheetBook = { id, card };
  const p = progMap.get(id);
  $('#bk-title').textContent = b.title;
  const kb = b.size ? (b.size > 1048576 ? (b.size / 1048576).toFixed(1) + ' МБ' : Math.round(b.size / 1024) + ' КБ') : '';
  $('#bk-info').textContent = [b.author, b.format, kb, p ? 'прочитано ' + pctText(p.pct) : 'ещё не открывала'].filter(Boolean).join(' · ');
  $('#dlg-book').showModal();
}
$('#bk-read').addEventListener('click', () => {
  $('#dlg-book').close();
  if (sheetBook) openBook(sheetBook.id, sheetBook.card);
});
$('#bk-del').addEventListener('click', async () => {
  $('#dlg-book').close();
  const b = books.find(x => x.id === sheetBook?.id);
  if (!b) return;
  const ok = await confirmDlg(`Убрать «${b.title}» с полки?`, 'Файл книжки удалится из Мурчалки. Страница и закладки запомнятся: если добавишь эту книжку снова, откроется там же, где остановилась.');
  if (!ok) return;
  await DB.deleteBook(b.id);
  const u = coverURLs.get(b.id); if (u) URL.revokeObjectURL(u); coverURLs.delete(b.id);
  sadCat();
  await withTransition(() => renderLibrary());
  toast('Книжка убрана с полки');
});

// View Transition с предохранителем: если кадр так и не отрисовался (приложение свернули),
// обновляем экран без анимации, чтобы ничего не зависло.
async function runVT(update) {
  if (!document.startViewTransition || !motionOK() || document.visibilityState !== 'visible') { await update(); return null; }
  let ran = false;
  const once = async () => { if (ran) return; ran = true; await update(); };
  const vt = document.startViewTransition(once);
  vt.ready.catch(() => {});
  vt.finished.catch(() => {});
  const guard = sleep(900).then(async () => { if (!ran) { try { vt.skipTransition(); } catch { /* уже */ } await once(); } });
  await Promise.race([vt.updateCallbackDone.catch(() => {}), guard]);
  return vt;
}

// Полка обновляется сразу; новые карточки сами въезжают CSS-анимацией (.card.new).
// View Transitions для сетки не используем: на iPhone они иногда мигают.
async function withTransition(update) {
  await update();
}

/* ===================== добавление книжек ===================== */

// первый раз показываем, где искать скачанные книги; дальше кнопка сразу открывает «Файлы»
$('#add-btn').addEventListener('click', () => {
  if (!lsGet('add-help-seen')) { lsSet('add-help-seen', '1'); $('#dlg-add').showModal(); }
  else $('#file').click();
});
$('#how-add').addEventListener('click', () => $('#dlg-add').showModal());
$('#add-pick').addEventListener('click', () => { $('#dlg-add').close(); $('#file').click(); });
$('#file').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });
addEventListener('dragover', e => { if (!R.open) e.preventDefault(); });
addEventListener('drop', e => {
  if (R.open) return;
  e.preventDefault();
  importFiles([...(e.dataTransfer?.files || [])]);
});

let importing = false;
async function importFiles(files) {
  if (!files.length || importing) return;
  importing = true;
  const box = $('#importing');
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest', behavior: motionOK() ? 'smooth' : 'auto' });
  const added = [];
  for (const [i, f] of files.entries()) {
    $('#imp-title').textContent = files.length > 1 ? `Кот читает книжку ${i + 1} из ${files.length}…` : 'Кот читает книжку…';
    $('#imp-step').textContent = f.name;
    try {
      await sleep(60);
      const parsed = await parseBook(f, s => { $('#imp-step').textContent = s + '…'; });
      if (await DB.get('books', parsed.meta.id)) { toast(`«${parsed.meta.title}» уже на полке`); continue; }
      await DB.saveBook(parsed);
      added.push(parsed.meta);
      if (await adoptProgress(parsed.meta)) parsed.meta.adopted = true;
    } catch (err) {
      console.warn(err);
      toast(err instanceof BookError ? err.message : `Не получилось открыть «${f.name}» 😿`);
      await sleep(1200);
    }
  }
  box.hidden = true;
  importing = false;
  if (added.length) {
    persistStorage();
    await withTransition(() => renderLibrary({ added: added.map(a => a.id) }));
    celebrate();
    const back = added.filter(a => a.adopted || progMap.has(a.id));
    toast(back.length === 1 && added.length === 1 ? `«${added[0].title}» снова на полке — место, где остановилась, сохранилось 🐾`
      : added.length === 1 ? `«${added[0].title}» теперь на полке!` : `Новых книжек на полке: ${added.length}`);
  }
}

// та же книга, но другим файлом (другое издание, другой сайт): берём сохранённое место по названию и автору,
// а точную страницу потом найдём по кусочку текста
async function adoptProgress(meta) {
  if (await DB.get('progress', meta.id) || lsGet('p:' + meta.id)) return false;
  const key = normKey(meta.title, meta.author);
  const shelf = new Set((await DB.getAll('books')).map(b => b.id));
  const cand = (await DB.getAll('progress'))
    .filter(p => p.id !== meta.id && !shelf.has(p.id) && (p.key || normKey(p.title, p.author)) === key)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!cand) return false;
  const rec = { ...cand, id: meta.id, relocate: true, sig: null, page: null, ts: Date.now() };
  await DB.put('progress', rec);
  lsSet('p:' + meta.id, JSON.stringify(rec));
  return true;
}

async function persistStorage() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ничего */ }
}

/* ===================== настройки приложения и копия ===================== */

$('#app-settings-btn').addEventListener('click', async () => {
  syncSettingsUI();
  $('#dlg-app').showModal();
  let info = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) info += `Книжки занимают ${(est.usage / 1048576).toFixed(1)} МБ. `;
    const p = await navigator.storage?.persisted?.();
    info += p ? 'Хранилище закреплено — телефон его не почистит.' : 'Поставь Мурчалку на экран «Домой», чтобы хранилище было понадёжнее.';
  } catch { /* ничего */ }
  $('#storage-info').textContent = info;
});

$('#backup-save').addEventListener('click', () => doBackup());
async function doBackup() {
  lsSet('backup-at', String(Date.now()));
  $('#backup-hint').hidden = true;
  const list = await DB.getAll('progress');
  const map = new Map(list.map(p => [p.id, p]));
  for (const b of books) { const best = bestProg(b.id, map.get(b.id)); if (best) map.set(b.id, best); }
  const data = { app: 'murchalka', v: 1, ts: Date.now(), progress: [...map.values()] };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const name = `murchalka-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Мурчалка — копия прогресса' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#backup-load').addEventListener('click', () => $('#backup-file').click());
$('#backup-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'murchalka' || !Array.isArray(data.progress)) throw new Error('bad');
    let n = 0;
    for (const rec of data.progress) {
      if (!rec?.id || typeof rec.ts !== 'number') continue;
      const cur = bestProg(rec.id, await DB.get('progress', rec.id));
      if (!cur || rec.ts > cur.ts) { await DB.put('progress', rec); lsSet('p:' + rec.id, JSON.stringify(rec)); n++; }
    }
    await renderLibrary();
    toast(n ? `Восстановлено книжек: ${n}` : 'Всё и так на месте');
  } catch { toast('Это не копия Мурчалки 😿'); }
});

/* подсказка про экран «Домой» */
{
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !lsGet('hint-hidden')) $('#install-hint').hidden = false;
  $('#install-hint-close').addEventListener('click', () => { $('#install-hint').hidden = true; lsSet('hint-hidden', '1'); });
}

/* ===================== ЧИТАЛКА ===================== */
/*
  Место в книге хранится не номером страницы, а как «глава + номер символа» (плюс кусочек текста для сверки).
  Поэтому смена шрифта, поворот телефона или перезапуск никогда не сбивают позицию.
  Сохраняем на каждой перевёрнутой странице: сразу в localStorage и через миг в IndexedDB.
*/

const R = {
  open: false, busy: false, book: null, chStarts: [],
  ch: 0, off: 0, page: 0, pages: 1, S: 0, m: 0,
  nodes: [], starts: [], total: 0, text: null, urls: [], marks: [], back: null, src: null,
};
const rng = document.createRange();

function marginPx(w) {
  const f = { s: 0.045, m: 0.07, l: 0.11 }[S.margin] ?? 0.07;
  return Math.round(Math.max(12, Math.min(72, w * f)));
}

function layout() {
  const W0 = pager.clientWidth, H = pager.clientHeight;
  const m = marginPx(W0);
  R.S = W0; R.m = m;
  const W = W0 - 2 * m;
  Object.assign(flow.style, { left: m + 'px', width: W + 'px', height: H + 'px', columnWidth: W + 'px', columnGap: 2 * m + 'px' });
  flow.style.setProperty('--page-h', H + 'px');
  R.pages = countPages();
  // невидимый ограничитель: прокрутка должна доставать до самого конца последней страницы
  let end = pager.querySelector('.pager-end');
  if (!end) { end = document.createElement('div'); end.className = 'pager-end'; end.setAttribute('aria-hidden', 'true'); pager.append(end); }
  end.style.cssText = `position:absolute;top:0;width:1px;height:1px;left:${R.pages * W0 - 1}px;pointer-events:none`;
}

function buildIndex() {
  const w = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
  const nodes = [], starts = [];
  let t = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push(n); starts.push(t); t += n.length; }
  R.nodes = nodes; R.starts = starts; R.total = t; R.text = null;
}
const chapterText = () => (R.text ??= R.nodes.map(n => n.data).join(''));
const textAt = (off, n) => chapterText().slice(off, off + n);

function nodeAt(off) {
  let lo = 0, hi = R.starts.length - 1, ans = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (R.starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
function charRect(n, i) {
  rng.setStart(n, i); rng.setEnd(n, i + 1);
  const rs = rng.getClientRects();
  for (const r of rs) if (r.width || r.height) return r;
  return null;
}
// прямоугольник первого видимого символа начиная с off
function rectAt(off) {
  if (!R.nodes.length) return null;
  let k = nodeAt(Math.max(0, off)), i = Math.max(0, off - R.starts[k]), guard = 0;
  for (; k < R.nodes.length; k++, i = 0) {
    const n = R.nodes[k];
    for (; i < n.length; i++) {
      const r = charRect(n, i);
      if (r) return r;
      if (++guard > 3000) return null;
    }
  }
  return null;
}
function pageOfRect(r) {
  const fl = flow.getBoundingClientRect().left;
  return Math.max(0, Math.floor((r.left + 1 - fl + R.m) / R.S));
}
function pageOfOff(off) {
  if (!R.nodes.length) return 0;
  const r = rectAt(off);
  return r ? Math.min(pageOfRect(r), R.pages - 1) : R.pages - 1;
}
function pageStart(p) {
  if (p <= 0) return 0;
  let lo = 0, hi = R.total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rectAt(mid);
    if ((r ? pageOfRect(r) : Infinity) >= p) hi = mid; else lo = mid + 1;
  }
  return lo;
}
function countPages() {
  let p = 0;
  outer: for (let k = R.nodes.length - 1; k >= 0; k--) {
    const n = R.nodes[k];
    for (let i = n.length - 1; i >= Math.max(0, n.length - 300); i--) {
      const r = charRect(n, i);
      if (r) { p = pageOfRect(r); break outer; }
    }
  }
  for (const img of flow.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    if (r.width) p = Math.max(p, pageOfRect(r));
  }
  return p + 1;
}
function offsetOfEl(e) {
  const N = R.nodes;
  let lo = 0, hi = N.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (e.compareDocumentPosition(N[mid]) & Node.DOCUMENT_POSITION_FOLLOWING) hi = mid; else lo = mid + 1; }
  return lo < N.length ? R.starts[lo] : R.total;
}

async function loadChapter(ch) {
  const html = await DB.get('chapters', [R.book.id, ch]);
  R.urls.forEach(u => URL.revokeObjectURL(u));
  R.urls = [];
  flow.innerHTML = html ?? '<p class="c">Эта глава потерялась 😿</p>';
  flow.lang = R.book.lang || 'ru';
  await Promise.all($$('img[data-res]', flow).map(async img => {
    const r = await DB.get('res', [R.book.id, img.dataset.res]).catch(() => null);
    if (!r) { img.remove(); return; }
    const u = URL.createObjectURL(new Blob([r.data], { type: r.type }));
    R.urls.push(u);
    img.src = u;
    try { await img.decode(); } catch { /* битая картинка */ }
  }));
  R.ch = ch;
  buildIndex();
  layout();
}

// Страницы листаются прокруткой контейнера, а не сдвигом всей главы (transform).
// Глава — полоса в десятки экранов; iPhone дорисовывает такой слой кусками, и текст мигал.
// Прокручиваемый контейнер он рисует плиткой, без мигания.
let scrollAnim = 0;
function scrollToX(x, anim) {
  cancelAnimationFrame(scrollAnim);
  if (!anim || !motionOK()) { pager.scrollLeft = x; return; }
  const x0 = pager.scrollLeft, dx = x - x0, t0 = performance.now(), D = 340;
  if (Math.abs(dx) < 1) { pager.scrollLeft = x; return; }
  const ease = t => 1 - Math.pow(1 - t, 3);
  const step = now => {
    const t = Math.min(1, (now - t0) / D);
    pager.scrollLeft = x0 + dx * ease(t);
    if (t < 1) scrollAnim = requestAnimationFrame(step);
  };
  scrollAnim = requestAnimationFrame(step);
}
function showPage(p, anim = false) {
  R.page = Math.max(0, Math.min(p, R.pages - 1));
  scrollToX(R.page * R.S, anim);
  updateInfo();
}
function turnTo(p) {
  p = Math.max(0, Math.min(p, R.pages - 1));
  const dir = p > R.page ? 1 : -1;
  R.off = pageStart(p);
  showPage(p, true);
  sweep(dir);
  save();
  updateMarkUI();
  countBack();
}

// мягкая тень пробегает по странице при перелистывании — ощущение настоящей бумаги
function sweep(dir) {
  if (!motionOK()) return;
  const sh = $('#shade'), W = pager.clientWidth, w = W * 0.34;
  sh.style.opacity = ''; sh.style.transform = '';
  const from = dir > 0 ? W : -w, to = dir > 0 ? -w : W;
  sh.animate([
    { transform: `translateX(${from}px)`, opacity: 0 },
    { opacity: 1, offset: 0.3 },
    { transform: `translateX(${to}px)`, opacity: 0 },
  ], { duration: 440, easing: 'cubic-bezier(.3,.6,.3,1)' });
}
// след лапки там, где коснулась
function pawAt(x, y) {
  if (!motionOK()) return;
  const s = icon('i-paw', 'tap-paw');
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  s.style.rotate = (Math.random() * 40 - 20).toFixed(0) + 'deg';
  reader.append(s); // не внутрь прокручиваемого pager, иначе лапка уедет вместе со страницей
  const a = s.animate([{ opacity: 0, scale: 0.4 }, { opacity: 0.32, scale: 1, offset: 0.3 }, { opacity: 0, scale: 1.15 }], { duration: 520, easing: 'ease-out' });
  const rm = () => s.remove();
  a.finished.then(rm, rm);
  setTimeout(rm, 900);
}

// «Вернуться, где читала»: после любого прыжка по книге (ползунок, оглавление, закладка, ссылка)
function rememberSpot() {
  if (!R.book) return;
  if (!R.back) R.back = { ch: R.ch, off: R.off };
  R.backTurns = 0;
  $('#r-backlink').hidden = false;
}
function countBack() {
  if (!R.back) return;
  if (++R.backTurns > 6) { R.back = null; $('#r-backlink').hidden = true; }
}

/* --- сохранение --- */

const sig = () => [R.S, pager.clientHeight, S.fs, S.font, S.lh, S.margin, S.justify].join('|');
function currentPct() {
  const b = R.book;
  if (!b) return 0;
  if (R.ch === b.chapterLens.length - 1 && R.page === R.pages - 1) return 1;
  return Math.min(1, (R.chStarts[R.ch] + R.off) / b.totalLen);
}
let saveT = null, pending = null;
function save() {
  if (!R.book) return;
  const rec = {
    id: R.book.id, title: R.book.title, author: R.book.author || '', key: normKey(R.book.title, R.book.author),
    ch: R.ch, off: R.off, page: R.page, sig: sig(),
    pct: currentPct(), ts: Date.now(), snippet: textAt(R.off, 60), marks: R.marks,
  };
  lsSet('p:' + rec.id, JSON.stringify(rec)); // мгновенно и синхронно — переживёт даже внезапное закрытие
  progMap.set(rec.id, rec);
  pending = rec;
  clearTimeout(saveT);
  saveT = setTimeout(flushSave, 300);
}
function flushSave() {
  clearTimeout(saveT);
  if (!pending) return;
  const r = pending; pending = null;
  DB.put('progress', r).catch(e => console.warn('progress', e));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
addEventListener('pagehide', flushSave);
document.addEventListener('freeze', flushSave);

// найти место по кусочку текста во всей книге (другой файл той же книги или изменившаяся разбивка)
async function findSnippet(snippet, skipCh) {
  const probes = [snippet, snippet.trim().slice(10, 40)].filter(s => s && s.trim().length >= 12);
  const t = document.createElement('template');
  for (const probe of probes) {
    for (let i = 0; i < R.book.chapterLens.length; i++) {
      if (i === skipCh) continue;
      t.innerHTML = (await DB.get('chapters', [R.book.id, i])) || '';
      const k = t.content.textContent.indexOf(probe);
      if (k >= 0) return { ch: i, off: k };
    }
  }
  return null;
}

/* --- открыть / закрыть --- */

async function openBook(id, src, { instant = false } = {}) {
  if (R.open || R.busy || R.closing) return;
  R.busy = true; // сразу: второй быстрый тап по «Продолжить» не запустит второе открытие
  R.wantClose = false;
  const book = await DB.get('books', id).catch(() => null);
  if (!book) { R.busy = false; return; }
  try {
    R.book = book;
    R.chStarts = book.chapterLens.reduce((a, l, i) => (a.push(i ? a[i - 1] + book.chapterLens[i - 1] : 0), a), []);
    const prog = bestProg(id, await DB.get('progress', id));
    R.marks = Array.isArray(prog?.marks) ? prog.marks : [];
    R.back = null;
    $('#r-backlink').hidden = true;
    $('#r-book-title').textContent = book.title;
    $('#r-book-author').textContent = book.author || '';
    applyReaderStyle();
    reader.classList.remove('chrome');
    reader.classList.add('preparing');
    reader.hidden = false;
    R.open = true;
    await document.fonts?.ready;
    let ch = Math.max(0, Math.min(prog?.ch ?? 0, book.chapterLens.length - 1));
    await loadChapter(ch);
    let off = Math.max(0, prog?.off ?? 0);
    // сверяем место по кусочку текста: если не совпало — ищем в главе, потом во всей книге
    if (prog?.snippet && textAt(off, prog.snippet.length) !== prog.snippet) {
      const i = chapterText().indexOf(prog.snippet);
      if (i >= 0) off = i;
      else {
        const f = await findSnippet(prog.snippet, ch);
        if (f) { ch = f.ch; off = f.off; await loadChapter(ch); }
      }
    }
    if (prog?.relocate && R.marks.length) {
      for (const m of R.marks) {
        if (!m.snippet) continue;
        const f = await findSnippet(m.snippet.slice(0, 60), -1);
        if (f) { m.ch = f.ch; m.off = f.off; }
      }
    }
    R.off = Math.min(off, Math.max(0, R.total - 1));
    const byOff = pageOfOff(R.off);
    const page = prog && prog.sig === sig() && prog.ch === ch && Math.abs((prog.page ?? -9) - byOff) <= 1 ? prog.page : byOff;
    showPage(page);
    updateMarkUI();

    book.openedAt = Date.now();
    DB.put('books', book).catch(() => {});
    lsSet('view', 'reader:' + id);
    if (history.state?.reader !== id) history.pushState({ reader: id }, '');
    save();

    R.src = src?.classList?.contains('hero') ? 'hero' : 'card';
    // Книга выезжает снизу сплошным листом: без прозрачности (полка не просвечивает) — ничего не мелькает.
    reader.getAnimations().forEach(a => a.cancel()); // хвосты прошлого закрытия не должны держать лист внизу
    reader.classList.remove('preparing');
    if (!instant && motionOK()) {
      reader.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
        { duration: 420, easing: 'cubic-bezier(.2,.85,.25,1)' });
    }
    library.inert = true;
    pager.focus({ preventScroll: true });
    maybeTips();
  } catch (e) {
    console.error(e);
    toast('Книжка не открылась 😿');
    reader.hidden = true;
    reader.classList.remove('preparing');
    library.inert = false;
    lsSet('view', 'library');
    R.open = false;
  } finally {
    R.busy = false;
    if (R.wantClose) { R.wantClose = false; closeReader(); }
  }
}

async function closeReader() {
  if (!R.open || R.closing) return;
  // книга ещё открывается — закроем сразу, как только откроется (иначе полка может остаться «замороженной»)
  if (R.busy) { R.wantClose = true; return; }
  R.closing = true;
  save(); flushSave();
  lsSet('view', 'library');
  const id = R.book.id;
  await renderLibrary();
  const inView = e => { if (!e) return false; const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const heroCover = $('#hero .hero')?.dataset.open === id ? $('#hero .cover') : null;
  const cardCover = $(`#grid .card[data-id="${id}"] .cover`);
  const cover = (R.src === 'hero' && inView(heroCover)) ? heroCover : inView(cardCover) ? cardCover : inView(heroCover) ? heroCover : null;
  const finish = () => {
    reader.hidden = true;
    reader.classList.remove('chrome');
    library.inert = false;
    flow.innerHTML = '';
    R.urls.forEach(u => URL.revokeObjectURL(u));
    R.urls = []; R.nodes = []; R.open = false; R.book = null; R.closing = false;
    $('#r-backlink').hidden = true;
  };
  // книга уезжает вниз сплошным листом, открывая уже обновлённую полку
  if (motionOK()) {
    const out = reader.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
      { duration: 300, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    await animDone(out, 400);
    finish();
    out.cancel();
    reader.getAnimations().forEach(a => a.cancel());
  } else finish();
  cover?.closest('button')?.focus({ preventScroll: true });
}
$('#r-close').addEventListener('click', () => { if (history.state?.reader) history.back(); else closeReader(); });
addEventListener('popstate', () => {
  for (const d of $$('dialog[open]')) d.close();
  if (R.open) closeReader();
});

/* --- листание --- */

async function next() {
  if (R.busy || !R.book) return;
  if (R.page < R.pages - 1) return turnTo(R.page + 1);
  if (R.ch < R.book.chapterLens.length - 1) return changeChapter(R.ch + 1, 'start', 1);
  showPage(R.page, true);
  toast('Книжка дочитана! Котик тобой гордится 🐾');
  save();
}
async function prev() {
  if (R.busy || !R.book) return;
  if (R.page > 0) return turnTo(R.page - 1);
  if (R.ch > 0) return changeChapter(R.ch - 1, 'end', -1);
  showPage(0, true);
  toast('Это самое начало книжки');
}

// анимация никогда не держит листание: если её заморозили (телефон свернули), идём дальше по таймеру
function animDone(a, ms) {
  return Promise.race([a.finished.catch(() => {}), sleep(ms).then(() => { try { a.finish(); } catch { /* уже */ } })]);
}

// where: 'start' | 'end' | {off} | {gid}
async function changeChapter(ch, where, dir = 1) {
  if (R.busy) return;
  R.busy = true;
  try {
    const anim = motionOK();
    const out = anim ? pager.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-dir * 26}px 0` }], { duration: 150, easing: 'ease-in', fill: 'forwards' }) : null;
    await Promise.all([ch === R.ch ? null : loadChapter(ch), out && animDone(out, 400)]);
    let p;
    if (where === 'start') { R.off = 0; p = 0; }
    else if (where === 'end') { p = R.pages - 1; R.off = pageStart(p); }
    else {
      const e = where.gid ? document.getElementById(where.gid) : null;
      R.off = e ? offsetOfEl(e) : Math.max(0, Math.min(where.off ?? 0, R.total));
      p = pageOfOff(R.off);
    }
    showPage(p);
    save();
    updateMarkUI();
    if (anim) {
      out.cancel();
      const inA = pager.animate([{ opacity: 0, translate: `${dir * 26}px 0` }, { opacity: 1, translate: '0 0' }], { duration: 280, easing: 'cubic-bezier(.22,.8,.24,1)' });
      await animDone(inA, 500);
    }
  } finally {
    R.busy = false;
    if (R.wantClose) { R.wantClose = false; closeReader(); }
  }
}
function goTo(ch, off) {
  if (ch === R.ch) {
    R.off = Math.max(0, Math.min(off, R.total));
    showPage(pageOfOff(R.off), true);
    save(); updateMarkUI();
    return;
  }
  return changeChapter(ch, { off }, ch > R.ch ? 1 : -1);
}
function goToGid(gid) {
  const ch = R.book.ids[gid];
  if (ch == null) return;
  if (ch === R.ch) {
    const e = document.getElementById(gid);
    return goTo(ch, e ? offsetOfEl(e) : 0);
  }
  return changeChapter(ch, { gid }, ch > R.ch ? 1 : -1);
}
function relayout() {
  if (!R.open || !R.book || !R.nodes) return;
  layout();
  showPage(pageOfOff(R.off));
  updateMarkUI();
  save();
}
let resizeT;
new ResizeObserver(() => {
  if (!R.open) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (!R.busy) relayout(); }, 140);
}).observe(pager);

/* --- жесты --- */

let g = null;
pager.addEventListener('pointerdown', e => {
  // не игнорируем касание во время смены главы: тап по центру откроет меню, листание само подождёт
  if (e.button !== 0) return;
  g = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, drag: false, dx: 0 };
});
pager.addEventListener('pointermove', e => {
  if (!g || e.pointerId !== g.id || R.busy) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (!g.drag && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
    g.drag = true;
    try { pager.setPointerCapture(e.pointerId); } catch { /* ничего */ }
    cancelAnimationFrame(scrollAnim);
  }
  if (g.drag) {
    g.dx = dx;
    if (!motionOK()) return;
    const edge = (R.page === 0 && dx > 0 && R.ch === 0) || (R.page === R.pages - 1 && dx < 0 && R.ch === R.book.chapterLens.length - 1);
    const d = edge ? dx * 0.3 : dx;
    pager.scrollLeft = R.page * R.S - d; // страница едет за пальцем
    // тень следует за краем страницы под пальцем
    const sh = $('#shade'), W = pager.clientWidth, w = W * 0.34;
    const fold = d < 0 ? W + d : d;
    sh.style.transform = `translateX(${fold - w}px)`;
    sh.style.opacity = Math.min(1, Math.abs(d) / W * 2.4).toFixed(3);
  }
});
function dropShade() {
  const sh = $('#shade');
  if (!sh.style.opacity) return;
  const o = +sh.style.opacity;
  sh.style.opacity = '';
  if (motionOK() && o > 0) sh.animate([{ opacity: o, transform: sh.style.transform }, { opacity: 0, transform: sh.style.transform }], { duration: 220 });
}
pager.addEventListener('pointerup', e => {
  if (!g || e.pointerId !== g.id) return;
  const st = g; g = null;
  if (st.drag) {
    const v = st.dx / Math.max(1, performance.now() - st.t);
    const fling = Math.abs(st.dx) > R.S * 0.16 || Math.abs(v) > 0.35;
    const before = R.ch + ':' + R.page;
    dropShade();
    if (fling) { st.dx < 0 ? next() : prev(); }
    if (!R.busy && before === R.ch + ':' + R.page) showPage(R.page, true);
    return;
  }
  if (Math.abs(e.clientX - st.x) > 10 || Math.abs(e.clientY - st.y) > 10) return;
  if (!$('#r-tips').hidden) { hideTips(); return; }
  const a = e.target.closest?.('a');
  if (a) { handleLink(a); return; }
  if (reader.classList.contains('chrome')) { toggleChrome(false); return; }
  const r = pager.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  if (x < 0.3) { pawAt(e.clientX, e.clientY); prev(); }
  else if (x > 0.7) { pawAt(e.clientX, e.clientY); next(); }
  else toggleChrome(true);
});
pager.addEventListener('pointercancel', () => { if (g?.drag) { dropShade(); showPage(R.page, true); } g = null; });
reader.addEventListener('click', e => {
  if (e.target === reader) toggleChrome();
});
$('#r-tips').addEventListener('click', hideTips);

document.addEventListener('keydown', e => {
  if (!R.open || $('dialog[open]') || e.target.closest?.('input')) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); next(); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); prev(); }
  else if (e.key === 'Escape') toggleChrome(false);
});

function maybeTips() { if (!lsGet('tips-seen')) $('#r-tips').hidden = false; }
function hideTips() { $('#r-tips').hidden = true; lsSet('tips-seen', '1'); }

/* --- шапка, подвал, ползунок --- */

function toggleChrome(force) {
  const on = force ?? !reader.classList.contains('chrome');
  reader.classList.toggle('chrome', on);
  if (on) updateSlider();
}
function chapterTitle(ch) {
  // название главы верхнего уровня, в которой мы сейчас
  const toc = R.book?.toc || [];
  const top = Math.min(...toc.map(e => e.d || 1));
  let t = '';
  for (const e of toc) { if (e.ch > ch) break; if ((e.d || 1) === top || !t) t = e.t; }
  return t || R.book?.title || '';
}
function updateInfo() {
  if (!R.book) return;
  $('#r-page').textContent = `стр. ${R.page + 1} из ${R.pages}`;
  $('#r-pct').textContent = pctText(currentPct());
  $('#r-chapter').textContent = chapterTitle(R.ch);
  if (reader.classList.contains('chrome')) updateSlider();
}
function updateSlider() {
  const s = $('#r-slider');
  const pct = currentPct();
  s.value = Math.round(pct * 1000);
  s.style.setProperty('--v', pct);
  const left = R.pages - 1 - R.page;
  $('#r-where').textContent = `${chapterTitle(R.ch)} · ${left ? 'до конца главы ' + left + ' стр.' : 'последняя страница главы'}`;
  $('#r-prev-ch').disabled = R.ch === 0;
  $('#r-next-ch').disabled = R.ch >= R.book.chapterLens.length - 1;
}
function locate(pct) {
  const gOff = pct * R.book.totalLen;
  let ch = 0;
  while (ch < R.chStarts.length - 1 && R.chStarts[ch + 1] <= gOff) ch++;
  return { ch, off: Math.round(gOff - R.chStarts[ch]) };
}
$('#r-slider').addEventListener('input', e => {
  const pct = e.target.value / 1000;
  e.target.style.setProperty('--v', pct);
  const { ch } = locate(pct);
  $('#r-where').textContent = `${chapterTitle(ch)} · ${pctText(pct)}`;
});
$('#r-slider').addEventListener('change', e => {
  const { ch, off } = locate(e.target.value / 1000);
  if (Math.abs(R.chStarts[ch] + off - (R.chStarts[R.ch] + R.off)) > 200) rememberSpot();
  goTo(ch, off);
});
$('#r-prev-ch').addEventListener('click', () => { if (R.ch > 0 && !R.busy) { rememberSpot(); changeChapter(R.ch - 1, 'start', -1); } });
$('#r-next-ch').addEventListener('click', () => { if (R.ch < R.book.chapterLens.length - 1 && !R.busy) { rememberSpot(); changeChapter(R.ch + 1, 'start', 1); } });
$('#r-aa').addEventListener('click', () => { syncSettingsUI(); $('#dlg-aa').showModal(); });

/* --- закладки --- */

function pageMarks() {
  const ms = R.marks.filter(m => m.ch === R.ch);
  if (!ms.length) return [];
  const s = pageStart(R.page), e = R.page < R.pages - 1 ? pageStart(R.page + 1) : Infinity;
  return ms.filter(m => m.off >= s && m.off < e);
}
function updateMarkUI() {
  if (!R.book) return;
  const on = pageMarks().length > 0;
  $('#r-ribbon').hidden = !on;
  const b = $('#r-mark');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('use').setAttribute('href', on ? '#i-mark-on' : '#i-mark');
}
$('#r-mark').addEventListener('click', () => {
  const here = pageMarks();
  if (here.length) {
    R.marks = R.marks.filter(m => !here.includes(m));
    toast('Закладка убрана');
  } else {
    const off = pageStart(R.page);
    R.marks.push({ ch: R.ch, off, pct: currentPct(), snippet: textAt(off, 90).replace(/\s+/g, ' ').trim(), ts: Date.now() });
    toast('Лапка-закладка на месте');
  }
  save();
  updateMarkUI();
});

/* --- оглавление --- */

function setTab(marks) {
  $('#tab-toc').setAttribute('aria-pressed', String(!marks));
  $('#tab-marks').setAttribute('aria-pressed', String(marks));
  $('#toc-list').hidden = marks;
  $('#marks-list').hidden = !marks;
}
$('#tab-toc').addEventListener('click', () => setTab(false));
$('#tab-marks').addEventListener('click', () => setTab(true));

function renderMarks() {
  const list = $('#marks-list');
  list.replaceChildren();
  const ms = [...R.marks].sort((a, b) => a.ch - b.ch || a.off - b.off);
  $('#marks-count').textContent = ms.length ? `(${ms.length})` : '';
  if (!ms.length) { list.append(el('li', 'mark-empty', 'Пока нет закладок. Нажми на ленточку вверху страницы — котик запомнит место.')); return; }
  for (const m of ms) {
    const li = el('li');
    const go = el('button', 'mark-go');
    go.type = 'button';
    go.append(el('span', '', '«' + (m.snippet || '…').slice(0, 80) + '…»'), el('small', '', `${chapterTitle(m.ch)} · ${pctText(m.pct || 0)}`));
    go.addEventListener('click', () => { $('#dlg-toc').close(); rememberSpot(); goTo(m.ch, m.off); });
    const del = el('button', 'icon-btn small');
    del.type = 'button';
    del.setAttribute('aria-label', 'Удалить закладку');
    del.append(icon('i-trash'));
    del.addEventListener('click', () => { R.marks = R.marks.filter(x => x !== m); save(); updateMarkUI(); renderMarks(); });
    li.append(go, del);
    list.append(li);
  }
}
$('#r-toc').addEventListener('click', () => {
  const list = $('#toc-list');
  list.replaceChildren();
  let cur = null;
  for (const e of R.book.toc) {
    const li = el('li');
    const b = el('button', '', e.t);
    b.type = 'button';
    b.style.setProperty('--d', Math.min(e.d || 1, 4));
    b.addEventListener('click', () => { $('#dlg-toc').close(); rememberSpot(); goToGid(e.g); });
    li.append(b);
    list.append(li);
    if (e.ch <= R.ch) cur = b;
  }
  if (!R.book.toc.length) list.append(el('li', 'mark-empty', 'В этой книжке нет оглавления'));
  cur?.setAttribute('aria-current', 'true');
  renderMarks();
  setTab(false);
  $('#dlg-toc').showModal();
  cur?.scrollIntoView({ block: 'center' });
});

/* --- ссылки и сноски --- */

async function handleLink(a) {
  if (!a.dataset.link) {
    if (a.href) window.open(a.href, '_blank', 'noopener');
    return;
  }
  const gid = a.dataset.link;
  const ch = R.book.ids[gid];
  if (ch == null) return;
  const looksNote = a.dataset.note || (R.book.notesFrom != null && ch >= R.book.notesFrom) ||
    /^\s*[[({]?\s*(\d{1,4}|\*{1,3}|[a-zа-я])\s*[\])}]?\s*$/i.test(a.textContent);
  if (looksNote) {
    const html = await noteHtml(ch, gid);
    if (html) { $('#note-body').innerHTML = html; $('#dlg-note').showModal(); return; }
  }
  rememberSpot();
  goToGid(gid);
}
async function noteHtml(ch, gid) {
  let root;
  if (ch === R.ch) root = flow;
  else {
    const t = document.createElement('template');
    t.innerHTML = (await DB.get('chapters', [R.book.id, ch])) || '';
    root = t.content;
  }
  let e = root.querySelector(`[id="${CSS.escape(gid)}"]`);
  if (!e) return null;
  if (!e.textContent.trim() || /^(A|SPAN|SUP|EM|STRONG|B|I|SMALL)$/.test(e.tagName)) e = e.closest('p, li, dd, blockquote, div') || e;
  if (e.textContent.length > 4000 || !e.textContent.trim()) return null;
  const c = e.cloneNode(true);
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  c.querySelectorAll('a').forEach(x => x.replaceWith(...x.childNodes));
  c.querySelectorAll('img').forEach(x => x.remove());
  return c.outerHTML;
}
$('#r-backlink').addEventListener('click', () => {
  const b = R.back;
  R.back = null;
  $('#r-backlink').hidden = true;
  if (b) goTo(b.ch, b.off);
});

/* ===================== старт ===================== */

applyTheme();
applyLight();
applyReaderStyle();
syncSettingsUI();
persistStorage();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('sw', e));
  // Пришла новая версия. Перезагружаемся ТОЛЬКО незаметно:
  //  • пока приложение свёрнуто (её не видно), или
  //  • в первые секунды после запуска, если она ещё ничего не нажимала.
  // Никогда — после её касаний: иначе перезагрузка может оборвать открытие книги.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    updateReady = true;
    if (!touchedSinceStart && performance.now() < 5000) applyUpdate();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') applyUpdate(); });
}
var updateReady = false;
var touchedSinceStart = false;
addEventListener('pointerdown', () => { touchedSinceStart = true; }, { capture: true, passive: true });
addEventListener('keydown', () => { touchedSinceStart = true; }, { capture: true, passive: true });
function applyUpdate() {
  if (!updateReady || importing || R.busy) return;
  updateReady = false;
  save(); flushSave();
  setTimeout(() => location.reload(), 150);
}

(async () => {
  try {
    await renderLibrary();
    const v = lsGet('view') || '';
    if (v.startsWith('reader:')) {
      // приложение закрылось на чтении — сразу возвращаем на ту же страницу
      const id = v.slice(7);
      if (books.some(b => b.id === id)) await openBook(id, null, { instant: true });
    }
  } catch (e) {
    console.error(e);
    toast('Хранилище не открылось. Попробуй перезапустить Мурчалку');
  }
})();

// для отладки в консоли
window.murchalka = { importFiles, R, relayout, goTo, openBook, closeReader };
