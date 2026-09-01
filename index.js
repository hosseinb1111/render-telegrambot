import express from "express";

// ============================================================
// CONFIG
// ============================================================

const TG_BASE = "https://api.telegram.org";
const OR_URL = "https://openrouter.ai/api/v1/chat/completions";
const LANGSEARCH_URL = "https://api.langsearch.com/v1/web-search";

const TEXT_MODEL = process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7:free";
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "openrouter/free";
const FILE_MODEL = process.env.OPENROUTER_FILE_MODEL || "openrouter/free";
const FAST_MODEL = process.env.OPENROUTER_FAST_MODEL || TEXT_MODEL;
const DEEP_MODEL = process.env.OPENROUTER_DEEP_MODEL || TEXT_MODEL;

const PORT = Number(process.env.PORT || 3000);

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const WEBHOOK_PATH_TOKEN = process.env.WEBHOOK_PATH_TOKEN || "";

const WEBHOOK_PATH = WEBHOOK_PATH_TOKEN
  ? `/webhook/${encodeURIComponent(WEBHOOK_PATH_TOKEN)}`
  : "/__missing_webhook_path__";

const BOT_USERNAME = String(process.env.BOT_USERNAME || "").replace(/^@/, "");
const TRIGGER = String(process.env.TRIGGER_COMMAND || "!ai").trim();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful AI assistant. Answer accurately, clearly, naturally, and concisely.";

const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY || "";
const GUEST_SECRET = process.env.GUEST_API_SECRET || "";

const HISTORY_PAIRS = clampInt(
  process.env.HISTORY_PAIRS,
  4,
  1,
  20
);

const MAX_SEARCHES = clampInt(
  process.env.MAX_SEARCHES,
  3,
  1,
  5
);

const MAX_TOOL_ROUNDS = clampInt(
  process.env.MAX_TOOL_ROUNDS,
  4,
  1,
  6
);

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_FILE_CHARS = 50000;

const TG_LIMIT = 4096;
const SAFE_STREAM_LIMIT = 3800;

const FETCH_TIMEOUT_MS = 30000;
const STREAM_FETCH_TIMEOUT_MS = 120000;

const TG_RETRY_MAX = 2;
const UPDATE_TTL_SECONDS = 300;

const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

let botId = null;
let botUsernameRuntime = BOT_USERNAME;

// ============================================================
// STATE / MEMORY
// ============================================================

const mem = new Map();
const prefs = new Map();
const generationLocks = new Map();
const lastReactions = new Map();

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function memGet(key) {
  const item = mem.get(key);

  if (!item) {
    return null;
  }

  if (item.expires && Date.now() > item.expires) {
    mem.delete(key);
    return null;
  }

  return item.value;
}

function memSet(key, value, ttlSeconds = 0) {
  mem.set(key, {
    value,
    expires: ttlSeconds
      ? Date.now() + ttlSeconds * 1000
      : 0,
  });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, item] of mem) {
    if (item.expires && now > item.expires) {
      mem.delete(key);
    }
  }

  for (const [key, item] of lastReactions) {
    if (now - item.at > 30 * 60 * 1000) {
      lastReactions.delete(key);
    }
  }
}, 300000);

cleanupTimer.unref?.();

function setPref(userId, key, value) {
  const id = String(userId);
  const p = prefs.get(id) || {};

  p[key] = String(value).slice(0, 300);

  prefs.set(id, p);
}

function getPref(userId, key) {
  return prefs.get(String(userId))?.[key];
}

async function getHistory(userId) {
  const raw = memGet(`history:${userId}`);

  if (!raw) {
    return [];
  }

  try {
    const parsed = Array.isArray(raw)
      ? raw
      : JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (message) =>
          message &&
          (message.role === "user" ||
            message.role === "assistant") &&
          typeof message.content !== "undefined"
      )
      .slice(-HISTORY_PAIRS * 2);
  } catch {
    mem.delete(`history:${userId}`);
    return [];
  }
}

async function saveHistory(userId, prompt, answer) {
  const history = await getHistory(userId);

  history.push({
    role: "user",
    content: String(prompt || "").slice(0, 12000),
  });

  history.push({
    role: "assistant",
    content: String(answer || "").slice(0, 24000),
  });

  memSet(
    `history:${userId}`,
    history.slice(-HISTORY_PAIRS * 2)
  );
}

async function runSerialized(key, task) {
  const previous = generationLocks.get(key) || Promise.resolve();

  const current = previous
    .catch(() => {})
    .then(task);

  generationLocks.set(key, current);

  try {
    return await current;
  } finally {
    if (generationLocks.get(key) === current) {
      generationLocks.delete(key);
    }
  }
}

// ============================================================
// METRICS
// ============================================================

const stats = {
  started: Date.now(),
  requests: 0,
  errors: 0,
  searches: 0,
  images: 0,
  files: 0,
  firstTokenMs: [],
  totalMs: [],
};

function recordMetric(list, value, max = 500) {
  if (!Number.isFinite(value)) {
    return;
  }

  list.push(
    Math.max(0, Math.round(value))
  );

  if (list.length > max) {
    list.splice(0, list.length - max);
  }
}

function avg(values) {
  if (!values.length) {
    return 0;
  }

  return Math.round(
    values.reduce((sum, n) => sum + n, 0) /
      values.length
  );
}

function statusText(isAdmin = false) {
  const uptime = Math.floor(
    (Date.now() - stats.started) / 1000
  );

  const lines = [
    "🤖 *Bot Status*",
    "",
    `Uptime: ${uptime}s`,
    `Requests: ${stats.requests}`,
    `Errors: ${stats.errors}`,
    `Searches: ${stats.searches}`,
    `Images: ${stats.images}`,
    `Files: ${stats.files}`,
    `Avg first token: ${avg(stats.firstTokenMs)}ms`,
    `Avg total: ${avg(stats.totalMs)}ms`,
    `Search configured: ${LANGSEARCH_KEY ? "yes" : "no"}`,
  ];

  if (isAdmin) {
    lines.push(
      "",
      `Text: \`${esc(TEXT_MODEL)}\``,
      `Fast: \`${esc(FAST_MODEL)}\``,
      `Deep: \`${esc(DEEP_MODEL)}\``,
      `Vision: \`${esc(VISION_MODEL)}\``,
      `File: \`${esc(FILE_MODEL)}\``,
      `History: ${HISTORY_PAIRS} pairs`,
      `Max searches/request: ${MAX_SEARCHES}`
    );
  }

  return lines.join("\n");
}

// ============================================================
// SMART LOCAL REACTIONS
// ============================================================

const RX = [
  "👍",
  "👎",
  "❤️",
  "🔥",
  "😂",
  "😢",
  "😡",
  "🤔",
  "😮",
  "🎉",
  "💯",
  "👀",
  "🧠",
  "🙏",
  "👏",
  "💡",
  "💔",
  "🤝",
  "🚀",
  "✨",
  "😎",
  "😭",
  "🥰",
  "😴",
  "🤯",
  "🧐",
];

