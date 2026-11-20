// Загрузка и слияние данных: словарь, меню из чата, меню из репозитория, свои меню из IndexedDB.
import { db } from "./store.js";
import { norm, sortKey } from "./util.js";

export const CATS = ["блюда", "рыба", "морепродукты", "мясо", "овощи", "фрукты", "молочное", "хлеб и выпечка",
  "десерты", "напитки", "приправы и соусы", "приготовление", "меню и сервис", "другое"];

export const state = { words: [], menus: [], dishes: [], lexicon: new Map(), ready: false };

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(state));

async function fetchJSON(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch {
    return fallback;
  }
}

let base = null;
export async function load() {
  if (!base) {
    const [words, chatMenus, repoMenus] = await Promise.all([
      fetchJSON("data/words.json", []),
      fetchJSON("data/chat_menus.json", []),
      fetchJSON("data/menus.json", []),
    ]);
    base = { words, menus: [...chatMenus, ...repoMenus] };
  }
  const local = await db.all("menus").catch(() => []);
  const byId = new Map(base.menus.map((m) => [m.id, m]));
  for (const m of local) {
    if (m.deleted) byId.delete(m.id);
    else byId.set(m.id, { ...m, local: true });
  }
  const menus = [...byId.values()];
  menus.sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt") || (b.date || "9999").localeCompare(a.date || "9999"));

  // Слова: база + новые слова, которые Claude нашёл в сфотканных меню.
  const seen = new Map();
  const words = [];
  const addWord = (w, src) => {
    const k = sortKey(w.pt);
    if (!k || seen.has(k)) return;
    const entry = { pt: w.pt.trim(), ru: (w.ru || "").trim(), en: (w.en || "").trim(), cat: CATS.includes(w.cat) ? w.cat : "другое", src: w.src || src, alt: w.alt || [] };
    seen.set(k, entry);
    words.push(entry);
  };
  base.words.forEach((w) => addWord(w, "base"));
  menus.forEach((m) => (m.words || []).forEach((w) => addWord(w, "menu")));
  for (const w of words) {
    w.k = sortKey(w.pt);
    w.npt = norm([w.pt, ...w.alt].join(" "));
    w.nru = norm(w.ru);
    w.nen = norm(w.en);
    w.letter = (w.k[0] || "#").toUpperCase();
  }
  words.sort((a, b) => a.k.localeCompare(b.k, "pt"));

  const dishes = [];
  for (const m of menus) {
    for (const d of m.dishes || []) {
      dishes.push({ ...d, menu: m, npt: norm(d.pt), nru: norm(d.ru), nen: norm(d.en) });
    }
  }

  state.words = words;
  state.menus = menus;
  state.dishes = dishes;
  state.lexicon = buildLexicon(words);
  state.ready = true;
  emit();
  return state;
}

// Словарь форм для разбора названия блюда по словам.
function buildLexicon(words) {
  const lex = new Map();
  const put = (form, w) => {
    const n = norm(form);
    if (n && !lex.has(n)) lex.set(n, w);
  };
  // сначала слова из чата/меню — их переводы ближе к контексту
  const ordered = [...words].sort((a, b) => (a.src === "base") - (b.src === "base"));
  for (const w of ordered) {
    for (const v of w.pt.split(" / ")) put(v.replace(/^(o|a|os|as)\s+/i, ""), w);
    for (const a of w.alt) for (const v of a.split(" / ")) put(v.replace(/^(o|a|os|as)\s+/i, ""), w);
  }
  return lex;
}

export function menuTitle(m) {
  return [m.name, m.label].filter(Boolean).join(" · ");
}
