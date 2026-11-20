// Нечёткий поиск по блюдам и словам + разбор названия блюда по словам (работает офлайн).
import { state } from "./data.js";
import { norm, lev } from "./util.js";

export const tokens = (q) => norm(q).split(" ").filter(Boolean);

function tokenScore(q, t) {
  if (t === q) return 3;
  if (q.length >= 2 && t.startsWith(q)) return 2.2;
  if (q.length >= 3 && t.includes(q)) return 1.5;
  if (q.length >= 4) {
    const max = q.length >= 7 ? 2 : 1;
    // сравниваем и с началом длинного слова: «bacalau» ~ «bacalhau»
    if (lev(q, t, max) <= max || (t.length > q.length && lev(q, t.slice(0, q.length + 1), max) <= max)) return 1.1;
  }
  return 0;
}

// Средний балл по токенам запроса; 0, если хоть один токен не нашёлся.
function textScore(qt, text) {
  if (!text) return 0;
  const tt = text.split(" ");
  let sum = 0;
  for (const q of qt) {
    let best = 0;
    for (const t of tt) {
      const s = tokenScore(q, t);
      if (s > best) best = s;
      if (best === 3) break;
    }
    if (!best) return 0;
    sum += best;
  }
  let score = sum / qt.length;
  const phrase = qt.join(" ");
  if (qt.length > 1 && text.includes(phrase)) score += 1;
  if (text.startsWith(qt[0])) score += 0.3;
  return score;
}

const scoreItem = (qt, it) => Math.max(textScore(qt, it.npt), textScore(qt, it.nru) * 0.95, textScore(qt, it.nen) * 0.8);

// Блюда группируются по ресторану и названию: одно блюдо дня за 14 дат — одна карточка со всеми датами.
export function searchDishes(q) {
  const qt = tokens(q);
  if (!qt.length) return [];
  const groups = new Map();
  for (const d of state.dishes) {
    const s = scoreItem(qt, d);
    if (!s) continue;
    const key = norm(d.menu.name) + "|" + d.npt;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { pt: d.pt, ru: d.ru, en: d.en, score: s, prices: new Set(), seen: [], notes: new Set() }));
    g.score = Math.max(g.score, s);
    if (d.price) g.prices.add(d.price);
    if (d.note) g.notes.add(d.note);
    g.seen.push(d.menu);
  }
  return dropFuzzy([...groups.values()]).sort((a, b) => b.score - a.score || b.seen.length - a.seen.length || a.pt.localeCompare(b.pt, "pt"));
}

// Если есть точные/префиксные совпадения — убираем совпадения «по опечатке» (prego ≠ preto).
const dropFuzzy = (arr) => (arr.some((x) => x.score >= 2) ? arr.filter((x) => x.score >= 1.5) : arr);

export function searchWords(q, limit = 20) {
  const qt = tokens(q);
  if (!qt.length) return [];
  return state.words
    .map((w) => ({ w, s: scoreItem(qt, w) }))
    .filter((x) => x.s)
    .map((x) => ({ ...x, score: x.s }))
    .filter((x, _, all) => !all.some((y) => y.score >= 2) || x.score >= 1.5)
    .sort((a, b) => b.s - a.s || a.w.k.localeCompare(b.w.k, "pt"))
    .slice(0, limit)
    .map((x) => x.w);
}

export function filterWords(q, cat) {
  const qt = tokens(q);
  return state.words.filter((w) => (!cat || w.cat === cat) && (!qt.length || scoreItem(qt, w) > 0));
}

// ——— Разбор по словам ———
const MINOR = {
  de: "из, с", do: "из (м.р.)", da: "из (ж.р.)", dos: "из", das: "из", com: "с", c: "с", e: "и", ou: "или",
  sem: "без", s: "без", em: "в", no: "в, на", na: "в, на", nos: "в", nas: "в", ao: "по-, с", aos: "с", a: "по-, в стиле",
  as: "", o: "", os: "", para: "для", por: "за, на",
};

function candidates(t) {
  const out = [t];
  const push = (x) => x && x.length > 1 && !out.includes(x) && out.push(x);
  // уменьшительные: carapauzinhos → carapau, douradinha → dourada, bifinhos → bife
  let m = t.match(/^(.+?)(zinh|inh)(o|a|os|as)$/);
  if (m) { push(m[1]); push(m[1] + "o"); push(m[1] + "a"); push(m[1] + "e"); }
  // множественное число
  if (t.endsWith("oes") || t.endsWith("aes")) push(t.slice(0, -3) + "ao");
  if (t.endsWith("ais")) push(t.slice(0, -3) + "al");
  if (t.endsWith("eis")) push(t.slice(0, -3) + "el");
  if (t.endsWith("ns")) push(t.slice(0, -2) + "m");
  if (t.endsWith("es")) push(t.slice(0, -2));
  if (t.endsWith("s")) push(t.slice(0, -1));
  // женский род → мужской: grelhada → grelhado, assadas → assado
  for (const x of [...out]) if (x.endsWith("a")) push(x.slice(0, -1) + "o");
  return out;
}

function lookup(phrase) {
  const lex = state.lexicon;
  if (lex.has(phrase)) return lex.get(phrase);
  const parts = phrase.split(" ");
  const last = parts.pop();
  for (const c of candidates(last)) {
    const key = [...parts, c].join(" ");
    if (lex.has(key)) return lex.get(key);
  }
  return null;
}

// Возвращает [{text, word|null, minor}] для исходного названия.
export function breakdown(name) {
  const raw = String(name).split(/[\s,;()/]+/).filter(Boolean);
  const normed = raw.map((r) => norm(r)).map((n) => n.replace(/ /g, ""));
  const out = [];
  let i = 0;
  while (i < raw.length) {
    let hit = null, len = 0;
    for (let n = Math.min(4, raw.length - i); n >= 1; n--) {
      const phrase = normed.slice(i, i + n).join(" ");
      if (!phrase) continue;
      if (n === 1 && phrase in MINOR) break;
      const w = lookup(phrase);
      if (w) { hit = w; len = n; break; }
    }
    if (hit) {
      out.push({ text: raw.slice(i, i + len).join(" "), word: hit });
      i += len;
    } else {
      const n = normed[i];
      if (n in MINOR) out.push({ text: raw[i], minor: MINOR[n] });
      else if (/^[\d.,€%lcm]+$/i.test(n) || !n) out.push({ text: raw[i], minor: "" });
      else out.push({ text: raw[i], word: null });
      i++;
    }
  }
  return out;
}