const RX_PATTERNS = {
  love: /love|adorable|beautiful|cute|sweet|❤️|😍|🥰|عاشق|عشق|قشنگ|ناز|دوست دارم/i,

  praise: /good job|well done|nice job|great job|awesome|amazing|excellent|perfect|thank you|thanks|ممنون|مرسی|دمت گرم|عالی|فوق.?العاده/i,

  hype: /excited|can't wait|lets go|let's go|insane|huge|🔥|بزن بریم|هیجان/i,

  sad: /sad|depressed|crying|heartbroken|lost|miss|upset|disappointed|😭|😢|غمگین|ناراحتم|گریه|دلتنگ|ناامید/i,

  angry: /angry|furious|pissed|hate|wtf|bullshit|😡|🤬|عصبانی|اعصابم|لعنت|مزخرف|افتضاح/i,

  funny: /lol|lmao|rofl|haha+|hehe+|funny|joke|😂|🤣|خنده|جوک|باحال/i,

  surprise: /no way|really\?|seriously\?|unbelievable|shocking|🤯|😮|جدی؟|واقعا؟|چی؟|باورم نمیشه/i,

  help: /help|can you|could you|please|how do i|how can i|show me|fix this|teach me|کمک|میشه|میتونی|لطفا|چطور|چجوری|درستش کن/i,

  code: /code|coding|program|programming|developer|debug|bug|error|exception|javascript|typescript|python|java|react|node|html|css|api|sql|github|git|docker|kubernetes|cloudflare|render|webhook|کد|برنامه.?نویسی|باگ|خطا|پایتون|جاوااسکریپت/i,

  science: /physics|chemistry|biology|quantum|science|math|mathematics|space|black hole|genetics|فیزیک|شیمی|زیست|علم|کوانتوم|ریاضی|فضا/i,

  money: /money|price|cost|budget|stock|crypto|bitcoin|ethereum|dollar|euro|forex|invest|business|salary|profit|قیمت|پول|سهام|کریپتو|بیت.?کوین|دلار|یورو|سرمایه|کسب.?و.?کار|حقوق/i,

  news: /latest|breaking|news|today|recent|current|what happened|update|election|president|war|اخبار|امروز|جدیدترین|آخرین|جنگ|انتخابات|خبر جدید/i,

  travel: /travel|trip|flight|hotel|vacation|tourist|tourism|visa|airport|passport|سفر|پرواز|هتل|تعطیلات|ویزا|فرودگاه|پاسپورت/i,

  food: /food|cook|cooking|recipe|restaurant|dinner|lunch|breakfast|pizza|burger|coffee|tea|غذا|آشپزی|دستور.?غذا|رستوران|پیتزا|برگر|قهوه|چای/i,

  relationship: /relationship|girlfriend|boyfriend|wife|husband|crush|date|love|breakup|friendship|رابطه|دوست.?دختر|دوست.?پسر|همسر|عشق|جدایی|کراش|دوستی/i,
};

function reactionScores(text, image) {
  const input = String(text || "").trim();

  const score = Object.fromEntries(
    RX.map((emoji) => [emoji, 0])
  );

  const hit = (name) =>
    RX_PATTERNS[name].test(input)
      ? 1
      : 0;

  // Strong emotional signals intentionally dominate
  // topic-based signals.
  if (/😂|🤣|haha+|lol|lmao/i.test(input)) {
    score["😂"] += 30;
  }

  if (/😭|😢|sad|depressed|غمگین|ناراحت|گریه/i.test(input)) {
    score["😢"] += 30;
  }

  if (/😡|🤬|angry|furious|عصبانی|اعصابم/i.test(input)) {
    score["😡"] += 30;
  }

  if (/❤️|😍|🥰|love|عشق/i.test(input)) {
    score["❤️"] += 28;
  }

  if (/🤯|😮|😲|no way|جدی؟|واقعا؟/i.test(input)) {
    score["😮"] += 26;
  }

  score["❤️"] += hit("love") * 7;

  score["💯"] += hit("praise") * 5;
  score["👏"] += hit("praise") * 3;

  score["🔥"] += hit("hype") * 6;
  score["🚀"] += hit("hype") * 2;

  score["😢"] += hit("sad") * 8;
  score["😭"] += hit("sad") * 3;

  score["😡"] += hit("angry") * 8;

  score["😂"] += hit("funny") * 8;

  score["😮"] += hit("surprise") * 7;

  score["🤔"] += hit("help") * 4;

  score["💡"] += hit("code") * 4;
  score["🧠"] += hit("code") * 3;

  score["🧠"] += hit("science") * 5;
  score["💡"] += hit("science") * 2;

  score["🧐"] += hit("money") * 5;
  score["💯"] += hit("money") * 2;

  score["🧐"] += hit("news") * 6;
  score["👀"] += hit("news") * 2;

  score["✨"] += hit("travel") * 5;
  score["👀"] += hit("travel") * 2;

  score["❤️"] += hit("food") * 3;

  score["❤️"] += hit("relationship") * 5;
  score["💔"] += hit("relationship") * 3;

  if (/[?؟]/.test(input)) {
    score["🤔"] += 4;
  }

  if (/[!！]{2,}/.test(input)) {
    score["🔥"] += 3;
  }

  if (image) {
    score["👀"] += 7;
  }

  if (!input && image) {
    score["👀"] += 12;
  }

  return score;
}

function chooseReaction(text, image = false, chatKey = "") {
  const scores = reactionScores(text, image);

  const ordered = RX
    .map((emoji, index) => ({
      emoji,
      score: scores[emoji] || 0,
      index,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.index - b.index
    );

  const previous =
    lastReactions.get(String(chatKey))?.emoji;

  let selected =
    ordered[0]?.emoji || "👍";

  if (
    previous &&
    selected === previous &&
    ordered[1] &&
    ordered[1].score >=
      Math.max(1, ordered[0].score - 3)
  ) {
    selected = ordered[1].emoji;
  }

  lastReactions.set(String(chatKey), {
    emoji: selected,
    at: Date.now(),
  });

  return selected;
}

// ============================================================
// TELEGRAM HTTP
// ============================================================

function tgUrl(method) {
  return `${TG_BASE}/bot${BOT_TOKEN}/${method}`;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function tg(method, body, options = {}) {
  if (!BOT_TOKEN) {
    return {
      ok: false,
      description: "BOT_TOKEN is not configured",
    };
  }

  const maxAttempts = Number.isFinite(
    options.maxAttempts
  )
    ? options.maxAttempts
    : TG_RETRY_MAX;

  let last = {
    ok: false,
    description: "Telegram request failed",
  };

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(
        tgUrl(method),
        {
          method: "POST",

          headers: {
            "content-type": "application/json",
          },

          body: JSON.stringify(body),

          signal: AbortSignal.timeout(
            options.timeoutMs ||
              FETCH_TIMEOUT_MS
          ),
        }
      );

      const raw = await response.text();

      const data =
        parseJsonSafely(raw) || {
          ok: false,
          description: raw.slice(0, 1000),
        };

      last = data;

      if (response.ok && data.ok) {
        return data;
      }

      const retryAfter = Number(
        data?.parameters?.retry_after || 0
      );

      const serverRetry =
        response.status >= 500 &&
        response.status <= 599;

      const canRetry =
        attempt < maxAttempts &&
        (retryAfter > 0 || serverRetry);

      if (!canRetry) {
        return data;
      }

      const delay =
        retryAfter > 0
          ? Math.min(
              retryAfter * 1000,
              10000
            )
          : Math.min(
              500 * 2 ** attempt,
              3000
            );

      await sleep(delay);
    } catch (error) {
      last = {
        ok: false,
        description:
          error instanceof Error
            ? error.message
            : String(error),
      };

      if (attempt >= maxAttempts) {
        break;
      }

      await sleep(
        Math.min(
          500 * 2 ** attempt,
          3000
        )
      );
    }
  }

  return last;
}

async function sendMessage(chatId, text, replyTo) {
  const body = {
    chat_id: chatId,
    text: String(text || "").slice(
      0,
      SAFE_STREAM_LIMIT
    ),
  };

  if (replyTo) {
    body.reply_parameters = {
      message_id: replyTo,
    };
  }

  const richBody = {
    ...body,
    parse_mode: "Markdown",
  };

  let result = await tg(
    "sendMessage",
    richBody
  );

  if (!result.ok) {
    result = await tg(
      "sendMessage",
      body
    );
  }

  return result;
}

async function sendPlain(chatId, text, replyTo) {
  const body = {
    chat_id: chatId,
    text: String(text || "").slice(
      0,
      SAFE_STREAM_LIMIT
    ),
  };

  if (replyTo) {
    body.reply_parameters = {
      message_id: replyTo,
    };
  }

  return tg("sendMessage", body);
}

async function editMessage(chatId, messageId, text) {
  const value = String(text || "").slice(
    0,
    SAFE_STREAM_LIMIT
  );

  if (!value) {
    return {
      ok: false,
      description: "Empty message",
    };
  }

  const rich = await tg(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text: value,
      parse_mode: "Markdown",
    }
  );

  if (
    rich.ok ||
    /message is not modified/i.test(
      rich.description || ""
    )
  ) {
    return rich;
  }

  return tg(
    "editMessageText",
    {
      chat_id: chatId,
      message_id: messageId,
      text: value,
    }
  );
}

