// «Мои меню»: список, просмотр, добавление по фото (Claude), очередь офлайн, настройки, синхронизация с GitHub.
import { state, load, menuTitle } from "./data.js";
import { db, photoURL } from "./store.js";
import { $, $$, esc, fmtDate, toast, uid, lsGet, lsSet, norm } from "./util.js";
import { resetProgress } from "./cards.js";
import { CONFIG } from "./config.js";

const K_API = "claude.apiKey";
const K_GH = "github.sync";

// ——— Нижний лист ———
const sheet = () => $("#sheet");
function openSheet(title, html) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  if (!sheet().open) sheet().showModal();
  $("#sheet-body").scrollTop = 0;
  return $("#sheet-body");
}
export const closeSheet = () => sheet().open && sheet().close();

export function openPhoto(src) {
  const d = $("#photo-view");
  d.querySelector("img").src = src;
  d.showModal();
}

// ——— Список меню ———
export async function renderMenus() {
  const list = $("#menus-list");
  const groups = new Map();
  for (const m of state.menus) {
    const k = m.name || "Без названия";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const parts = [];
  for (const [name, ms] of groups) {
    const note = ms.find((m) => m.note)?.note;
    parts.push(`<div class="rest"><h3>${esc(name)}</h3>${note ? `<div class="rest-note">${esc(note)}</div>` : ""}`);
    for (const m of ms) {
      parts.push(`<button class="menu-card" data-menu="${esc(m.id)}">
        <span class="thumb" data-thumb="${esc(m.photos?.[0] || "")}">${esc((m.name || "?")[0])}</span>
        <span class="meta"><span class="t">${esc(m.label || "меню")}${m.date ? " · " + fmtDate(m.date) : ""}${m.local && !m.synced ? '<span class="badge">только на этом устройстве</span>' : ""}</span>
        <span class="s">${(m.dishes || []).length} блюд${m.src === "chat" ? " · из чата" : ""}</span></span></button>`);
    }
    parts.push("</div>");
  }
  list.innerHTML = parts.join("") || `<div class="empty"><span class="big">📷</span>Пока нет меню. Нажми «Добавить меню» и сфотографируй.</div>`;
  for (const el of $$("[data-thumb]", list)) {
    const ref = el.dataset.thumb;
    if (!ref) continue;
    const url = await photoURL(ref);
    if (url) el.outerHTML = `<img class="thumb" src="${esc(url)}" alt="">`;
  }
  renderQueueNote();
}

async function renderQueueNote() {
  const q = await db.all("queue").catch(() => []);
  const el = $("#queue-note");
  if (!q.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>📥 Ждут распознавания: ${q.length} ${q.length === 1 ? "меню" : "меню"} (сфотографированы без интернета)</span>
    <button class="btn small" id="run-queue">Распознать</button>`;
  $("#run-queue").onclick = () => processQueue(true);
}

// ——— Просмотр меню ———
export async function openMenu(id) {
  const m = state.menus.find((x) => x.id === id);
  if (!m) return;
  const sections = new Map();
  for (const d of m.dishes || []) {
    const s = d.section || "";
    if (!sections.has(s)) sections.set(s, []);
    sections.get(s).push(d);
  }
  let html = "";
  if (m.date || m.kind || m.website) {
    html += `<p class="muted">${[m.kind, m.date && fmtDate(m.date), m.website].filter(Boolean).map(esc).join(" · ")}</p>`;
  }
  if (m.note) html += `<p class="muted">${esc(m.note)}</p>`;
  if (m.photos?.length) html += `<div class="photos" id="menu-photos"></div>`;
  for (const [s, ds] of sections) {
    if (s) html += `<div class="section-title">${esc(s)}</div>`;
    for (const d of ds) {
      html += `<div class="dish"><div class="dish-head"><span class="pt">${esc(d.pt)}</span>${d.price ? `<span class="price">${esc(d.price)}</span>` : ""}</div>
        <div class="ru">${esc(d.ru)}</div>${d.en ? `<div class="en">${esc(d.en)}</div>` : ""}${d.note ? `<div class="en">⚠︎ ${esc(d.note)}</div>` : ""}</div>`;
    }
  }
  html += `<div class="hr"></div><div class="row">
    <button class="btn secondary" id="m-edit">Редактировать</button>
    <button class="btn secondary" id="m-cards">Учить блюда</button>
    ${m.local || m.src !== "chat" ? `<button class="btn danger" id="m-del">Удалить</button>` : ""}</div>`;
  const body = openSheet(menuTitle(m), html);
  if (m.photos?.length) {
    const box = $("#menu-photos", body);
    for (const ref of m.photos) {
      const url = await photoURL(ref);
      if (!url) continue;
      const img = document.createElement("img");
      img.src = url; img.alt = "Фото меню";
      img.onclick = () => openPhoto(url);
      const fig = document.createElement("figure");
      fig.append(img);
      box.append(fig);
    }
  }
  $("#m-edit", body).onclick = () => openEditor({ ...m, dishes: (m.dishes || []).map((d) => ({ ...d })) });
  $("#m-cards", body).onclick = () => {
    lsSet("cards.settings.v1", { ...lsGet("cards.settings.v1", { dir: "pt-ru" }), deck: "rest:" + m.name });
    closeSheet();
    location.hash = "#cards";
  };
  const del = $("#m-del", body);
  if (del) del.onclick = async () => {
    if (!confirm(`Удалить меню «${menuTitle(m)}»?`)) return;
    await db.put("menus", { id: m.id, deleted: true, updatedAt: Date.now() });
    closeSheet();
    await load();
    toast("Меню удалено");
  };
}

// ——— Фото ———
async function downscale(file, max = 2000, quality = 0.85) {
  const bmp = await createImageBitmap(file).catch(() => null);
  let w, h, src;
  if (bmp) { w = bmp.width; h = bmp.height; src = bmp; }
  else {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", quality));
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

// ——— Добавление меню ———
let draft = null; // { photos: [{id, blob, url}], name, date }

export function openAdd() {
  draft = { photos: [], name: "", date: new Date().toISOString().slice(0, 10) };
  renderAdd();
}

function renderAdd(error = "") {
  const hasKey = !!lsGet(K_API, "");
  const online = navigator.onLine;
  const names = [...new Set(state.menus.map((m) => m.name).filter(Boolean))];
  const body = openSheet("Новое меню", `
    <p class="muted">Сфотографируй меню целиком (можно несколько страниц). Claude перепишет все блюда и переведёт их на русский и английский.</p>
    <div class="row">
      <label class="btn filebtn">📷 Сфотографировать<input type="file" accept="image/*" capture="environment" id="add-cam"></label>
      <label class="btn secondary filebtn">🖼 Из галереи<input type="file" accept="image/*" multiple id="add-gal"></label>
    </div>
    <div class="photos" id="add-photos"></div>
    <label class="field"><span>Ресторан (необязательно — Claude попробует прочитать с фото)</span>
      <input id="add-name" list="rest-names" value="${esc(draft.name)}" placeholder="Например, Os Barões"></label>
    <datalist id="rest-names">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <label class="field"><span>Дата</span><input id="add-date" type="date" value="${esc(draft.date)}"></label>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    ${!hasKey ? `<div class="note">Для распознавания нужен API-ключ Claude — добавь его в настройках (⚙︎). Без ключа можно сохранить фото и ввести блюда вручную.</div>` : ""}
    ${!online ? `<div class="note">Нет интернета: фото сохранятся и распознаются автоматически, когда связь появится.</div>` : ""}
    <div class="row" style="margin-top:14px">
      <button class="btn grow" id="add-go" ${draft.photos.length ? "" : "disabled"}>${online && hasKey ? "Распознать" : "Сохранить фото, распознать позже"}</button>
      <button class="btn ghost" id="add-manual">Ввести вручную</button>
    </div>`);

  const renderThumbs = () => {
    $("#add-photos", body).innerHTML = draft.photos.map((p, i) =>
      `<figure><img src="${p.url}" alt="Страница ${i + 1}" data-i="${i}"><button data-rm="${i}" aria-label="Убрать">✕</button></figure>`).join("");
    $$("[data-rm]", body).forEach((b) => (b.onclick = () => { draft.photos.splice(+b.dataset.rm, 1); renderThumbs(); }));
    $$("[data-i]", body).forEach((im) => (im.onclick = () => openPhoto(im.src)));
    $("#add-go", body).disabled = !draft.photos.length;
  };
  const onFiles = async (e) => {
    for (const f of e.target.files) {
      const blob = await downscale(f);
      draft.photos.push({ id: "ph_" + uid(), blob, url: URL.createObjectURL(blob) });
    }
    e.target.value = "";
    renderThumbs();
  };
  $("#add-cam", body).onchange = onFiles;
  $("#add-gal", body).onchange = onFiles;
  $("#add-name", body).oninput = (e) => (draft.name = e.target.value);
  $("#add-date", body).oninput = (e) => (draft.date = e.target.value);
  $("#add-go", body).onclick = () => (navigator.onLine && hasKey ? recognizeDraft() : queueDraft());
  $("#add-manual", body).onclick = async () => {
    const photos = await savePhotos(draft.photos);
    openEditor({ id: "m_" + uid(), name: draft.name, label: "меню", date: draft.date, photos, dishes: [{ pt: "", ru: "", en: "", section: "", price: "" }], words: [], isNew: true });
  };
  renderThumbs();
}

async function savePhotos(photos) {
  for (const p of photos) await db.put("photos", { id: p.id, blob: p.blob });
  return photos.map((p) => p.id);
}

async function queueDraft() {
  const photos = await savePhotos(draft.photos);
  await db.put("queue", { id: "q_" + uid(), name: draft.name, date: draft.date, photos, createdAt: Date.now() });
  closeSheet();
  toast("Фото сохранены — распознаю, когда будет интернет и ключ Claude");
  renderQueueNote();
}

async function callClaude(photoBlobs, hint) {
  const apiKey = lsGet(K_API, "");
  const mod = await import("../vendor/claude.js");
  try {
    const images = await Promise.all(photoBlobs.map(async (b) => ({ mediaType: "image/jpeg", data: await blobToBase64(b) })));
    return await mod.recognizeMenu({ apiKey, images, hint });
  } catch (e) {
    const err = new Error(mod.describeError(e));
    err.connection = mod.isConnectionError(e);
    throw err;
  }
}

async function recognizeDraft() {
  const body = openSheet("Распознаю меню…", `<div class="status"><span class="spinner"></span>
    <span>Claude читает ${draft.photos.length > 1 ? draft.photos.length + " фото" : "фото"} и переводит блюда. Обычно это 20–90 секунд.</span></div>`);
  void body;
  try {
    const res = await callClaude(draft.photos.map((p) => p.blob), draft.name ? `ресторан «${draft.name}»` : "");
    const photos = await savePhotos(draft.photos);
    openEditor({
      id: "m_" + uid(), name: draft.name || res.name || "", label: "меню", date: draft.date, photos,
      dishes: res.dishes, words: res.words, isNew: true,
    });
  } catch (e) {
    if (e.connection) return queueDraft();
    renderAdd(e.message);
  }
}

// Очередь: распознать сохранённые без интернета фото.
let queueBusy = false;
export async function processQueue(manual = false) {
  if (queueBusy) return;
  const items = await db.all("queue").catch(() => []);
  if (!items.length) return;
  if (!lsGet(K_API, "")) { if (manual) toast("Сначала добавь API-ключ Claude в настройках"); return; }
  if (!navigator.onLine) { if (manual) toast("Нет интернета"); return; }
  queueBusy = true;
  if (manual) toast(`Распознаю ${items.length} меню…`, 4000);
  for (const q of items) {
    try {
      const blobs = (await Promise.all(q.photos.map((id) => db.get("photos", id)))).filter(Boolean).map((r) => r.blob);
      const res = await callClaude(blobs, q.name ? `ресторан «${q.name}»` : "");
      await db.put("menus", { id: "m_" + uid(), name: q.name || res.name || "Без названия", label: "меню", date: q.date, photos: q.photos,
        dishes: res.dishes, words: res.words, createdAt: Date.now(), updatedAt: Date.now() });
      await db.del("queue", q.id);
      toast(`Меню «${q.name || res.name || "без названия"}» распознано: ${res.dishes.length} блюд`, 4000);
    } catch (e) {
      if (manual) toast(e.message, 5000);
      break;
    }
  }
  queueBusy = false;
  await load();
}

// ——— Редактор меню ———
function openEditor(m) {
  const body = openSheet(m.isNew ? "Проверь блюда" : "Редактирование", `
    <label class="field"><span>Ресторан</span><input id="e-name" value="${esc(m.name || "")}" placeholder="Название ресторана"></label>
    <div class="row">
      <label class="field grow"><span>Подпись</span><input id="e-label" value="${esc(m.label || "")}" placeholder="меню, блюда дня…"></label>
      <label class="field"><span>Дата</span><input id="e-date" type="date" value="${esc(m.date || "")}"></label>
    </div>
    ${m.isNew && m.words?.length ? `<p class="muted">Новых слов для словаря: ${m.words.filter((w) => !state.words.some((x) => x.k === norm(w.pt.replace(/^(o|a|os|as)\s+/i, "")))).length}</p>` : ""}
    <div id="e-dishes"></div>
    <div class="row" style="margin-top:10px">
      <button class="btn secondary small" id="e-add">＋ блюдо</button>
    </div>
    <div class="hr"></div>
    <div class="row"><button class="btn grow" id="e-save">Сохранить меню</button><button class="btn ghost" id="e-cancel">Отмена</button></div>`);

  const renderRows = () => {
    let html = "", last = null;
    m.dishes.forEach((d, i) => {
      if (d.section !== last && d.section) html += `<div class="section-title">${esc(d.section)}</div>`;
      last = d.section;
      html += `<div class="edit-dish" data-i="${i}">
        <input class="pt-in" value="${esc(d.pt)}" placeholder="Название (PT)" aria-label="Название по-португальски">
        <input class="price-in" value="${esc(d.price || "")}" placeholder="Цена" aria-label="Цена">
        <button class="del" aria-label="Удалить блюдо">✕</button>
        <input class="ru-in" value="${esc(d.ru)}" placeholder="Перевод (RU)" aria-label="Перевод на русский">
      </div>`;
    });
    $("#e-dishes", body).innerHTML = html;
    $$(".edit-dish", body).forEach((row) => {
      const d = m.dishes[+row.dataset.i];
      row.querySelector(".pt-in").oninput = (e) => (d.pt = e.target.value);
      row.querySelector(".ru-in").oninput = (e) => (d.ru = e.target.value);
      row.querySelector(".price-in").oninput = (e) => (d.price = e.target.value);
      row.querySelector(".del").onclick = () => { m.dishes.splice(+row.dataset.i, 1); renderRows(); };
    });
  };
  renderRows();
  $("#e-add", body).onclick = () => { m.dishes.push({ pt: "", ru: "", en: "", section: m.dishes.at(-1)?.section || "", price: "" }); renderRows(); };
  $("#e-cancel", body).onclick = closeSheet;
  $("#e-save", body).onclick = async () => {
    const rec = {
      id: m.id, name: $("#e-name", body).value.trim() || "Без названия", label: $("#e-label", body).value.trim(),
      date: $("#e-date", body).value || null, photos: m.photos || [], kind: m.kind, note: m.note, website: m.website, src: m.src,
      dishes: m.dishes.filter((d) => d.pt.trim()).map((d) => ({ ...d, pt: d.pt.trim(), ru: d.ru.trim() })),
      words: m.words || [], createdAt: m.createdAt || Date.now(), updatedAt: Date.now(), synced: false,
    };
    await db.put("menus", rec);
    closeSheet();
    await load();
    toast(`Сохранено: ${rec.dishes.length} блюд`);
    if (lsGet(K_GH, {}).token) syncGitHub(false);
  };
}

// ——— Настройки ———
export function openSettings() {
  const gh = { repo: CONFIG.repo, branch: CONFIG.branch, ...lsGet(K_GH, {}) };
  const key = lsGet(K_API, "");
  const body = openSheet("Настройки", `<div class="settings">
    <h4>Claude (распознавание фото меню)</h4>
    <p class="muted">Ключ хранится только в этом браузере и отправляется только в api.anthropic.com.</p>
    <label class="field"><span>API-ключ Anthropic</span><input id="s-key" type="password" autocomplete="off" value="${esc(key)}" placeholder="sk-ant-…"></label>
    <details class="help"><summary>Где взять ключ</summary><ol>
      <li>Открой platform.claude.com → API Keys.</li><li>Create Key, скопируй его и вставь сюда.</li>
      <li>Распознавание одного меню стоит примерно несколько центов.</li></ol></details>
    <div class="row"><button class="btn small" id="s-key-save">Сохранить ключ</button>${key ? `<button class="btn ghost small" id="s-key-del">Удалить ключ</button>` : ""}</div>

    <h4>Синхронизация с GitHub</h4>
    <p class="muted">Новые меню и фото попадут в репозиторий сайта и будут видны на всех устройствах. Без этого они хранятся только на этом устройстве.</p>
    <label class="field"><span>Репозиторий</span><input id="s-repo" value="${esc(gh.repo || "")}" placeholder="owner/menu"></label>
    <label class="field"><span>Токен GitHub (fine-grained, доступ Contents: Read and write только к этому репозиторию)</span>
      <input id="s-token" type="password" autocomplete="off" value="${esc(gh.token || "")}" placeholder="github_pat_…"></label>
    <details class="help"><summary>Как создать токен</summary><ol>
      <li>github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.</li>
      <li>Repository access: Only select repositories → репозиторий сайта.</li>
      <li>Permissions → Repository permissions → Contents: Read and write.</li></ol></details>
    <div class="row"><button class="btn small" id="s-gh-save">Сохранить</button><button class="btn secondary small" id="s-sync">Синхронизировать сейчас</button></div>

    <h4>Данные</h4>
    <div class="row">
      <button class="btn secondary small" id="s-export">Скачать мои меню (JSON)</button>
      <label class="btn secondary small filebtn">Загрузить JSON<input type="file" accept="application/json" id="s-import"></label>
      <button class="btn danger small" id="s-reset">Сбросить прогресс карточек</button>
    </div>
    <p class="muted" id="s-storage"></p>
  </div>`);
  $("#s-key-save", body).onclick = () => { lsSet(K_API, $("#s-key", body).value.trim()); toast("Ключ сохранён"); processQueue(); openSettings(); };
  const kd = $("#s-key-del", body); if (kd) kd.onclick = () => { localStorage.removeItem(K_API); openSettings(); };
  $("#s-gh-save", body).onclick = () => {
    lsSet(K_GH, { repo: $("#s-repo", body).value.trim(), token: $("#s-token", body).value.trim(), branch: gh.branch || "main" });
    toast("Сохранено");
  };
  $("#s-sync", body).onclick = () => {
    lsSet(K_GH, { repo: $("#s-repo", body).value.trim(), token: $("#s-token", body).value.trim(), branch: gh.branch || "main" });
    syncGitHub(true);
  };
  $("#s-export", body).onclick = exportJSON;
  $("#s-import", body).onchange = importJSON;
  $("#s-reset", body).onclick = () => { if (confirm("Сбросить прогресс всех карточек?")) { resetProgress(); toast("Прогресс сброшен"); } };
  navigator.storage?.estimate?.().then((e) => {
    $("#s-storage", body).textContent = `Занято на устройстве: ${(e.usage / 1048576).toFixed(1)} МБ`;
  });
}

async function exportJSON() {
  const menus = (await db.all("menus")).filter((m) => !m.deleted);
  const out = [];
  for (const m of menus) {
    const photos = [];
    for (const ref of m.photos || []) {
      const rec = await db.get("photos", ref);
      photos.push(rec ? "data:image/jpeg;base64," + (await blobToBase64(rec.blob)) : ref);
    }
    out.push({ ...m, photos });
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: "application/json" }));
  a.download = `menus-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

async function importJSON(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const arr = JSON.parse(await f.text());
    let n = 0;
    for (const m of Array.isArray(arr) ? arr : [arr]) {
      if (!m?.id || !Array.isArray(m.dishes)) continue;
      const photos = [];
      for (const p of m.photos || []) {
        if (String(p).startsWith("data:")) {
          const id = "ph_" + uid();
          await db.put("photos", { id, blob: await (await fetch(p)).blob() });
          photos.push(id);
        } else photos.push(p);
      }
      await db.put("menus", { ...m, photos, synced: false, updatedAt: Date.now() });
      n++;
    }
    await load();
    toast(`Загружено меню: ${n}`);
  } catch (err) {
    toast("Не удалось прочитать файл: " + err.message, 5000);
  }
}

// ——— GitHub ———
const b64encode = (str) => { const bytes = new TextEncoder().encode(str); let bin = ""; bytes.forEach((b) => (bin += String.fromCharCode(b))); return btoa(bin); };
const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function gh(path, opts = {}) {
  const { repo, token } = lsGet(K_GH, {});
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  if (r.status === 404 && !opts.method) return null;
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).message || r.status;
    throw new Error(`GitHub: ${msg}`);
  }
  return r.json();
}

