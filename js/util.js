// Общие утилиты: нормализация текста, HTML, озвучка, тосты.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// Без диакритики, в нижнем регистре, только буквы/цифры через пробел.
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

const ARTICLE = /^(o|a|os|as|um|uma)\s+/i;
export const stripArticle = (pt) => String(pt).replace(ARTICLE, "");

// Разбить «o bacalhau» на артикль и слово — для серого артикля в списке.
export function splitArticle(pt) {
  const m = String(pt).match(/^(o|a|os|as)\s+(.*)$/i);
  return m ? [m[1], m[2]] : ["", String(pt)];
}

export const sortKey = (pt) => norm(stripArticle(String(pt).split(" / ")[0]));

// Левенштейн с ранним выходом, если расстояние заведомо > max.
export function lev(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Подсветить вхождения нормализованных токенов в исходном тексте (с учётом диакритики).
export function highlight(text, tokens) {
  const src = String(text ?? "");
  if (!tokens?.length) return esc(src);
  // карта индексов: позиция в «плоской» строке без диакритики -> позиция в исходной
  let plain = "", map = [], srcIdx = 0;
  for (const ch of src) {
    const d = ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ё/g, "е");
    for (const c of d) { plain += c; map.push(srcIdx); }
    srcIdx += ch.length;
  }
  const marks = new Array(src.length).fill(false);
  for (const t of tokens) {
    if (t.length < 2) continue;
    let i = plain.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) marks[map[k]] = true;
      i = plain.indexOf(t, i + t.length);
    }
  }
  let out = "", open = false;
  for (let i = 0; i < src.length; i++) {
    if (marks[i] && !open) { out += "<mark>"; open = true; }
    if (!marks[i] && open) { out += "</mark>"; open = false; }
    out += esc(src[i]);
  }
  return out + (open ? "</mark>" : "");
}

// Озвучка португальского (работает офлайн, если в системе есть голос pt-PT).
let voice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => v.lang === "pt-PT") || vs.find((v) => v.lang?.startsWith("pt")) || null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}
export function speak(text, lang = "pt-PT") {
  if (!("speechSynthesis" in window)) return toast("Озвучка не поддерживается в этом браузере");
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text).replace(/\s*\/\s*/g, ", "));
  u.lang = lang;
  if (lang.startsWith("pt") && voice) u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
}

export const SPEAK_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4V9Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4Zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>`;