async function typing(chatId) {
  return tg(
    "sendChatAction",
    {
      chat_id: chatId,
      action: "typing",
    },
    {
      maxAttempts: 0,
      timeoutMs: 10000,
    }
  );
}

async function reactMessage(
  chatId,
  messageId,
  emoji
) {
  if (!RX.includes(emoji)) {
    return;
  }

  const result = await tg(
    "setMessageReaction",
    {
      chat_id: chatId,
      message_id: messageId,
      reaction: [
        {
          type: "emoji",
          emoji,
        },
      ],
      is_big: false,
    },
    {
      maxAttempts: 0,
      timeoutMs: 10000,
    }
  );

  if (!result.ok) {
    console.warn(
      "Reaction unavailable:",
      result.description ||
        "unknown error"
    );
  }
}

async function sendPrivateDraft(
  chatId,
  draftIdValue,
  text
) {
  return tg(
    "sendMessageDraft",
    {
      chat_id: chatId,
      draft_id: draftIdValue,
      text: String(text || "").slice(
        0,
        SAFE_STREAM_LIMIT
      ),
      parse_mode: "Markdown",
    },
    {
      maxAttempts: 0,
      timeoutMs: 10000,
    }
  );
}

// ============================================================
// FILES / IMAGES
// ============================================================

function normalizeMime(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function mimeFromExtension(path) {
  const value = String(path || "")
    .toLowerCase();

  if (
    value.endsWith(".jpg") ||
    value.endsWith(".jpeg")
  ) {
    return "image/jpeg";
  }

  if (value.endsWith(".png")) {
    return "image/png";
  }

  if (value.endsWith(".webp")) {
    return "image/webp";
  }

  if (value.endsWith(".gif")) {
    return "image/gif";
  }

  if (value.endsWith(".pdf")) {
    return "application/pdf";
  }

  if (value.endsWith(".txt")) {
    return "text/plain";
  }

  if (value.endsWith(".md")) {
    return "text/markdown";
  }

  if (value.endsWith(".csv")) {
    return "text/csv";
  }

  if (value.endsWith(".json")) {
    return "application/json";
  }

  if (value.endsWith(".xml")) {
    return "application/xml";
  }

  if (
    value.endsWith(".html") ||
    value.endsWith(".htm")
  ) {
    return "text/html";
  }

  if (value.endsWith(".css")) {
    return "text/css";
  }

  if (value.endsWith(".js")) {
    return "text/javascript";
  }

  if (value.endsWith(".ts")) {
    return "text/typescript";
  }

  if (value.endsWith(".py")) {
    return "text/x-python";
  }

  if (value.endsWith(".java")) {
    return "text/x-java-source";
  }

  if (value.endsWith(".log")) {
    return "text/plain";
  }

  return "";
}

function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) {
    return "";
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.subarray(0, 4).toString("ascii") ===
      "RIFF" &&
    buffer
      .subarray(8, 12)
      .toString("ascii") ===
      "WEBP"
  ) {
    return "image/webp";
  }

  const gifHeader = buffer
    .subarray(0, 6)
    .toString("ascii");

  if (
    gifHeader === "GIF87a" ||
    gifHeader === "GIF89a"
  ) {
    return "image/gif";
  }

  return "";
}

function supportedImageMime(mime) {
  return [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ].includes(mime);
}

async function telegramFile(fileId) {
  const result = await tg(
    "getFile",
    {
      file_id: fileId,
    }
  );

  if (
    !result.ok ||
    !result.result?.file_path
  ) {
    throw new Error(
      result.description ||
        "Telegram getFile failed"
    );
  }

  const path = String(
    result.result.file_path
  );

  const response = await fetch(
    `${TG_BASE}/file/bot${BOT_TOKEN}/${path}`,
    {
      signal:
        AbortSignal.timeout(
          FETCH_TIMEOUT_MS
        ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `File download failed (${response.status})`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error(
      "File is too large for this bot"
    );
  }

  const headerMime = normalizeMime(
    response.headers.get(
      "content-type"
    )
  );

  const extensionMime =
    mimeFromExtension(path);

  const sniffedMime =
    sniffImageMime(buffer);

  return {
    buffer,
    path,
    headerMime,
    extensionMime,
    sniffedMime,
    mime:
      headerMime ||
      extensionMime ||
      sniffedMime ||
      "",
    base64:
      buffer.toString("base64"),
  };
}

async function telegramImage(fileId) {
  const file = await telegramFile(fileId);

  const candidates = [
    file.sniffedMime,
    file.headerMime,
    file.extensionMime,
  ];

  const mime = candidates.find(
    supportedImageMime
  ) || "";

  if (!mime) {
    throw new Error(
      "Unsupported or unidentified image format. Use JPEG, PNG, WEBP, or GIF."
    );
  }

  if (
    file.sniffedMime &&
    file.sniffedMime !== mime
  ) {
    throw new Error(
      "Image content type does not match its file data."
    );
  }

  return {
    ...file,
    mime,
  };
}

function decodeTextFile(
  buffer,
  fileName = ""
) {
  const name = String(
    fileName || ""
  ).toLowerCase();

  const textExtensions = [
    ".txt",
    ".md",
    ".json",
    ".csv",
    ".js",
    ".ts",
    ".py",
    ".java",
    ".html",
    ".htm",
    ".css",
    ".xml",
    ".log",
  ];

  if (
    !textExtensions.some(
      (ext) => name.endsWith(ext)
    )
  ) {
    return null;
  }

  return buffer
    .toString(
      "utf8",
      0,
      Math.min(
        buffer.length,
        MAX_TEXT_FILE_CHARS * 2
      )
    )
    .slice(
      0,
      MAX_TEXT_FILE_CHARS
    );
}

function isSupportedFileMime(mime) {
  return [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
    "text/xml",
    "text/html",
    "text/css",
    "text/javascript",
    "text/typescript",
    "text/x-python",
    "text/x-java-source",
  ].includes(
    normalizeMime(mime)
  );
}

// ============================================================
// SEARCH
// ============================================================

const SEARCH_TOOL = [
  {
    type: "function",

    function: {
      name: "web_search",

      description:
        "Search the web when the user asks for current, recent, live, changing, or externally verifiable information. Use concise targeted queries.",

      parameters: {
        type: "object",

        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 500,
          },
        },

        required: ["query"],

        additionalProperties: false,
      },
    },
  },
];

function searchFreshness(query) {
  return /today|tonight|now|currently|current|latest|breaking|recent|this week|this month|live|right now|امروز|الان|فعلی|جدیدترین|آخرین|اخبار|لحظه/i.test(
    query
  )
    ? "oneMonth"
    : "noLimit";
}

async function searchWeb(query) {
  if (!LANGSEARCH_KEY) {
    throw new Error(
      "Web search is not configured"
    );
  }

  const cleanQuery = String(
    query || ""
  )
    .trim()
    .slice(0, 500);

  if (!cleanQuery) {
    throw new Error(
      "Empty search query"
    );
  }

  stats.searches++;

  const response = await fetch(
    LANGSEARCH_URL,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",
        authorization: `Bearer ${LANGSEARCH_KEY}`,
      },

      body: JSON.stringify({
        query: cleanQuery,
        freshness:
          searchFreshness(
            cleanQuery
          ),
        summary: true,
        count: 5,
      }),

      signal:
        AbortSignal.timeout(
          FETCH_TIMEOUT_MS
        ),
    }
  );

  const raw = await response.text();
  const data =
    parseJsonSafely(raw);

  if (!response.ok) {
    throw new Error(
      `Search failed (${response.status})`
    );
  }

  const results =
    data?.data?.webPages?.value;

  if (
    !Array.isArray(results) ||
    !results.length
  ) {
    return "No useful web results were returned.";
  }

  return results
    .slice(0, 5)
    .map((item, index) => {
      const title = String(
        item?.name ||
          "Untitled"
      ).slice(0, 300);

      const url = String(
        item?.url || ""
      ).slice(0, 1000);

      const summary = String(
        item?.summary ||
          item?.snippet ||
          ""
      ).slice(0, 700);

      const date = item?.datePublished
        ? `\nPublished: ${String(
            item.datePublished
          ).slice(0, 80)}`
        : "";

      return [
        `[${index + 1}] ${title}`,
        `URL: ${url}${date}`,
        summary,
      ].join("\n");
    })
    .join("\n\n");
}