let syncing = false;
export async function syncGitHub(manual) {
  const cfg = lsGet(K_GH, {});
  if (!cfg.token || !cfg.repo) { if (manual) toast("Укажи репозиторий и токен GitHub"); return; }
  if (!navigator.onLine) { if (manual) toast("Нет интернета — синхронизирую позже"); return; }
  if (syncing) return;
  syncing = true;
  try {
    const local = await db.all("menus");
    const pending = local.filter((m) => !m.synced);
    if (!pending.length) { if (manual) toast("Всё уже синхронизировано"); return; }
    if (manual) toast("Отправляю в GitHub…", 6000);
    const branch = cfg.branch || "main";
    const file = await gh(`data/menus.json?ref=${branch}`);
    let remote = file ? JSON.parse(b64decode(file.content)) : [];
    for (const m of pending) {
      if (m.deleted) { remote = remote.filter((x) => x.id !== m.id); continue; }
      const photos = [];
      for (const [i, ref] of (m.photos || []).entries()) {
        if (/^(https?:|photos\/)/.test(ref)) { photos.push(ref); continue; }
        const rec = await db.get("photos", ref);
        if (!rec) continue;
        const path = `photos/${m.id}-${i + 1}.jpg`;
        const exists = await gh(`${path}?ref=${branch}`);
        if (!exists) await gh(path, { method: "PUT", body: JSON.stringify({ message: `Фото меню ${m.name}`, content: await blobToBase64(rec.blob), branch }) });
        photos.push(path);
      }
      const { local: _l, synced: _s, isNew: _n, ...clean } = m;
      const rec = { ...clean, photos, src: "app" };
      const idx = remote.findIndex((x) => x.id === m.id);
      if (idx >= 0) remote[idx] = rec; else remote.push(rec);
    }
    await gh("data/menus.json", { method: "PUT", body: JSON.stringify({
      message: `Меню: ${pending.map((m) => m.name).join(", ")}`, content: b64encode(JSON.stringify(remote, null, 1)), sha: file?.sha, branch }) });
    for (const m of pending) await db.put("menus", { ...m, synced: true });
    await load();
    toast("Синхронизировано с GitHub — сайт обновится через минуту", 4000);
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    syncing = false;
  }
}
