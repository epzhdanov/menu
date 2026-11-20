// Точка входа: вкладки, словарь, поиск блюд, офлайн.
import { state, load, onChange, CATS, menuTitle } from "./data.js";
import { searchDishes, searchWords, filterWords, breakdown, tokens } from "./search.js";
import { initCards, refreshCards } from "./cards.js";
import { renderMenus, openMenu, openAdd, openSettings, closeSheet, processQueue, syncGitHub } from "./menus.js";
import { persist } from "./store.js";
import { $, $$, esc, highlight, splitArticle, speak, fmtDate, lsGet, lsSet, SPEAK_ICON } from "./util.js";

// ——— Вкладки ———
const VIEWS = ["dict", "search", "cards", "menus"];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "dict";
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== v;
  $$(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === v));
  lsSet("ui.tab", v);
  if (v === "cards" && state.ready) refreshCards();
  if (v === "search") setTimeout(() => $("#search-q").focus({ preventScroll: true }), 50);
  window.scrollTo({ top: 0 });
}

// ——— Словарь ———
let dictCat = "";
function wordRow(w, qt) {
  const [art, rest] = splitArticle(w.pt);
  const chatTag = w.src === "chat" ? `<span class="tag">из чата</span>` : w.src === "menu" ? `<span class="tag">из меню</span>` : "";
  return `<div class="entry">
    <div class="pt">${art ? `<span class="art">${esc(art)} </span>` : ""}${highlight(rest, qt)}${chatTag}</div>
    <div class="ru">${highlight(w.ru, qt)}</div>
    ${w.en ? `<div class="en">${highlight(w.en, qt)}</div>` : ""}
    <button class="icon-btn speak" data-say="${esc(w.pt)}" aria-label="Произнести ${esc(w.pt)}">${SPEAK_ICON}</button>
  </div>`;
}

function renderDict() {
  const q = $("#dict-q").value;
  const qt = tokens(q);
  const words = filterWords(q, dictCat);
  $("#dict-count").textContent = `${words.length} ${plural(words.length, "слово", "слова", "слов")}${dictCat ? " · " + dictCat : ""}`;
  let html = "", letter = null;
  const letters = [];
  for (const w of words) {
    if (w.letter !== letter) {
      letter = w.letter;
      letters.push(letter);
      html += `<div class="letter" id="L-${esc(letter)}">${esc(letter)}</div>`;
    }
    html += wordRow(w, qt);
  }
  $("#dict-list").innerHTML = html || `<div class="empty"><span class="big">🔎</span>Ничего не нашлось</div>`;
  $("#dict-letters").innerHTML = letters.length > 6
    ? `<div class="letters-inner">${letters.map((l) => `<button data-letter="${esc(l)}">${esc(l)}</button>`).join("")}</div>` : "";
}

function renderCats() {
  const counts = Object.fromEntries(CATS.map((c) => [c, state.words.filter((w) => w.cat === c).length]));
  $("#dict-cats").innerHTML = [`<button class="chip ${dictCat ? "" : "on"}" data-cat="">Все</button>`,
    ...CATS.filter((c) => counts[c]).map((c) => `<button class="chip ${dictCat === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`)].join("");
}

// ——— Поиск блюд ———
function breakdownHTML(name) {
  return `<div class="breakdown">${breakdown(name).map((p) => {
    if (p.word) return `<span class="bd"><b>${esc(p.text)}</b><small>${esc(p.word.ru)}</small></span>`;
    if (p.minor !== undefined) return `<span class="bd minor">${esc(p.text)}${p.minor ? `<small>${esc(p.minor)}</small>` : ""}</span>`;
    return `<span class="bd unknown"><b>${esc(p.text)}</b><small>?</small></span>`;
  }).join("")}</div>`;
}