function likelyNeedsSearch(prompt) {
  const input = String(
    prompt || ""
  ).trim();

  if (!input) {
    return false;
  }

  return (
    /\b(today|tonight|now|currently|current|latest|newest|recent|breaking|this week|this month|live|right now|as of)\b/i.test(
      input
    ) ||

    /(امروز|امشب|الان|در حال حاضر|فعلی|جدیدترین|آخرین|اخبار|به.?روز|تا امروز|اکنون)/i.test(
      input
    ) ||

    /\b(price|prices|exchange rate|weather|score|scores|schedule|standings|election|president|stock|crypto|bitcoin|flight|visa|opening hours|outage|version|release)\b/i.test(
      input
    )
  );
}

function buildSearchInstruction(
  query,
  results
) {
  return [
    "The user asked for information that should be verified with web search.",
    `Search query: ${query}`,
    "Use the following web results as evidence. Do not invent facts that are not supported by them.",
    results,
  ].join("\n\n");
}

// ============================================================
// OPENROUTER
// ============================================================

function selectedModel({
  image,
  file,
  mode,
}) {
  if (image) {
    return VISION_MODEL;
  }

  if (file) {
    return FILE_MODEL;
  }

  if (mode === "fast") {
    return FAST_MODEL;
  }

  if (mode === "deep") {
    return DEEP_MODEL;
  }

  return TEXT_MODEL;
}

function cleanSystem(
  userId,
  mode,
  hasSearchContext = false
) {
  const parts = [
    SYSTEM_PROMPT,
  ];

  if (mode === "fast") {
    parts.push(
      "Prioritize speed and concise answers. Do not use web search unless the request clearly requires current verification."
    );
  }

  if (mode === "deep") {
    parts.push(
      "Be thorough and careful. For current, recent, live, or uncertain externally verifiable claims, use web search when available."
    );
  }

  if (hasSearchContext) {
    parts.push(
      "A web search was already performed. Treat its results as external evidence and clearly distinguish uncertainty."
    );
  }

  parts.push(
    "Never output hidden control tags such as <reaction> or <tool>. Answer normally for the user.",

    "When web_search is available and the request needs current or externally verifiable information, actually call it rather than saying you cannot browse.",

    "Do not call web_search for casual conversation, stable general knowledge, or purely creative tasks."
  );

  const style =
    getPref(userId, "style");

  const language =
    getPref(userId, "language");

  if (style) {
    parts.push(
      `Preferred style: ${style}.`
    );
  }

  if (language) {
    parts.push(
      `Preferred language: ${language}.`
    );
  }

  return parts.join(
    "\n\n"
  );
}

function makeUserMessage(
  prompt,
  image,
  file
) {
  const text =
    String(prompt || "").trim() ||
    (
      image
        ? "Describe this image in detail."
        : "Please analyze this file."
    );

  if (image) {
    return {
      role: "user",

      content: [
        {
          type: "text",
          text,
        },

        {
          type: "image_url",

          image_url: {
            url: `data:${image.mime};base64,${image.base64}`,
          },
        },
      ],
    };
  }

  if (file) {
    const fileName =
      file.fileName ||
      "uploaded-file";

    const mime =
      normalizeMime(file.mime);

    if (
      mime === "application/pdf" ||
      isSupportedFileMime(mime)
    ) {
      return {
        role: "user",

        content: [
          {
            type: "text",
            text,
          },

          {
            type: "file",

            file: {
              filename: fileName,

              file_data:
                `data:${mime};base64,${file.base64}`,
            },
          },
        ],
      };
    }
  }

  return {
    role: "user",
    content: text,
  };
}

async function buildMessages({
  userId,
  prompt,
  image,
  file,
  mode,
  searchContext,
}) {
  const messages = [
    {
      role: "system",
      content: cleanSystem(
        userId,
        mode,
        Boolean(searchContext)
      ),
    },
  ];

  if (!image && !file) {
    messages.push(
      ...(await getHistory(userId))
    );
  }

  if (searchContext) {
    messages.push({
      role: "system",
      content: searchContext,
    });
  }

  messages.push(
    makeUserMessage(
      prompt,
      image,
      file
    )
  );

  return messages;
}

function orHeaders() {
  return {
    authorization:
      `Bearer ${OR_KEY}`,

    "content-type":
      "application/json",

    ...(process.env
      .OPENROUTER_HTTP_REFERER
      ? {
          "HTTP-Referer":
            process.env
              .OPENROUTER_HTTP_REFERER,
        }
      : {}),

    ...(process.env
      .OPENROUTER_X_TITLE
      ? {
          "X-Title":
            process.env
              .OPENROUTER_X_TITLE,
        }
      : {}),
  };
}

function redactErrorText(text) {
  return String(text || "")
    .replace(
      /Bearer\s+[A-Za-z0-9._~-]+/gi,
      "Bearer [redacted]"
    )
    .replace(
      /(api[_-]?key|token|secret)["']?\s*[:=]\s*["']?[^\s,}"']+/gi,
      "$1=[redacted]"
    )
    .slice(0, 1000);
}

class OpenRouterError extends Error {
  constructor(
    message,
    status = 0,
    body = ""
  ) {
    super(message);
    this.name =
      "OpenRouterError";
    this.status = status;
    this.body = body;
  }
}

async function orRequest(
  messages,
  model,
  stream = true,
  tools = null
) {
  if (!OR_KEY) {
    throw new OpenRouterError(
      "OPENROUTER_API_KEY is missing",
      0
    );
  }

  if (!model) {
    throw new OpenRouterError(
      "No OpenRouter model is configured",
      0
    );
  }

  const body = {
    model,
    messages,
    stream,
  };

  if (
    Array.isArray(tools) &&
    tools.length
  ) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let lastError = null;

  for (
    let attempt = 0;
    attempt <= 2;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          OR_URL,
          {
            method: "POST",

            headers: orHeaders(),

            body: JSON.stringify(
              body
            ),

            signal:
              AbortSignal.timeout(
                stream
                  ? STREAM_FETCH_TIMEOUT_MS
                  : FETCH_TIMEOUT_MS
              ),
          }
        );

      if (response.ok) {
        return response;
      }

      const raw =
        redactErrorText(
          await response.text()
        );

      const retryAfter =
        Number(
          response.headers.get(
            "retry-after"
          ) || 0
        );

      const retryable =
        response.status === 429 ||
        response.status >= 500;

      lastError =
        new OpenRouterError(
          `OpenRouter ${response.status}${
            raw
              ? `: ${raw}`
              : ""
          }`,
          response.status,
          raw
        );

      if (
        !retryable ||
        attempt >= 2
      ) {
        throw lastError;
      }

      await sleep(
        retryAfter > 0
          ? Math.min(
              retryAfter * 1000,
              10000
            )
          : Math.min(
              700 * 2 ** attempt,
              3000
            )
      );
    } catch (error) {
      if (
        error instanceof
        OpenRouterError
      ) {
        lastError = error;

        if (
          error.status === 429 ||
          error.status >= 500
        ) {
          if (attempt < 2) {
            await sleep(
              Math.min(
                700 * 2 ** attempt,
                3000
              )
            );

            continue;
          }
        }

        throw error;
      }

      lastError =
        new OpenRouterError(
          error instanceof Error
            ? error.message
            : String(error)
        );

      if (attempt >= 2) {
        throw lastError;
      }

      await sleep(
        Math.min(
          700 * 2 ** attempt,
          3000
        )
      );
    }
  }

  throw (
    lastError ||
    new OpenRouterError(
      "OpenRouter request failed"
    )
  );
}

