// Карточки PT → RU и RU → PT с простым интервальным повторением (коробки Лейтнера).
import { state, CATS, menuTitle } from "./data.js";
import { $, $$, esc, norm, stripArticle, lev, speak, lsGet, lsSet } from "./util.js";

const P_KEY = "cards.progress.v1";
const S_KEY = "cards.settings.v1";
const WEIGHTS = [8, 4, 2, 1, 0.5, 0.25];

let settings = lsGet(S_KEY, { dir: "pt-ru", deck: "all" });
let progress = lsGet(P_KEY, {});
let deck = [];
let current = null;
let recent = [];
let flipped = false;
let answered = false;
let history = []; // ранее показанные карточки — для кнопки «назад»

function buildDeck() {
  const d = settings.deck;
  if (d === "dishes" || d.startsWith("rest:")) {
    const rest = d.startsWith("rest:") ? d.slice(5) : null;
    const seen = new Map();
    for (const x of state.dishes) {
      if (rest && x.menu.name !== rest) continue;
      if (!x.ru || seen.has(x.npt)) continue;
      seen.set(x.npt, { id: "d:" + x.npt, pt: x.pt, ru: x.ru, en: x.en, src: menuTitle(x.menu) });
    }
    return [...seen.values()];
  }
  let words = state.words.filter((w) => w.ru);
  if (d === "chat") words = words.filter((w) => w.src === "chat");
  else if (d.startsWith("cat:")) words = words.filter((w) => w.cat === d.slice(4));
  return words.map((w) => ({ id: "w:" + w.k, pt: w.pt, ru: w.ru, en: w.en, src: w.cat }));
}

const pkey = (card) => settings.dir + "|" + card.id;
const box = (card) => progress[pkey(card)]?.b ?? -1;

