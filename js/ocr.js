// Распознавание фото меню прямо на телефоне — без интернета.
// Tesseract (португальская модель) читает текст, затем строки разбираются на блюда/цены/разделы,
// а перевод берётся из уже знакомых блюд или собирается по словам из словаря.
import { state } from "./data.js";
import { breakdown } from "./search.js";
import { norm, lev, lsGet, lsSet } from "./util.js";

const BASE = new URL("../vendor/ocr/", import.meta.url).href;
const F = { worker: "worker.min.js", simd: "tesseract-core-simd-lstm.wasm.js", plain: "tesseract-core-lstm.wasm.js", lang: "por.traineddata.gz" };
const READY_KEY = "ocr.ready.v1";
const OCR_CACHE = "menu-ocr";

// Проверка поддержки WASM SIMD (байты из wasm-feature-detect).
function simd() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}
const coreFile = () => (simd() ? F.simd : F.plain);

// Файлы берём через fetch страницы (их отдаёт офлайн-кеш service worker) и запускаем из blob:,
// чтобы воркеру не нужна была сеть.
async function blobURL(file) {
  const r = await fetch(BASE + file);
  if (!r.ok) throw new Error(`Нет файла распознавания ${file}`);
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: "application/javascript" }));
}

let workerP = null;
let progressCb = null;

async function getWorker() {
  if (workerP) return workerP;
  workerP = (async () => {
    const { default: Tesseract } = await import("../vendor/ocr/tesseract.esm.min.js");
    const [workerPath, coreURL] = await Promise.all([blobURL(F.worker), blobURL(coreFile())]);
    const w = await Tesseract.createWorker("por", Tesseract.OEM.LSTM_ONLY, {
      workerPath,
      workerBlobURL: false,
      corePath: coreURL + "#tesseract-core.wasm.js", // окончание .js — чтобы Tesseract взял именно этот файл
      langPath: BASE.replace(/\/$/, ""),
      gzip: true,
      cacheMethod: "write", // модель сохраняется в IndexedDB
      logger: (m) => progressCb?.(m),
    });
    await w.setParameters({ preserve_interword_spaces: "1" });
    lsSet(READY_KEY, true);
    return w;
  })();
  workerP.catch(() => { workerP = null; });
  return workerP;
}

export async function ocrStatus() {
  if (!lsGet(READY_KEY, false)) return "missing";
  try {
    const c = await caches.open(OCR_CACHE);
    const hits = await Promise.all([F.worker, coreFile(), F.lang, "tesseract.esm.min.js"].map((f) => c.match(BASE + f)));
    return hits.every(Boolean) ? "ready" : "missing";
  } catch {
    return "ready";
  }
}

// Один раз (с интернетом) скачать и прогреть распознавание, чтобы потом оно работало офлайн.
let warming = null;
export function warmUp() {
  if (warming) return warming;
  warming = (async () => {
    if ((await ocrStatus()) === "ready") return true;
    if (!navigator.onLine) return false;
    await Promise.all([F.worker, coreFile(), F.lang, "tesseract.esm.min.js"].map((f) => fetch(BASE + f)));
    const w = await getWorker();
    await w.terminate();
    workerP = null;
    return true;
  })().catch(() => false).finally(() => setTimeout(() => (warming = null), 0));
  return warming;
}