// ============================================================
// STREAM PARSING / TOOL CALLS
// ============================================================

async function* sseEvents(body) {
  const reader =
    body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const {
        value,
        done,
      } = await reader.read();

      if (done) {
        break;
      }

      buffer +=
        decoder.decode(
          value,
          {
            stream: true,
          }
        );

      const events =
        buffer.split(
          /\r?\n\r?\n/
        );

      buffer =
        events.pop() || "";

      for (const event of events) {
        yield event;
      }
    }

    buffer +=
      decoder.decode();

    if (buffer.trim()) {
      yield buffer;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseSSEEvent(
  eventText
) {
  const dataLines =
    String(eventText || "")
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("data:")
      )
      .map(
        (line) =>
          line
            .slice(5)
            .trim()
      );

  if (!dataLines.length) {
    return null;
  }

  const payload =
    dataLines.join("\n");

  if (
    !payload ||
    payload === "[DONE]"
  ) {
    return {
      done: true,
    };
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function mergeToolDeltas(
  accumulator,
  deltas
) {
  for (const delta of Array.isArray(
    deltas
  )
    ? deltas
    : []) {
    const index =
      Number.isInteger(delta?.index)
        ? delta.index
        : 0;

    if (!accumulator[index]) {
      accumulator[index] = {
        id: "",
        type: "function",

        function: {
          name: "",
          arguments: "",
        },
      };
    }

    if (delta?.id) {
      accumulator[index].id =
        delta.id;
    }

    if (delta?.type) {
      accumulator[index].type =
        delta.type;
    }

    if (
      delta?.function?.name
    ) {
      accumulator[index].function.name +=
        delta.function.name;
    }

    if (
      delta?.function?.arguments
    ) {
      accumulator[index].function.arguments +=
        delta.function.arguments;
    }
  }
}

function normalizeToolCall(
  tool
) {
  if (
    !tool?.id ||
    tool?.function?.name !==
      "web_search"
  ) {
    return null;
  }

  let args;

  try {
    args = JSON.parse(
      tool.function.arguments ||
        "{}"
    );
  } catch {
    return null;
  }

  const query =
    typeof args?.query === "string"
      ? args.query
          .trim()
          .slice(0, 500)
      : "";

  if (!query) {
    return null;
  }

  return {
    id: tool.id,

    type: "function",

    function: {
      name: "web_search",

      arguments: JSON.stringify({
        query,
      }),
    },
  };
}

async function streamModelResponse({
  response,
  onText,
}) {
  let full = "";
  let firstTokenAt = null;
  let toolCalls = [];

  for await (
    const eventText of sseEvents(
      response.body
    )
  ) {
    const chunk =
      parseSSEEvent(
        eventText
      );

    if (
      !chunk ||
      chunk.done
    ) {
      continue;
    }

    const choice =
      chunk?.choices?.[0];

    const delta =
      choice?.delta;

    if (delta?.tool_calls) {
      mergeToolDeltas(
        toolCalls,
        delta.tool_calls
      );
    }

    const piece =
      typeof delta?.content ===
      "string"
        ? delta.content
        : "";

    if (piece) {
      if (
        firstTokenAt === null
      ) {
        firstTokenAt =
          Date.now();
      }

      full += piece;

      await onText(
        piece,
        full
      );
    }
  }

  return {
    full,

    firstTokenAt,

    toolCalls:
      toolCalls
        .map(normalizeToolCall)
        .filter(Boolean),
  };
}

async function executeSearchCalls(
  messages,
  toolCalls,
  searchCount,
  assistantContent = null
) {
  const valid =
    toolCalls.slice(
      0,
      Math.max(
        0,
        MAX_SEARCHES -
          searchCount
      )
    );

  if (!valid.length) {
    return {
      messages,
      searchCount,
      didSearch: false,
    };
  }

  messages.push({
    role: "assistant",
    content:
      assistantContent || null,
    tool_calls: valid,
  });

  for (const call of valid) {
    let query = "";

    try {
      query =
        JSON.parse(
          call.function.arguments ||
            "{}"
        ).query || "";
    } catch {}

    searchCount++;

    let result =
      "No search result available.";

    if (query) {
      try {
        result =
          await searchWeb(query);
      } catch (error) {
        result =
          `Search failed: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`;
      }
    }

    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: result,
    });
  }

  return {
    messages,
    searchCount,
    didSearch: true,
  };
}

// ============================================================
// MODEL GENERATION / TELEGRAM STREAMING
// ============================================================

async function sendChunked(
  chatId,
  text,
  replyTo
) {
  const parts =
    splitText(
      text,
      SAFE_STREAM_LIMIT
    );

  for (
    let i = 0;
    i < parts.length;
    i++
  ) {
    const result =
      await sendMessage(
        chatId,
        parts[i],
        i === 0
          ? replyTo
          : undefined
      );

    if (!result.ok) {
      await sendPlain(
        chatId,
        parts[i],
        i === 0
          ? replyTo
          : undefined
      );
    }

    if (
      i <
      parts.length - 1
    ) {
      await sleep(50);
    }
  }
}

async function finalizeGroup(
  chatId,
  messageId,
  text
) {
  const parts =
    splitText(
      text,
      SAFE_STREAM_LIMIT
    );

  if (!parts.length) {
    return false;
  }

  const first =
    await editMessage(
      chatId,
      messageId,
      parts[0]
    );

  if (!first.ok) {
    await sendChunked(
      chatId,
      text
    );

    return false;
  }

  for (
    let i = 1;
    i < parts.length;
    i++
  ) {
    await sendMessage(
      chatId,
      parts[i]
    );

    if (
      i <
      parts.length - 1
    ) {
      await sleep(50);
    }
  }

  return true;
}

async function sendFinalPrivate(
  chatId,
  text,
  replyTo
) {
  const parts =
    splitText(
      text,
      SAFE_STREAM_LIMIT
    );

  for (
    let i = 0;
    i < parts.length;
    i++
  ) {
    await sendMessage(
      chatId,
      parts[i],
      i === 0
        ? replyTo
        : undefined
    );

    if (
      i <
      parts.length - 1
    ) {
      await sleep(50);
    }
  }
}

function splitText(
  text,
  limit = TG_LIMIT
) {
  const value =
    String(text || "")
      .replace(/\u0000/g, "")
      .trim();

  if (!value) {
    return [];
  }

  if (
    value.length <= limit
  ) {
    return [value];
  }

  const parts = [];
  let start = 0;

  while (
    start < value.length
  ) {
    let end = Math.min(
      start + limit,
      value.length
    );

    if (
      end < value.length
    ) {
      const windowStart =
        start +
        Math.floor(
          limit * 0.45
        );

      const candidates = [
        value.lastIndexOf(
          "\n\n",
          end
        ),
        value.lastIndexOf(
          "\n",
          end
        ),
        value.lastIndexOf(
          ". ",
          end
        ),
        value.lastIndexOf(
          "! ",
          end
        ),
        value.lastIndexOf(
          "? ",
          end
        ),
        value.lastIndexOf(
          "؟ ",
          end
        ),
        value.lastIndexOf(
          " ",
          end
        ),
      ];

      const preferred =
        candidates.find(
          (position) =>
            position >=
            windowStart
        );

      if (
        preferred != null &&
        preferred > start
      ) {
        end =
          preferred +
          1;
      }
    }

    let part =
      value
        .slice(start, end)
        .trim();

    if (!part) {
      end = Math.min(
        start + limit,
        value.length
      );

      part =
        value.slice(
          start,
          end
        );
    }

    parts.push(part);
    start = end;
  }

  return parts;
}