function pick() {
  if (!deck.length) return null;
  const pool = deck.length > 4 ? deck.filter((c) => !recent.includes(c.id)) : deck;
  let total = 0;
  const w = pool.map((c) => { const b = box(c); const x = b < 0 ? 5 : WEIGHTS[Math.min(b, 5)]; total += x; return x; });
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

function renderStats() {
  const learned = deck.filter((c) => box(c) >= 3).length;
  const inWork = deck.filter((c) => box(c) >= 0 && box(c) < 3).length;
  $("#cards-stats").textContent = deck.length
    ? `В наборе ${deck.length} · выучено ${learned} · в работе ${inWork}`
    : "В этом наборе пока нет карточек";
}

function show(card) {
  current = card;
  flipped = false;
  answered = false;
  const el = $("#card");
  el.classList.remove("flipped");
  $("#card-verdict").hidden = true;
  const ptru = settings.dir === "pt-ru";
  $("#card-answer").hidden = ptru || !card;
  $("#card-input").value = "";
  const front = el.querySelector(".front"), back = el.querySelector(".back");
  if (!card) {
    front.querySelector(".card-word").textContent = "—";
    front.querySelector(".card-label").textContent = "";
    return;
  }
  front.querySelector(".card-label").textContent = ptru ? "português" : "русский";
  back.querySelector(".card-label").textContent = ptru ? "русский" : "português";
  front.querySelector(".card-word").textContent = ptru ? card.pt : card.ru;
  // оборот заполняем с задержкой, чтобы ответ не мелькнул во время анимации
  setTimeout(() => {
    if (current !== card) return;
    back.querySelector(".card-word").textContent = ptru ? card.ru : card.pt;
    back.querySelector(".card-extra").innerHTML =
      (card.en ? `<span class="en">EN: ${esc(card.en)}</span>` : "") + (card.src ? `<span class="src">${esc(card.src)}</span>` : "");
  }, 200);
  recent = [card.id, ...recent].slice(0, Math.min(6, Math.floor(deck.length / 2)));
  $("#card-prev").disabled = !history.length;
  renderStats();
}

// Следующая карточка (после оценки или без неё).
function next() {
  if (current) history.push(current);
  if (history.length > 100) history.shift();
  show(pick());
}

// Пропустить без оценки / вернуться к предыдущей.
function skip() { next(); }
function back() {
  if (!history.length) return;
  show(history.pop());
}

function flip() {
  if (!current) return;
  flipped = !flipped;
  $("#card").classList.toggle("flipped", flipped);
  if (flipped && settings.dir === "pt-ru") speak(current.pt);
}

function grade(ok) {
  if (!current) return;
  const k = pkey(current);
  const b = progress[k]?.b ?? -1;
  progress[k] = { b: ok ? Math.min(5, Math.max(0, b) + 1) : 0, t: Date.now() };
  lsSet(P_KEY, progress);
  next();
}

function check(e) {
  e.preventDefault();
  if (!current || answered) return;
  const input = $("#card-input").value.trim();
  if (!input) return;
  answered = true;
  const variants = current.pt.split(" / ").map((v) => stripArticle(v.trim()));
  const inRaw = stripArticle(input).toLowerCase();
  const exact = variants.some((v) => v.toLowerCase() === inRaw);
  const loose = variants.some((v) => norm(v) === norm(inRaw));
  const near = variants.some((v) => lev(norm(v), norm(inRaw), 2) <= 2);
  const v = $("#card-verdict");
  v.hidden = false;
  if (exact) { v.className = "verdict ok"; v.textContent = "Верно!"; }
  else if (loose) { v.className = "verdict close"; v.innerHTML = `Почти: проверь диакритику — <b>${esc(current.pt)}</b>`; }
  else if (near) { v.className = "verdict close"; v.innerHTML = `Близко! Правильно: <b>${esc(current.pt)}</b>`; }
  else { v.className = "verdict bad"; v.innerHTML = `Правильно: <b>${esc(current.pt)}</b>`; }
  if (!flipped) flip();
  speak(current.pt);
}

function fillDecks() {
  const sel = $("#cards-deck");
  const count = (fn) => state.words.filter((w) => w.ru && fn(w)).length;
  const rests = [...new Set(state.menus.map((m) => m.name))];
  const opts = [
    ["all", `Все слова (${count(() => true)})`],
    ["chat", `Слова из чата (${count((w) => w.src === "chat")})`],
    ["dishes", "Все блюда из моих меню"],
    ...rests.map((r) => ["rest:" + r, `Блюда: ${r}`]),
    ...CATS.map((c) => ["cat:" + c, `${c[0].toUpperCase() + c.slice(1)} (${count((w) => w.cat === c)})`]).filter((o) => !o[1].endsWith("(0)")),
  ];
  sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  if (!opts.some(([v]) => v === settings.deck)) settings.deck = "all";
  sel.value = settings.deck;
}

function setDir(dir) {
  settings.dir = dir;
  lsSet(S_KEY, settings);
  $$(".seg button").forEach((b) => { const on = b.dataset.dir === dir; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  restart();
}

function restart() {
  deck = buildDeck();
  recent = [];
  history = [];
  show(pick());
}

// Свайп по карточке: влево — следующая без оценки, вправо — предыдущая.
function initSwipe(el) {
  let x0 = 0, y0 = 0, swiped = false;
  el.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; swiped = false; }, { passive: true });
  el.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
      swiped = true;
      if (dx < 0) skip(); else back();
    }
  });
  // после свайпа не переворачивать карточку
  el.addEventListener("click", (e) => { if (swiped) { e.stopImmediatePropagation(); swiped = false; } }, true);
}

export function initCards() {
  $$(".seg button").forEach((b) => b.addEventListener("click", () => setDir(b.dataset.dir)));
  $("#cards-deck").addEventListener("change", (e) => { settings.deck = e.target.value; lsSet(S_KEY, settings); restart(); });
  initSwipe($("#card"));
  $("#card").addEventListener("click", flip);
  $("#card-skip").addEventListener("click", skip);
  $("#card-prev").addEventListener("click", back);
  $("#card-yes").addEventListener("click", () => grade(true));
  $("#card-no").addEventListener("click", () => grade(false));
  $("#card-speak").addEventListener("click", () => current && speak(current.pt));
  $("#card-answer").addEventListener("submit", check);
  document.addEventListener("keydown", (e) => {
    if ($("#view-cards").hidden || e.target.matches("input, select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); flip(); }
    if (e.key === "ArrowRight") grade(true);
    if (e.key === "ArrowLeft") grade(false);
    if (e.key === "ArrowDown" || e.key === "n") skip();
    if (e.key === "ArrowUp" || e.key === "b") back();
  });
}

export function refreshCards() {
  fillDecks();
  $$(".seg button").forEach((b) => { const on = b.dataset.dir === settings.dir; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  restart();
}

export function resetProgress() {
  progress = {};
  lsSet(P_KEY, progress);
  restart();
}
