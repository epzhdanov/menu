"""Собирает данные приложения:
  data/words.json      — словарь: базовая лексика (tools/base_words.txt) + всё из чата (tools/source/*)
  data/chat_menus.json — меню из чата «EN ⇄ PT Translator»
data/menus.json не трогается: туда приложение само дописывает новые меню через синхронизацию с GitHub.
Запуск: python3 tools/build_data.py
"""
import json, pathlib, re, sys, unicodedata
root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "tools/source"))
from ru import GLOSSARY, EXTRA_WORDS, DISHES  # noqa: E402

ARTICLES = re.compile(r"^(o|a|os|as|um|uma)\s+", re.I)

def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def key(pt):
    first = pt.split(" / ")[0]
    return norm(ARTICLES.sub("", first.strip()))

words, index = [], {}

def add(pt, ru, en, cat, src, alt=None):
    k = key(pt)
    if k in index:
        w = words[index[k]]
        if src == "chat":
            w["src"] = "chat"
            if ru: w["ru"] = ru
            if en: w["en"] = en
            if " / " in pt and " / " not in w["pt"]: w["pt"] = pt
        if alt: w.setdefault("alt", []).extend(a for a in alt if a not in w.get("alt", []))
        return
    index[k] = len(words)
    w = {"pt": pt, "ru": ru, "en": en, "cat": cat, "src": src}
    if alt: w["alt"] = alt
    words.append(w)

# 1. базовая лексика
cat = None
for line in (root / "tools/base_words.txt").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("# "): continue
    if line.startswith("## "): cat = line[3:].strip(); continue
    pt, ru, en = [p.strip() for p in line.split("|")]
    add(pt, ru, en, cat, "base")

# 2. глоссарий из чата
export = json.loads((root / "tools/source/chat_export.json").read_text(encoding="utf-8"))
for section, items in export["glossary"].items():
    for orig, en in items.items():
        if orig not in GLOSSARY:
            sys.exit(f"нет перевода для слова глоссария: {orig}")
        pt, ru, c = GLOSSARY[orig]
        alt = [orig] if norm(orig) != norm(pt) else None
        add(pt, ru, en, c, "chat", alt)
for pt, ru, en, c in EXTRA_WORDS:
    add(pt, ru, en, c, "chat")

(root / "data/words.json").write_text(json.dumps(words, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

# 3. меню из чата
def price(it):
    def f(x): return f"{x:.2f}".replace(".", ",")
    if it.get("price_range"): a, b = it["price_range"]; return f"{f(a)}–{f(b)} €"
    if it.get("price") is not None: return f"{f(it['price'])} €"
    return ""

NOTES = {"handwritten": "дописано от руки", "crossed out": "зачёркнуто в меню"}

def dish(it, section):
    pt = it["pt"].strip()
    if pt not in DISHES: sys.exit(f"нет перевода для блюда: {pt}")
    d = {"pt": pt, "ru": DISHES[pt], "en": it.get("en", ""), "section": section, "price": price(it)}
    if it.get("note") in NOTES: d["note"] = NOTES[it["note"]]
    return d

R = export["restaurants"]
menus = []
ob = R["os_baroes"]
SEC = {"fish_dishes": "Pratos de peixe", "meat_dishes": "Pratos de carne", "starters": "Entradas", "desserts": "Sobremesas"}
menus.append({
    "id": "chat-os-baroes", "name": ob["name"], "label": "постоянное меню", "kind": ob.get("type", ""),
    "website": ob.get("website", ""), "date": None, "src": "chat",
    "note": "Блюда дня меняются каждый день; рыба, мясо, закуски и десерты в основном постоянные. "
            "Другой гарнир оплачивается отдельно. Ничего, включая куверт, не могут посчитать, если вы это не заказывали и не трогали.",
    "dishes": [dish(it, SEC[s]) for s, items in ob["stable_sections"].items() for it in items],
})
for date, items in ob["daily_specials"].items():
    menus.append({"id": f"chat-os-baroes-{date}", "name": ob["name"], "label": "блюда дня", "kind": ob.get("type", ""),
                  "date": date, "src": "chat", "dishes": [dish(it, "Pratos do dia") for it in items]})
nc = R["news_cafe"]
SEC = {"sandwiches": "Sandes e tostas", "waters_and_juices": "Águas e sumos", "beer": "Cervejas"}
menus.append({"id": "chat-news-cafe", "name": nc["name"], "label": "кафе", "kind": nc.get("type", ""), "date": None, "src": "chat",
              "dishes": [dish(it, SEC[s]) for s, items in nc["sections"].items() for it in items]})
sf = R["unnamed_seafood_restaurant"]
SEC = {"soups": "Sopas", "fish": "Peixe", "grilled_fish": "Peixe grelhado", "seafood": "Marisco", "meat": "Carne", "steaks": "Bifes"}
menus.append({"id": "chat-seafood", "name": sf.get("name") or "Рыбный ресторан (без названия)", "label": "рыба и морепродукты",
              "date": None, "src": "chat", "note": "Ресторан подороже: рыба, морепродукты, мясо. НДС включён, есть книга жалоб.",
              "dishes": [dish(it, SEC[s]) for s, items in sf["sections"].items() for it in items]})
(root / "data/chat_menus.json").write_text(json.dumps(menus, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

print(f"words: {len(words)} (из чата: {sum(1 for w in words if w['src']=='chat')}), "
      f"menus: {len(menus)}, dishes: {sum(len(m['dishes']) for m in menus)}")