async function generate({
  chatId,
  userId,
  prompt,
  image,
  file,
  mode,
  replyTo,
  isPrivate,
}) {
  const started =
    Date.now();

  stats.requests++;

  let streamMessageId =
    null;

  const draftIdValue =
    draftId();

  let displayedLength = 0;

  let lastTelegramUpdate =
    0;

  let full = "";

  let firstTokenAt =
    null;

  let searchCount = 0;

  let searchContext = "";

  let toolsEnabled =
    Boolean(
      LANGSEARCH_KEY
    ) &&
    mode !== "fast";

  const model =
    selectedModel({
      image,
      file: Boolean(file),
      mode,
    });

  console.log(
    `[generate] chat=${String(
      chatId
    )} mode=${mode} model=${model} image=${Boolean(
      image
    )} file=${Boolean(file)}`
  );

  try {
    if (!isPrivate) {
      const placeholder =
        await sendPlain(
          chatId,
          "🧠 Thinking…",
          replyTo
        );

      if (
        placeholder.ok
      ) {
        streamMessageId =
          placeholder
            .result
            ?.message_id ||
          null;
      }
    } else {
      await sendPrivateDraft(
        chatId,
        draftIdValue,
        "🧠 Thinking…"
      ).catch(() => {});
    }

    const typeTimer =
      setInterval(() => {
        typing(chatId).catch(
          () => {}
        );
      }, 5000);

    typeTimer.unref?.();

    try {
      if (
        likelyNeedsSearch(
          prompt
        ) &&
        LANGSEARCH_KEY
      ) {
        try {
          const result =
            await searchWeb(
              prompt
            );

          searchContext =
            buildSearchInstruction(
              prompt,
              result
            );

          searchCount++;

          console.log(
            `[search] automatic search triggered chat=${String(
              chatId
            )} mode=${mode}`
          );
        } catch (error) {
          searchCount++;

          console.warn(
            `[search] automatic search failed chat=${String(
              chatId
            )} reason=${
              error instanceof Error
                ? error.message
                : String(error)
            }`
          );
        }
      }

      const messages =
        await buildMessages({
          userId,
          prompt,
          image,
          file,
          mode,
          searchContext,
        });

      for (
        let round = 0;
        round <
        MAX_TOOL_ROUNDS;
        round++
      ) {
        const useTools =
          toolsEnabled &&
          searchCount <
            MAX_SEARCHES;

        let response;

        try {
          response =
            await orRequest(
              messages,
              model,
              true,
              useTools
                ? SEARCH_TOOL
                : null
            );
        } catch (error) {
          // Some models/providers reject tools.
          // Retry the same model without tools.
          if (
            useTools &&
            error instanceof
              OpenRouterError &&
            error.status === 400
          ) {
            console.warn(
              `[openrouter] tool request rejected; retrying without tools model=${model}`
            );

            toolsEnabled =
              false;

            response =
              await orRequest(
                messages,
                model,
                true,
                null
              );
          } else {
            throw error;
          }
        }

        if (
          !response.body
        ) {
          throw new OpenRouterError(
            "OpenRouter returned an empty stream",
            response.status
          );
        }

        const streamed =
          await streamModelResponse(
            {
              response,

              onText: async (
                _piece,
                current
              ) => {
                if (
                  firstTokenAt ===
                  null
                ) {
                  firstTokenAt =
                    Date.now();

                  const firstTokenMs =
                    firstTokenAt -
                    started;

                  recordMetric(
                    stats.firstTokenMs,
                    firstTokenMs
                  );

                  console.log(
                    `[latency] first-token=${firstTokenMs}ms model=${model}`
                  );
                }

                full = current;

                const now =
                  Date.now();

                if (
                  now -
                    lastTelegramUpdate <
                  800
                ) {
                  return;
                }

                lastTelegramUpdate =
                  now;

                const streamText =
                  current.slice(
                    0,
                    SAFE_STREAM_LIMIT
                  );

                if (
                  streamText.length <=
                    displayedLength &&
                  current.length <
                    SAFE_STREAM_LIMIT
                ) {
                  return;
                }

                displayedLength =
                  current.length;

                if (isPrivate) {
                  await sendPrivateDraft(
                    chatId,
                    draftIdValue,
                    streamText
                  ).catch(() => {});
                } else if (
                  streamMessageId
                ) {
                  const edited =
                    await editMessage(
                      chatId,
                      streamMessageId,
                      streamText
                    );

                  if (
                    !edited.ok
                  ) {
                    if (
                      /message is not modified/i.test(
                        edited.description ||
                          ""
                      )
                    ) {
                      return;
                    }
                  }
                }
              },
            }
          );

        full =
          streamed.full;

        if (
          firstTokenAt ===
            null &&
          streamed.firstTokenAt !==
            null
        ) {
          firstTokenAt =
            streamed.firstTokenAt;

          recordMetric(
            stats.firstTokenMs,
            firstTokenAt -
              started
          );
        }

        if (
          streamed
            .toolCalls
            .length &&
          useTools
        ) {
          const result =
            await executeSearchCalls(
              messages,
              streamed.toolCalls,
              searchCount,
              streamed.full
            );

          searchCount =
            result.searchCount;

          if (
            result.didSearch
          ) {
            console.log(
              `[search] tool search executed count=${searchCount} chat=${String(
                chatId
              )}`
            );

            continue;
          }
        }

        break;
      }
    } finally {
      clearInterval(
        typeTimer
      );
    }

    if (!full.trim()) {
      throw new Error(
        "The model returned no answer"
      );
    }

    if (isPrivate) {
      // sendMessageDraft is ephemeral.
      // Persist the final answer normally.
      await sendFinalPrivate(
        chatId,
        full,
        replyTo
      );
    } else if (
      streamMessageId
    ) {
      await finalizeGroup(
        chatId,
        streamMessageId,
        full
      );
    } else {
      await sendChunked(
        chatId,
        full,
        replyTo
      );
    }

    recordMetric(
      stats.totalMs,
      Date.now() - started
    );

    await saveHistory(
      userId,
      prompt,
      full
    );

    console.log(
      `[complete] chat=${String(
        chatId
      )} elapsed=${
        Date.now() - started
      }ms searchCount=${searchCount}`
    );

    return full;
  } catch (error) {
    stats.errors++;

    recordMetric(
      stats.totalMs,
      Date.now() - started
    );

    const safeMessage =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      `[generate] failed chat=${String(
        chatId
      )} model=${model} reason=${safeMessage}`
    );

    const userError =
      "❌ *I couldn't complete that request.*\n\nPlease try again in a moment.";

    try {
      if (
        !isPrivate &&
        streamMessageId
      ) {
        await editMessage(
          chatId,
          streamMessageId,
          userError
        );
      } else {
        await sendMessage(
          chatId,
          userError,
          isPrivate
            ? replyTo
            : undefined
        );
      }
    } catch {}

    throw error;
  }
}

// ============================================================
// COMMANDS
// ============================================================

function parseCommand(text) {
  const input =
    String(text || "").trim();

  if (
    !input.startsWith("/")
  ) {
    return null;
  }

  const match =
    input.match(
      /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/
    );

  if (!match) {
    return null;
  }

  return {
    name:
      `/${match[1].toLowerCase()}`,

    username:
      String(match[2] || ""),

    arg:
      String(match[3] || "").trim(),
  };
}

function commandTargetsThisBot(
  parsed
) {
  if (!parsed?.username) {
    return true;
  }

  const known =
    botUsernameRuntime.toLowerCase();

  return Boolean(
    known &&
      parsed.username.toLowerCase() ===
        known
  );
}

function inferModeFromPrompt(
  prompt,
  fallback
) {
  if (
    /\bdeep\b/i.test(prompt)
  ) {
    return "deep";
  }

  if (
    /\bfast\b/i.test(prompt)
  ) {
    return "fast";
  }

  return fallback;
}