function renderSearch() {
  const q = $("#search-q").value.trim();
  const box = $("#search-results");
  if (!q) {
    const recent = [...state.menus].filter((m) => m.date).sort((a, b) => b.date.localeCompare(a.date))[0];
    box.innerHTML = `<div class="empty"><span class="big">🍽</span>Впиши название блюда — по-португальски, по-русски или по-английски.<br>
      Поиск идёт по ${state.dishes.length} блюдам из ${state.menus.length} меню и по словарю. Опечатки и отсутствие ударений не мешают.
      ${recent ? `<br><br>Последнее меню: <b>${esc(menuTitle(recent))}</b>, ${fmtDate(recent.date)}` : ""}</div>`;
    return;
  }
  const qt = tokens(q);
  const dishes = searchDishes(q).slice(0, 40);
  const words = searchWords(q, 12);
  let html = "";
  if (dishes.length) {
    html += `<div class="group-title">Блюда из моих меню · ${dishes.length}</div>`;
    for (const [i, g] of dishes.entries()) {
      const prices = [...g.prices];
      const byRest = new Map();
      for (const m of g.seen) {
        if (!byRest.has(m.name)) byRest.set(m.name, []);
        byRest.get(m.name).push(m);
      }
      const where = [...byRest.entries()].map(([name, ms]) => {
        const dates = ms.map((m) => m.date).filter(Boolean).sort().reverse();
        const label = dates.length ? `${name} · ${dates.length > 3 ? `${dates.length} раз, последний ${fmtDate(dates[0])}` : dates.map(fmtDate).join(", ")}` : `${name} · ${ms[0].label || "меню"}`;
        return `<button data-open-menu="${esc(ms.find((m) => m.date === dates[0])?.id || ms[0].id)}">${esc(label)}</button>`;
      }).join("");
      html += `<div class="dish">
        <div class="dish-head"><span class="pt">${highlight(g.pt, qt)}</span>${prices.length ? `<span class="price">${esc(prices.length > 1 ? prices.join(" / ") : prices[0])}</span>` : ""}</div>
        <div class="ru">${highlight(g.ru, qt)}</div>
        ${g.en ? `<div class="en">${highlight(g.en, qt)}</div>` : ""}
        ${g.notes.size ? `<div class="en">⚠︎ ${esc([...g.notes].join(", "))}</div>` : ""}
        <div class="where">${where}</div>
        <button class="toggle-bd" data-bd="${i}">Разобрать по словам</button>
        <div class="bd-slot" data-bd-slot="${i}" data-name="${esc(g.pt)}"></div>
      </div>`;
    }
  }
  if (words.length) {
    html += `<div class="group-title">Слова из словаря</div>` + words.map((w) => wordRow(w, qt)).join("");
  }
  // Блюдо не встречалось — разбор запроса по словам (полезно для нового меню без интернета).
  const bd = breakdown(q);
  const known = bd.filter((p) => p.word).length;
  if (known && (qt.length > 1 || !dishes.length) && !(known === 1 && bd.length === 1 && words.length)) {
    html = `<div class="group-title">Перевод по словам</div><div class="dish">${breakdownHTML(q)}</div>` + html;
  }
  box.innerHTML = html || `<div class="empty"><span class="big">🤷</span>Не нашлось ни блюд, ни слов. Попробуй часть слова или другое написание.</div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// ——— Сеть ———
function netStatus() {
  $("#net").hidden = navigator.onLine;
}

// ——— Старт ———
function wire() {
  window.addEventListener("hashchange", route);
  $("#dict-q").addEventListener("input", renderDict);
  $("#dict-cats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    dictCat = b.dataset.cat;
    renderCats();
    renderDict();
  });
  $("#dict-letters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-letter]");
    if (!b) return;
    // Целимся в первую карточку после заголовка буквы: сам заголовок «липкий», его позиция врёт.
    const first = document.getElementById("L-" + b.dataset.letter)?.nextElementSibling;
    if (!first) return;
    const offset = $(".sticky-tools").getBoundingClientRect().bottom + 40;
    window.scrollTo({ top: first.getBoundingClientRect().top + scrollY - offset, behavior: "instant" });
  });
  let t;
  $("#search-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(renderSearch, 120); });
  document.addEventListener("click", (e) => {
    const say = e.target.closest("[data-say]");
    if (say) return speak(say.dataset.say);
    const om = e.target.closest("[data-open-menu]");
    if (om) return openMenu(om.dataset.openMenu);
    const mc = e.target.closest("[data-menu]");
    if (mc) return openMenu(mc.dataset.menu);
    const bd = e.target.closest("[data-bd]");
    if (bd) {
      const slot = $(`[data-bd-slot="${bd.dataset.bd}"]`);
      slot.innerHTML = slot.innerHTML ? "" : breakdownHTML(slot.dataset.name);
      bd.textContent = slot.innerHTML ? "Скрыть разбор" : "Разобрать по словам";
    }
  });
  $("#add-menu").addEventListener("click", openAdd);
  $("#open-settings").addEventListener("click", openSettings);
  $$("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#photo-view").addEventListener("click", (e) => e.currentTarget.close());
  $("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });
  window.addEventListener("online", () => { netStatus(); processQueue(); syncGitHub(false); });
  window.addEventListener("offline", netStatus);
  initCards();
}

onChange(() => {
  renderCats();
  renderDict();
  renderSearch();
  renderMenus();
  if (!$("#view-cards").hidden) refreshCards();
});

async function main() {
  if (!location.hash) location.hash = "#" + lsGet("ui.tab", "dict");
  wire();
  route();
  netStatus();
  await load();
  persist();
  processQueue();
  syncGitHub(false);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
  }
  // Один раз с интернетом скачиваем распознавание фото, чтобы потом оно работало офлайн.
  setTimeout(() => {
    if (navigator.onLine) import("./ocr.js").then((m) => m.warmUp()).catch(() => {});
  }, 4000);
}
main();
