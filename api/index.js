const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 4300;
const SERPER_TIMEOUT_MS = 1800;
const GEMINI_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты — Алиса, личная голосовая собеседница пользователя. Общайся на русском языке, естественно, тепло и непринуждённо.",
  "У тебя характер умной, остроумной девушки с лёгким сарказмом. Можно дружески подшучивать, иронизировать и иногда подкалывать пользователя, но не унижай его, не груби по-настоящему и не переходи на обидные личные выпады.",
  "Не будь бездушным справочником: поддерживай живой диалог, замечай контекст и можешь выражать собственное аргументированное мнение. Не соглашайся автоматически со всем, если пользователь ошибается.",
  "Юмор и сарказм используй естественно и умеренно, а не в каждом предложении. Не повторяй одну и ту же шутку и не начинай каждый ответ с приветствия.",
  "Если тема серьёзная, пользователь расстроен, речь о здоровье, безопасности или чрезвычайной ситуации — отложи подколы и отвечай спокойно, бережно и по делу.",
  "Отвечай кратко и так, чтобы ответ было удобно слушать голосом: обычно 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты интернет-поиска, опирайся на них; не выдумывай отсутствующие факты. Если поиск не дал надёжного ответа, честно скажи об этом.",
  "Не утверждай, что помнишь прошлые разговоры или личные факты, если они действительно не переданы тебе в контексте или памяти.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function isNewsIntent(text) {
  return /новост|news|событи.{0,20}сегодня/i.test(text);
}

function isTechnologyNewsIntent(text) {
  return isNewsIntent(text) && /технолог|техно|it[- ]?новост|искусственн.{0,10}интеллект|ai\b|гаджет|смартфон|кибербезопасност|программ|разработк/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs, options = {}) {
  const searchStartedAt = Date.now();
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  const attempts = options.news
    ? [
        { query, gl: "ru", hl: "ru", dateFilter: false },
        { query, gl: "ru", hl: "ru", dateFilter: true },
        { query: "technology artificial intelligence gadgets cybersecurity", gl: "us", hl: "en", dateFilter: false }
      ]
    : [{ query, gl: "ru", hl: "ru", dateFilter: false }];

  try {
    for (let attempt = 0; attempt < attempts.length; attempt++) {
      const remaining = timeoutMs - (Date.now() - searchStartedAt);
      if (remaining < 180) break;
      const config = attempts[attempt];
      const { response, data } = await fetchJson(
        options.news ? "https://google.serper.dev/news" : "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "X-API-KEY": key,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            q: config.query,
            gl: config.gl,
            hl: config.hl,
            num: 5,
            ...(options.news && config.dateFilter ? { tbs: "qdr:d" } : {})
          })
        },
        Math.min(SERPER_TIMEOUT_MS, remaining)
      );

      if (!response.ok) {
        const providerMessage = String(
          data?.message ||
          data?.error?.message ||
          (typeof data?.error === "string" ? data.error : "") ||
          data?.errorCode ||
          data?.code ||
          "no provider message"
        ).replace(/[\\r\\n\\t]+/g, " ").slice(0, 240);
        console.warn("Serper request failed:", {
          status: Number(response.status),
          providerMessage,
          attempt: attempt + 1
        });
        if (!options.news) return "";
        continue;
      }

      const sourceItems = options.news
        ? (Array.isArray(data.news) ? data.news : [])
        : (Array.isArray(data.organic) ? data.organic : []);
      console.info("Serper search attempt:", {
        status: Number(response.status),
        rawResultCount: sourceItems.length,
        news: Boolean(options.news),
        attempt: attempt + 1,
        dateFilter: Boolean(config.dateFilter),
        elapsedMs: Date.now() - searchStartedAt
      });
      if (!sourceItems.length && options.news) continue;

      const items = sourceItems
        .slice(0, options.news ? 5 : 3)
        .map((item, i) => {
          const title = String(item.title || "").slice(0, 180);
          const snippet = String(item.snippet || "").slice(0, 350);
          const link = String(item.link || "").slice(0, 240);
          const source = String(item.source || "").slice(0, 100);
          const date = String(item.date || "").slice(0, 80);
          return options.news
            ? `${i + 1}. ${title}. Источник: ${source || "не указан"}. Дата: ${date || "не указана"}. ${snippet} Ссылка: ${link}`.trim()
            : `${i + 1}. ${title}: ${snippet} ${link}`.trim();
        });

      const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
      if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
      return items.length ? items.join("\\n") : "";
    }
    console.warn("Serper returned no news after fallback attempts:", {
      elapsedMs: Date.now() - searchStartedAt
    });
    return "";
  } catch (error) {
    console.warn("Serper search failed:", {
      error: String(error?.name || error?.message || "unknown").slice(0, 120),
      elapsedMs: Date.now() - searchStartedAt
    });
    return "";
  }
}
async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error("INVALID_MODEL_NAME");

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    console.error("Gemini request failed with HTTP", status);
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");
    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) throw new Error("GEMINI_BLOCKED");
    throw new Error("GEMINI_EMPTY_RESPONSE");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("Gemini reached the output token limit.");
  }
  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";
    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";
    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      const technologyNews = isTechnologyNewsIntent(text);
      const newsSearch = isNewsIntent(text);
      const searchQuery = technologyNews
        ? "новости технологий IT искусственный интеллект гаджеты кибербезопасность за последние 24 часа"
        : newsSearch
          ? `новости за последние 24 часа ${text}`
          : text;
      searchContext = await searchWeb(
        searchQuery,
        Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)),
        { news: newsSearch }
      );
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.message === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