function helpText() {
  return [
    "🤖 *How to use the bot*",
    "",

    "*💬 Chat*",

    "Send a normal message in a private chat.",

    "In groups, mention the bot, use the trigger command, or reply to the bot.",

    "",

    "*⚡ Modes*",

    "`/fast` — prioritize speed and concise answers.",

    "`/normal` — balanced default behavior.",

    "`/deep` — more thorough reasoning and stronger web-search preference.",

    "",

    "*🧠 Memory*",

    "Recent conversation history is kept in memory for follow-up questions.",

    "`/clear` or `/clearmemory` — clear your conversation history.",

    "History resets when the service restarts.",

    "",

    "*🌐 Web search*",

    "The bot can search the web for current, recent, live, or changing information when search is available.",

    "",

    "*🖼 Images*",

    "Send a JPEG, PNG, WEBP, or GIF with your question. Images are automatically routed to the vision model.",

    "",

    "*📄 Files*",

    "Text/code files and PDFs can be analyzed when their format is supported. Files are routed to the file model.",

    "",

    "*⚙️ Preferences*",

    "`/style <value>` — set a preferred answer style.",

    "`/language <value>` — set a preferred response language.",

    "",

    "*📊 Info*",

    "`/status` — basic bot status.",

    "`/stats` — runtime statistics.",

    "`/models` — configured model routes.",

    "`/help` — show this guide.",
  ].join("\n");
}

async function command(
  chatId,
  userId,
  text,
  messageId
) {
  const parsed =
    parseCommand(text);

  if (
    !parsed ||
    !commandTargetsThisBot(
      parsed
    )
  ) {
    return false;
  }

  switch (parsed.name) {
    case "/start":
      await sendMessage(
        chatId,
        "👋 *Welcome.*\n\nSend me a message to chat, or use /help to see what I can do.",
        messageId
      );
      return true;

    case "/help":
      await sendMessage(
        chatId,
        helpText(),
        messageId
      );
      return true;

    case "/fast":
      setPref(
        userId,
        "mode",
        "fast"
      );

      await sendMessage(
        chatId,
        "⚡ *Fast mode enabled.*",
        messageId
      );

      return true;

    case "/normal":
      setPref(
        userId,
        "mode",
        "normal"
      );

      await sendMessage(
        chatId,
        "🙂 *Normal mode enabled.*",
        messageId
      );

      return true;

    case "/deep":
      setPref(
        userId,
        "mode",
        "deep"
      );

      await sendMessage(
        chatId,
        "🧠 *Deep mode enabled.*",
        messageId
      );

      return true;

    case "/style":
      if (!parsed.arg) {
        await sendMessage(
          chatId,
          "Usage: `/style concise`",
          messageId
        );
      } else {
        setPref(
          userId,
          "style",
          parsed.arg
        );

        await sendMessage(
          chatId,
          `Style set to *${esc(
            parsed.arg
          )}*.`,
          messageId
        );
      }

      return true;

    case "/language":
      if (!parsed.arg) {
        await sendMessage(
          chatId,
          "Usage: `/language English`",
          messageId
        );
      } else {
        setPref(
          userId,
          "language",
          parsed.arg
        );

        await sendMessage(
          chatId,
          `Language set to *${esc(
            parsed.arg
          )}*.`,
          messageId
        );
      }

      return true;

    case "/clear":
    case "/clearmemory":
      mem.delete(
        `history:${userId}`
      );

      await sendMessage(
        chatId,
        "🧹 *Memory cleared.*",
        messageId
      );

      return true;

    case "/status":
      await sendMessage(
        chatId,
        statusText(false),
        messageId
      );

      return true;

    case "/stats":
      await sendMessage(
        chatId,
        statusText(false),
        messageId
      );

      return true;

    case "/models":
      await sendMessage(
        chatId,
        [
          "🤖 *Configured model routes*",
          "",
          `Text: \`${esc(
            TEXT_MODEL
          )}\``,
          `Fast: \`${esc(
            FAST_MODEL
          )}\``,
          `Deep: \`${esc(
            DEEP_MODEL
          )}\``,
          `Vision: \`${esc(
            VISION_MODEL
          )}\``,
          `Files: \`${esc(
            FILE_MODEL
          )}\``,
        ].join("\n"),
        messageId
      );

      return true;

    default:
      return false;
  }
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function adminCommand(
  chatId,
  userId,
  text,
  messageId
) {
  const parsed =
    parseCommand(text);

  if (
    !parsed ||
    !commandTargetsThisBot(
      parsed
    )
  ) {
    return false;
  }

  if (
    !ADMIN_IDS.has(
      String(userId)
    )
  ) {
    return false;
  }

  switch (parsed.name) {
    case "/admin":
    case "/dev":
      await sendMessage(
        chatId,
        statusText(true),
        messageId
      );

      return true;

    case "/clearcache":
      mem.clear();
      lastReactions.clear();

      await sendMessage(
        chatId,
        "🧹 *Runtime cache cleared.*",
        messageId
      );

      return true;

    default:
      return false;
  }
}

// ============================================================
// UPDATE PROCESSING
// ============================================================

function botMentioned(text) {
  if (!botUsernameRuntime) {
    return false;
  }

  return new RegExp(
    `@${escapeRegExp(
      botUsernameRuntime
    )}\\b`,
    "i"
  ).test(
    String(text || "")
  );
}

function stripBotTargeting(text) {
  let value =
    String(text || "");

  if (TRIGGER) {
    value = value.replace(
      new RegExp(
        `^${escapeRegExp(
          TRIGGER
        )}(?:\\s+|$)`,
        "i"
      ),
      ""
    );
  }

  if (
    botUsernameRuntime
  ) {
    value = value.replace(
      new RegExp(
        `@${escapeRegExp(
          botUsernameRuntime
        )}\\b`,
        "ig"
      ),
      ""
    );
  }

  return value.trim();
}

function replyIsFromBot(
  message
) {
  const reply =
    message?.reply_to_message;

  const from =
    reply?.from;

  if (!from) {
    return false;
  }

  if (
    botId &&
    from.id === botId
  ) {
    return true;
  }

  return Boolean(
    botUsernameRuntime &&
      String(
        from.username || ""
      ).toLowerCase() ===
        botUsernameRuntime.toLowerCase()
  );
}

async function processUpdate(
  update
) {
  const message =
    update?.message ||
    update?.edited_message;

  if (!message?.chat) {
    return;
  }

  const chatId =
    message.chat.id;

  const userId =
    message.from?.id ||
    chatId;

  const messageId =
    message.message_id;

  const text = String(
    message.text || ""
  );

  const caption = String(
    message.caption || ""
  );

  const photos =
    Array.isArray(
      message.photo
    )
      ? message.photo
      : [];

  const isImage =
    photos.length > 0;

  const isPrivate =
    message.chat.type ===
    "private";

  const rawPrompt =
    text || caption;

  const parsedCommand =
    parseCommand(text);

  if (
    parsedCommand &&
    !commandTargetsThisBot(
      parsedCommand
    )
  ) {
    return;
  }

  if (
    await adminCommand(
      chatId,
      userId,
      text,
      messageId
    )
  ) {
    return;
  }

  if (
    await command(
      chatId,
      userId,
      text,
      messageId
    )
  ) {
    return;
  }

  if (!isPrivate) {
    const mentioned =
      botMentioned(
        rawPrompt
      );

    const triggered =
      Boolean(
        TRIGGER &&
          (
            rawPrompt.toLowerCase() ===
              TRIGGER.toLowerCase() ||
            rawPrompt
              .toLowerCase()
              .startsWith(
                `${TRIGGER.toLowerCase()} `
              )
          )
      );

    const replied =
      replyIsFromBot(
        message
      );

    if (
      !mentioned &&
      !triggered &&
      !replied &&
      !isImage
    ) {
      return;
    }
  }

  const prompt =
    isPrivate
      ? rawPrompt.trim()
      : stripBotTargeting(
          rawPrompt
        );

  const finalPrompt =
    prompt ||
    (
      isImage
        ? "Describe this image in detail."
        : ""
    );

  if (
    !finalPrompt &&
    !isImage &&
    !message.document
  ) {
    return;
  }

  // Local reaction only.
  // It never calls OpenRouter.
  const emoji =
    chooseReaction(
      finalPrompt ||
        caption ||
        text,
      isImage,
      chatId
    );

  reactMessage(
    chatId,
    messageId,
    emoji
  ).catch(() => {});

  let image = null;
  let file = null;

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (isImage) {
    stats.images++;

    try {
      const selectedPhoto =
        photos[
          photos.length - 1
        ];

      image =
        await telegramImage(
          selectedPhoto.file_id
        );
    } catch (error) {
      await sendMessage(
        chatId,
        `❌ ${esc(
          error instanceof Error
            ? error.message
            : String(error)
        )}`,
        messageId
      );

      return;
    }
  }

  // ----------------------------------------------------------
  // DOCUMENT / FILE
  // ----------------------------------------------------------

  if (message.document) {
    stats.files++;

    try {
      const downloaded =
        await telegramFile(
          message.document.file_id
        );

      const declaredMime =
        normalizeMime(
          message.document.mime_type
        );

      const mimeCandidates = [
        downloaded.sniffedMime,
        declaredMime,
        downloaded.headerMime,
        downloaded.extensionMime,
      ].filter(Boolean);

      const mime =
        mimeCandidates.find(
          (candidate) =>
            isSupportedFileMime(
              candidate
            )
        ) || "";

      const fileName =
        String(
          message.document
            .file_name ||
            downloaded.path
              .split("/")
              .pop() ||
            "uploaded-file"
        );

      const textContent =
        decodeTextFile(
          downloaded.buffer,
          fileName
        );

      if (
        !textContent &&
        !isSupportedFileMime(
          mime
        )
      ) {
        await sendMessage(
          chatId,
          "❌ This file type is not supported. Supported files include PDFs and common text/code formats.",
          messageId
        );

        return;
      }

      file = {
        ...downloaded,
        fileName,
        mime,
        textContent:
          textContent || "",
      };
    } catch (error) {
      await sendMessage(
        chatId,
        `❌ ${esc(
          error instanceof Error
            ? error.message
            : String(error)
        )}`,
        messageId
      );

      return;
    }
  }

  // ----------------------------------------------------------
  // MODE
  // ----------------------------------------------------------

  let mode =
    getPref(
      userId,
      "mode"
    ) || "normal";

  mode =
    inferModeFromPrompt(
      text,
      mode
    );

  if (
    ![
      "fast",
      "normal",
      "deep",
    ].includes(mode)
  ) {
    mode = "normal";
  }

  // ----------------------------------------------------------
  // AI
  // ----------------------------------------------------------

  const generationKey =
    `${chatId}:${userId}`;

  await runSerialized(
    generationKey,
    () =>
      generate({
        chatId,
        userId,
        prompt: finalPrompt,
        image,
        file,
        mode,
        replyTo: messageId,
        isPrivate,
      })
  ).catch(() => {});
}

// ============================================================
// UTILS
// ============================================================

function draftId() {
  return (
    Math.floor(
      Math.random() *
        2147483000
    ) + 1
  );
}

function esc(value) {
  return String(
    value ?? ""
  ).replace(
    /([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g,
    "\\$1"
  );
}

function escapeRegExp(value) {
  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// ============================================================
// STARTUP / WEBHOOK
// ============================================================

if (!BOT_TOKEN) {
  console.error(
    "Missing BOT_TOKEN"
  );
}

if (!OR_KEY) {
  console.error(
    "Missing OPENROUTER_API_KEY"
  );
}

if (!WEBHOOK_SECRET) {
  console.error(
    "Missing WEBHOOK_SECRET"
  );
}

if (!WEBHOOK_PATH_TOKEN) {
  console.error(
    "Missing WEBHOOK_PATH_TOKEN"
  );
}

if (!LANGSEARCH_KEY) {
  console.warn(
    "LANGSEARCH_API_KEY is not configured; web search will be unavailable."
  );
}

const app = express();

app.disable(
  "x-powered-by"
);

app.use(
  express.json({
    limit: "2mb",
    strict: true,
  })
);

app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("AI Bot Running");
});

app.get(
  "/health",
  (_req, res) => {
    res
      .status(200)
      .json({
        ok: true,
      });
  }
);

app.post(
  WEBHOOK_PATH,
  (req, res) => {
    const secret =
      req.get(
        "X-Telegram-Bot-Api-Secret-Token"
      ) || "";

    if (
      !WEBHOOK_SECRET ||
      secret !==
        WEBHOOK_SECRET
    ) {
      return res
        .status(401)
        .type("text/plain")
        .send("Unauthorized");
    }

    const update =
      req.body;

    if (
      !update ||
      typeof update !==
        "object"
    ) {
      return res
        .status(400)
        .send("Bad Request");
    }

    // Acknowledge Telegram immediately.
    // Heavy work happens asynchronously.
    res
      .status(200)
      .type("text/plain")
      .send("OK");

    const updateId =
      update.update_id;

    if (
      updateId !==
        undefined &&
      updateId !== null
    ) {
      const key =
        `update:${String(
          updateId
        )}`;

      if (memGet(key)) {
        return;
      }

      memSet(
        key,
        true,
        UPDATE_TTL_SECONDS
      );
    }

    setImmediate(() => {
      processUpdate(update)
        .catch((error) => {
          stats.errors++;

          console.error(
            "processUpdate:",
            error instanceof Error
              ? error.message
              : String(error)
          );
        });
    });
  }
);

app.post(
  "/guest",
  (req, res) => {
    if (!GUEST_SECRET) {
      return res
        .status(404)
        .type("text/plain")
        .send("Not found");
    }

    const supplied =
      req.get(
        "X-Guest-Secret"
      ) || "";

    if (
      supplied !==
      GUEST_SECRET
    ) {
      return res
        .status(401)
        .type("text/plain")
        .send("Unauthorized");
    }

    const body =
      req.body || {};

    const chatId =
      body.chat_id ??
      body.chatId;

    const prompt =
      String(
        body.prompt ??
          body.text ??
          ""
      ).trim();

    if (
      !chatId ||
      !prompt
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "chat_id and prompt are required",
        });
    }

    res
      .status(202)
      .json({
        ok: true,
      });

    setImmediate(() => {
      runSerialized(
        `guest:${chatId}`,
        () =>
          generate({
            chatId,
            userId:
              `guest:${chatId}`,
            prompt,
            image: null,
            file: null,
            mode: "normal",
            replyTo:
              undefined,
            isPrivate: true,
          })
      ).catch(() => {});
    });
  }
);

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "Express error:",
      error instanceof Error
        ? error.message
        : String(error)
    );

    if (
      res.headersSent
    ) {
      return;
    }

    res
      .status(400)
      .type("text/plain")
      .send("Bad Request");
  }
);

