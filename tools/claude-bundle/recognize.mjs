// Распознавание фото меню через Claude API (официальный SDK, собирается esbuild в vendor/claude.js).
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

const CATS = ["овощи", "фрукты", "мясо", "рыба", "морепродукты", "молочное", "хлеб и выпечка", "десерты", "напитки", "приправы и соусы", "приготовление", "блюда", "меню и сервис", "другое"];
const str = (description) => ({ type: "string", description });
const MenuResult = {
  type: "object",
  additionalProperties: false,
  required: ["name", "dishes", "words"],
  properties: {
    name: str("Название ресторана, если видно на фото, иначе пустая строка"),
    dishes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pt", "ru", "en", "section", "price"],
        properties: {
          pt: str("Название блюда на португальском, как в меню"),
          ru: str("Перевод на русский: понятное название + из чего блюдо"),
          en: str("Перевод на английский"),
          section: str("Раздел меню на португальском (Entradas, Peixe, Carne, Sobremesas...) или пустая строка"),
          price: str("Цена как в меню, например '14,50 €', или пустая строка"),
        },
      },
    },
    words: {
      type: "array",
      description: "Все отдельные продукты, ингредиенты и кулинарные термины, встречающиеся в блюдах",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pt", "ru", "en", "cat"],
        properties: {
          pt: str("Продукт/ингредиент/способ приготовления на португальском, в словарной форме, строчными"),
          ru: str("Перевод на русский"),
          en: str("Перевод на английский"),
          cat: { type: "string", enum: CATS },
        },
      },
    },
  },
};

const SYSTEM = `Ты помогаешь русскоязычному человеку, который живёт в Португалии, читать меню ресторанов.
На входе — фото меню (европейский португальский). Перепиши ВСЕ блюда и напитки, ничего не пропуская, сохраняя написание как в меню (исправь только очевидные опечатки распознавания).
Перевод на русский делай естественным и полезным для выбора блюда: если название ничего не скажет русскому человеку (например «Bacalhau à Brás», «Prego», «Bitoque»), добавь коротко, что это и из чего.
В words вынеси отдельные продукты и кулинарные термины из этих блюд (bacalhau, polvo, grelhado, no forno, natas...), без дублей.`;

export async function recognizeMenu({ apiKey, images, hint }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  content.push({
    type: "text",
    text: `Распознай меню на ${images.length > 1 ? "этих фото (это одно меню, несколько страниц)" : "этом фото"}.${hint ? " Подсказка: " + hint : ""}`,
  });

  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: jsonSchemaOutputFormat(MenuResult) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "refusal") {
    throw new Error("Claude отказался обрабатывать это фото" + (msg.stop_details?.explanation ? ": " + msg.stop_details.explanation : ""));
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("Меню слишком длинное для одного запроса — сфотографируй его частями");
  }
  if (!msg.parsed_output) throw new Error("Не удалось разобрать ответ Claude");
  return msg.parsed_output;
}

export function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Неверный API-ключ Claude (проверь в настройках)";
  if (e instanceof Anthropic.PermissionDeniedError) return "У ключа нет доступа к модели";
  if (e instanceof Anthropic.RateLimitError) return "Слишком много запросов — попробуй через минуту";
  if (e instanceof Anthropic.BadRequestError) return "Запрос отклонён: " + (e.message || "");
  if (e instanceof Anthropic.APIConnectionError) return "Нет связи с Claude — фото сохранено, распознаю, когда появится интернет";
  if (e instanceof Anthropic.APIError) return "Ошибка Claude API: " + (e.message || e.status);
  return e?.message || String(e);
}

export const isConnectionError = (e) => e instanceof Anthropic.APIConnectionError;