// ——— Подготовка фото: оттенки серого + растяжение контраста ———
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const long = Math.max(bmp.width, bmp.height);
  const k = long > 2400 ? 2400 / long : long < 1400 ? 1400 / long : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g;
    hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  acc = 0;
  for (; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ——— Разбор строк меню ———
const SECTION = /^(entradas?|petiscos?|sopas?|saladas?|peixes?|pratos?|carnes?|mariscos?|marisqueira|grelhados?|sobremesas?|doces|bebidas?|vinhos?|cervejas?|cafetaria|cafes?|sugest|especialidad|acompanhamentos?|guarni|sandes|tostas?|pequeno|menu|ementa|vegetarian|massas?|pizzas?|hamburguer|aguas?|sumos?|refrigerantes?|digestivos?|licores?|aperitivos?|couvert|bifes?|omeletes?|do dia|frutas?)/;
const EURO_PRICE = /(?:€\s*(\d{1,3}(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:€|eur(?:os?)?))\s*$/i;
const DEC_PRICE = /(?:^|\s)(\d{1,3}[.,]\d{2})\s*$/;

function cleanLine(s) {
  return s
    .replace(/[|]/g, " ")
    .replace(/[.·•…_~=-]{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function splitPrice(line) {
  const m = line.match(EURO_PRICE) || line.match(DEC_PRICE);
  if (!m) return { text: line, price: "" };
  const raw = (m[1] || m[2] || "").replace(".", ",");
  const [eu, ct = ""] = raw.split(",");
  const price = `${+eu},${(ct + "00").slice(0, 2)} €`;
  return { text: line.slice(0, m.index).replace(/[\s.:€-]+$/, "").trim(), price };
}

const letters = (s) => (s.match(/[a-zà-ÿ]/gi) || []).length;

function isSection(text) {
  const n = norm(text);
  const words = n.split(" ").filter(Boolean);
  if (!words.length || words.length > 4) return false;
  const upper = (text.match(/[A-ZÀ-Þ]/g) || []).length / Math.max(1, letters(text));
  return SECTION.test(n) || (upper > 0.8 && text.length <= 30);
}

// Словарь форм для исправления неуверенно распознанных слов: из словаря и из названий знакомых блюд.
let forms = null;
const fuzzyCache = new Map();
function getForms() {
  if (forms && forms.lex === state.lexicon) return forms;
  forms = new Map();
  forms.lex = state.lexicon;
  fuzzyCache.clear();
  const add = (w) => { const n = norm(w); if (n.length >= 4 && !n.includes(" ") && !forms.has(n)) forms.set(n, w.toLowerCase()); };
  for (const w of state.words) for (const v of [w.pt, ...(w.alt || [])]) v.split(/[\s/]+/).forEach((t) => /^[a-zà-ÿ-]+$/i.test(t) && add(t));
  for (const d of state.dishes) d.pt.split(/[\s,;()/]+/).forEach((t) => /^[a-zà-ÿ-]+$/i.test(t) && add(t));
  return forms;
}
function fuzzyForm(token) {
  const n = norm(token).replace(/ /g, "");
  if (n.length < 5) return null;
  const f = getForms();
  if (fuzzyCache.has(n)) return fuzzyCache.get(n);
  let best = f.get(n) || null;
  if (!best) {
    const max = n.length >= 8 ? 2 : 1;
    let bd = max + 1;
    for (const [k, v] of f) {
      if (Math.abs(k.length - n.length) > max) continue;
      const d = lev(n, k, max);
      if (d < bd) { bd = d; best = v; if (d === 1 && max === 1) break; }
    }
  }
  fuzzyCache.set(n, best);
  return best;
}
const keepCase = (orig, fixed) => (/^[A-ZÀ-Þ]/.test(orig) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed);
// цена: цифры (O/o/l/I — частые ошибки распознавания вместо 0/1) и знак евро
const PRICE_TOKEN = /^(€?(?=[\dOoIl]*\d)[\dOoIl]{1,3}([.,][\dOoIl]{1,2})?€?|€|eur(os?)?)$/i;
const fixDigits = (t) => t.replace(/[Oo]/g, "0").replace(/[Il]/g, "1");

// Короткие служебные слова, которые бывают в названиях блюд.
const FUNC = new Set(["e", "a", "o", "as", "os", "de", "da", "do", "das", "dos", "na", "no", "em", "ao", "aos", "ou", "com", "sem", "c", "s", "para", "por", "1", "2"]);

// Строка из слов Tesseract. Отточия между названием и ценой распознаются как случайные буквы
// с низкой уверенностью, поэтому название — это начало строки, пока слова «настоящие»:
// уверенные, служебные или похожие на слово из словаря (тогда исправляем написание).
function lineFromWords(words) {
  const ws = words.map((w) => ({ t: (w.text || "").trim(), c: w.confidence ?? 100 })).filter((w) => w.t);
  let end = ws.length;
  while (end > 0 && PRICE_TOKEN.test(ws[end - 1].t)) end--;
  const price = fixDigits(ws.slice(end).map((w) => w.t).join(" "));
  const name = ws.slice(0, end);
  // все слова распознаны уверенно — мусора нет, берём строку как есть
  if (name.length && name.every((w) => w.c >= 70)) return [...name.map((w) => w.t), price].filter(Boolean).join(" ");
  const isAlpha = (t) => /^[A-Za-zÀ-ÿ'’-]+$/.test(t);
  const coreOf = (t) => t.replace(/[.,:;!]+$/, "");
  // слово «настоящее»? → исправленный текст или null
  const accept = (j) => {
    const w = name[j];
    if (!w) return null;
    const core = coreOf(w.t), tail = w.t.slice(core.length);
    if (core.length <= 2 || /^[cs]\/$/i.test(core)) return null;
    const f = getForms();
    const n = norm(core).replace(/ /g, "");
    if (w.c >= 70) {
      // уверенно, но слова нет в словаре и есть очень похожее (Erango → Frango)
      if (isAlpha(core) && n.length >= 6 && !f.has(n)) { const fix = fuzzyForm(core); if (fix && lev(n, norm(fix), 1) <= 1) return keepCase(core, fix) + tail; }
      return w.t;
    }
    const fix = isAlpha(core) ? fuzzyForm(core) : null;
    return fix ? keepCase(core, fix) + tail : null;
  };
  let i = name.findIndex((w) => w.c >= 70 && w.t.replace(/[^A-Za-zÀ-ÿ]/g, "").length >= 3);
  if (i < 0) return price;
  const kept = [];
  while (i < name.length) {
    const { t, c } = name[i];
    const core = coreOf(t);
    // слово, разорванное пробелом: «bac alhau» → «bacalhau»
    const nCore = norm(core).replace(/ /g, "");
    const nNext = name[i + 1] ? norm(coreOf(name[i + 1].t)).replace(/ /g, "") : "";
    if (core.length <= 4 && !FUNC.has(nCore) && isAlpha(core) && name[i + 1] && isAlpha(coreOf(name[i + 1].t)) && !getForms().has(nNext)) {
      const joined = core + coreOf(name[i + 1].t);
      const fix = joined.length >= 6 && fuzzyForm(joined);
      if (fix && !getForms().has(nCore)) { kept.push(keepCase(core, fix) + name[i + 1].t.slice(coreOf(name[i + 1].t).length)); i += 2; continue; }
    }
    const n = norm(core).replace(/ /g, "");
    if (core.length <= 2 || /^[cs]\/$/i.test(core)) {
      // служебное слово берём, только если за ним идёт настоящее слово
      if (FUNC.has(n) && c >= 40 && accept(i + 1) !== null) { kept.push(t); i++; continue; }
      break;
    }
    const ok = accept(i);
    if (ok === null) break;
    kept.push(ok);
    i++;
  }
  while (kept.length && FUNC.has(norm(kept.at(-1)).replace(/ /g, ""))) kept.pop();
  return [...kept, price].filter(Boolean).join(" ");
}

export function parseMenu(lines) {
  const out = [];
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const { text: rawText, words } = lines[i];
    const line = cleanLine(words?.length ? lineFromWords(words) : rawText);
    if (!line) continue;
    const { text, price } = splitPrice(line);
    const nl = letters(text);
    // строка только с ценой — отдаём предыдущему блюду
    if (price && nl < 2) {
      const prev = out.at(-1);
      if (prev && !prev.price) prev.price = price;
      continue;
    }
    if (nl < 3 || nl / text.replace(/\s/g, "").length < 0.55) continue; // мусор распознавания
    if (!price && isSection(text)) {
      // крупная надпись до первого блюда, не похожая на раздел — скорее всего название заведения
      if (!out.length && !out.title && !SECTION.test(norm(text))) { out.title = text; continue; }
      section = text.length > 2 ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text;
      continue;
    }
    const prev = out.at(-1);
    // продолжение предыдущей строки (описание с маленькой буквы)
    if (prev && !prev.price && /^[a-zà-ÿ(]/.test(text)) {
      prev.pt += " " + text;
      if (price) prev.price = price;
      continue;
    }
    out.push({ pt: text, price, section });
  }
  return out;
}

// ——— Перевод без интернета ———
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const x of a) {
    const j = b.findIndex((y, k) => !used.has(k) && (x === y || (x.length >= 6 && y.length >= 6 && lev(x, y, 1) <= 1)));
    if (j >= 0) { used.add(j); hit++; }
  }
  return (2 * hit) / (a.length + b.length);
}

function knownDish(pt) {
  const n = norm(pt);
  const nt = n.split(" ");
  let best = null, bestS = 0;
  for (const d of state.dishes) {
    if (!d.ru) continue;
    if (d.npt === n) return d;
    const s = dice(nt, d.npt.split(" "));
    if (s > bestS) { bestS = s; best = d; }
  }
  return bestS >= 0.85 ? best : null;
}

const short = (s) => {
  let t = String(s || "").split(/ — |:|\(|;| \/ /)[0].trim();
  if (t.length > 28 && t.includes(",")) t = t.split(",")[0].trim();
  return t;
};
const MINOR_RU = { c: "с", com: "с", e: "и", sem: "без", s: "без", ou: "или", de: "·", do: "·", da: "·", dos: "·", das: "·", no: "в", na: "в", em: "в", para: "для", por: "за" };
const MINOR_EN = { c: "with", com: "with", e: "and", sem: "without", s: "without", ou: "or", de: "·", do: "·", da: "·", dos: "·", das: "·", no: "in", na: "in", em: "in", para: "for", por: "per" };

function gloss(pt) {
  const parts = breakdown(pt);
  const ru = [], en = [];
  let unknown = 0;
  for (const p of parts) {
    const n = norm(p.text).replace(/ /g, "");
    if (p.word) {
      // у блюд оставляем полное описание («битоке — небольшой стейк…»), у отдельных слов — краткое
      const dish = p.word.cat === "блюда" || p.text.trim().includes(" ");
      ru.push(dish ? p.word.ru : short(p.word.ru));
      en.push(dish ? p.word.en : short(p.word.en));
    }
    else if (p.minor !== undefined) {
      if (n in MINOR_RU) { ru.push(MINOR_RU[n]); en.push(MINOR_EN[n]); }
      else if (/\d/.test(p.text)) { ru.push(p.text); en.push(p.text); }
    } else { unknown++; ru.push(p.text + "?"); en.push(p.text + "?"); }
  }
  const tidy = (arr) => arr.filter(Boolean).join(" ").replace(/(\s·)+\s*$/, "").replace(/^\s*·\s*/, "").replace(/\s+/g, " ").trim();
  return { ru: tidy(ru), en: tidy(en), unknown };
}

export function translateDish(d) {
  const k = knownDish(d.pt);
  if (k) return { ...d, ru: k.ru, en: k.en, how: "known" };
  const g = gloss(d.pt);
  return { ...d, ru: g.ru, en: g.en, how: g.unknown ? "partial" : "words", unknown: g.unknown };
}

// ——— Главная функция ———
export async function recognizeOffline(blobs, onProgress) {
  const total = blobs.length;
  let page = 0;
  progressCb = (m) => {
    const label = { "loading tesseract core": "загружаю распознавание", "loading language traineddata": "загружаю португальский", "initializing api": "готовлю распознавание", "recognizing text": "читаю текст" }[m.status];
    if (label) onProgress?.(label, m.status === "recognizing text" ? (page + (m.progress || 0)) / total : null);
  };
  const w = await getWorker();
  const lines = [];
  const rawPages = [];
  for (const b of blobs) {
    onProgress?.("подготавливаю фото", page / total);
    const canvas = await prepare(b);
    const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
    rawPages.push(data.text || "");
    const fromBlocks = [];
    for (const bl of data.blocks || []) for (const pa of bl.paragraphs || []) for (const li of pa.lines || []) fromBlocks.push({ text: li.text || "", words: li.words || [] });
    lines.push(...(fromBlocks.length ? fromBlocks : (data.text || "").split("\n").map((t) => ({ text: t }))));
    page++;
  }
  progressCb = null;
  const parsed = parseMenu(lines);
  const title = parsed.title ? parsed.title.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Do|Da|De|Dos|Das|E)\b/g, (w) => w.toLowerCase()) : "";
  return { dishes: parsed.map(translateDish), title, rawText: rawPages.join("\n\n———\n\n") };
}