const server =
  app.listen(
    PORT,
    async () => {
      console.log(
        `Server listening on ${PORT}`
      );

      console.log(
        `Webhook path configured: ${
          WEBHOOK_PATH_TOKEN
            ? "yes"
            : "no"
        }`
      );

      if (!BOT_TOKEN) {
        return;
      }

      try {
        const result =
          await tg(
            "getMe",
            {},
            {
              maxAttempts: 1,
            }
          );

        if (result.ok) {
          botId =
            result.result.id;

          botUsernameRuntime =
            String(
              result.result
                .username ||
                botUsernameRuntime ||
                ""
            ).replace(
              /^@/,
              ""
            );

          console.log(
            `Bot identity loaded: ${
              botUsernameRuntime
                ? `@${botUsernameRuntime}`
                : botId
            }`
          );
        } else {
          console.warn(
            "Telegram getMe failed:",
            result.description ||
              "unknown error"
          );
        }
      } catch (error) {
        console.warn(
          "Telegram startup check failed:",
          error instanceof Error
            ? error.message
            : String(error)
        );
      }
    }
  );

server.on(
  "error",
  (error) => {
    console.error(
      "Server error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    stats.errors++;

    console.error(
      "Unhandled rejection:",
      reason instanceof Error
        ? reason.message
        : String(reason)
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    stats.errors++;

    console.error(
      "Uncaught exception:",
      error instanceof Error
        ? error.message
        : String(error)
    );
  }
);
