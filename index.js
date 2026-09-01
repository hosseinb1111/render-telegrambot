import express from "express";

// ============================================================
// CONFIG
// ============================================================

const TG_API = "https://api.telegram.org";
const OR_API = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS_API = "https://openrouter.ai/api/v1/models";
const LANGSEARCH_API = "https://api.langsearch.com/v1/web-search";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const RAW_WEBHOOK_PATH_TOKEN = String(process.env.WEBHOOK_PATH_TOKEN || "");
const WEBHOOK_PATH_TOKEN = /^[A-Za-z0-9._~-]{8,256}$/.test(RAW_WEBHOOK_PATH_TOKEN)
  ? RAW_WEBHOOK_PATH_TOKEN
  : "";
const GUEST_SECRET = process.env.GUEST_API_SECRET || "";
const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY || "";

const BOT_USERNAME = String(process.env.BOT_USERNAME || "").replace(/^@/, "");
const TRIGGER = String(process.env.TRIGGER_COMMAND || "!ai").trim();

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful AI assistant. Answer accurately, clearly, naturally, and concisely.";

const TEXT_MODEL =
  process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7:free";

const FAST_MODEL =
  process.env.OPENROUTER_FAST_MODEL || TEXT_MODEL;

const DEEP_MODEL =
  process.env.OPENROUTER_DEEP_MODEL || TEXT_MODEL;

const VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL || "openrouter/free";

const FILE_MODEL =
  process.env.OPENROUTER_FILE_MODEL || "openrouter/free";

const PORT = Number(process.env.PORT || 3000);

const HISTORY_PAIRS = clampInt(
  process.env.HISTORY_PAIRS,
  4,
  1,
  20
);

const MAX_SEARCHES = clampInt(
  process.env.MAX_SEARCHES,
  3,
  0,
  10
);

const MAX_TOOL_ROUNDS = clampInt(
  process.env.MAX_TOOL_ROUNDS,
  5,
  1,
  10
);

const MAX_HISTORY_USERS = clampInt(
  process.env.MAX_HISTORY_USERS,
  5000,
  100,
  50000
);

const MAX_MEMORY_ENTRIES = clampInt(
  process.env.MAX_MEMORY_ENTRIES,
  10000,
  1000,
  100000
);

const MAX_USER_PROMPT_CHARS = clampInt(
  process.env.MAX_USER_PROMPT_CHARS,
  16000,
  1000,
  50000
);

const MAX_FILE_TEXT_CHARS = clampInt(
  process.env.MAX_FILE_TEXT_CHARS,
  30000,
  1000,
  100000
);

const MAX_DOWNLOAD_BYTES = clampInt(
  process.env.MAX_DOWNLOAD_BYTES,
  20 * 1024 * 1024,
  1024,
  20 * 1024 * 1024
);

const MAX_OR_FILE_BYTES = clampInt(
  process.env.MAX_OPENROUTER_FILE_BYTES,
  12 * 1024 * 1024,
  1024,
  20 * 1024 * 1024
);

const TG_LIMIT = 4096;
const RICH_LIMIT = 32768;

const STREAM_EDIT_MS = 900;
const DRAFT_UPDATE_MS = 900;
const TYPING_MS = 4000;

const REQUEST_TIMEOUT_MS = clampInt(
  process.env.REQUEST_TIMEOUT_MS,
  45000,
  5000,
  120000
);

const MAX_GLOBAL_CONCURRENCY = clampInt(
  process.env.MAX_GLOBAL_CONCURRENCY,
  8,
  1,
  32
);

const SEEN_UPDATE_TTL_SEC = 600;
const REACTION_MEMORY_TTL_MS = 10 * 60 * 1000;
const STATS_SAMPLE_LIMIT = 200;

const WEBHOOK_PATH = WEBHOOK_PATH_TOKEN
  ? `/webhook/${WEBHOOK_PATH_TOKEN}`
  : "/webhook/UNCONFIGURED";

let botId = null;
let modelCatalog = null;
let modelCatalogLoadedAt = 0;
let modelCatalogAttemptedAt = 0;
let botInfo = null;

// ============================================================
// ENV / VALIDATION
// ============================================================

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function configWarnings() {
  const missing = [];

  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!OR_KEY) missing.push("OPENROUTER_API_KEY");
  if (!WEBHOOK_SECRET) missing.push("WEBHOOK_SECRET");
  if (!WEBHOOK_PATH_TOKEN) missing.push("WEBHOOK_PATH_TOKEN");

  if (!missing.length) return;

  console.error(
    `Missing required environment variables: ${missing.join(", ")}`
  );
}

configWarnings();

// ============================================================
// MEMORY
// ============================================================

const memory = new Map();
const prefs = new Map();
const recentReactions = new Map();
const inFlightQueues = new Map();
const seenUpdates = new Map();

function memGet(key) {
  const item = memory.get(key);

  if (!item) return null;

  if (item.expires && Date.now() > item.expires) {
    memory.delete(key);
    return null;
  }

  return item.value;
}

function memSet(key, value, ttlSeconds = 0) {
  if (memory.has(key)) memory.delete(key);

  memory.set(key, {
    value,
    expires:
      ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : 0,
  });

  trimMap(memory, MAX_MEMORY_ENTRIES);
}

function trimMap(map, maxSize) {
  while (map.size > maxSize) {
    const first = map.keys().next().value;

    if (first === undefined) break;

    map.delete(first);
  }
}

function cleanupMemory() {
  const now = Date.now();

  for (const [key, item] of memory) {
    if (item.expires && now > item.expires) {
      memory.delete(key);
    }
  }

  for (const [key, expiresAt] of seenUpdates) {
    if (now > expiresAt) {
      seenUpdates.delete(key);
    }
  }

  for (const [key, item] of recentReactions) {
    if (now > item.expires) {
      recentReactions.delete(key);
    }
  }
}

const memoryCleanupTimer = setInterval(
  cleanupMemory,
  300000
);

memoryCleanupTimer.unref?.();

function historyKey(userId) {
  return `history:${String(userId)}`;
}

function getHistory(userId) {
  const raw = memGet(historyKey(userId));

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item) =>
        item &&
        (item.role === "user" ||
          item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.length > 0
    );
  } catch {
    return [];
  }
}

function saveHistory(userId, prompt, answer) {
  const cleanPrompt = String(prompt || "")
    .slice(0, MAX_USER_PROMPT_CHARS);

  const cleanAnswer = String(answer || "")
    .slice(0, RICH_LIMIT);

  if (!cleanPrompt || !cleanAnswer) return;

  const history = getHistory(userId);

  history.push({
    role: "user",
    content: cleanPrompt,
  });

  history.push({
    role: "assistant",
    content: cleanAnswer,
  });

  memSet(
    historyKey(userId),
    JSON.stringify(
      history.slice(-(HISTORY_PAIRS * 2))
    )
  );

  enforceHistoryUserLimit();
}

function enforceHistoryUserLimit() {
  let count = 0;

  for (const key of memory.keys()) {
    if (key.startsWith("history:")) {
      count++;
    }
  }

  if (count <= MAX_HISTORY_USERS) return;

  for (const key of memory.keys()) {
    if (!key.startsWith("history:")) continue;

    memory.delete(key);
    count--;

    if (count <= MAX_HISTORY_USERS) break;
  }
}

function setPref(userId, key, value) {
  const id = String(userId);
  const current = prefs.get(id) || {};

  current[key] = String(value).slice(0, 200);

  prefs.set(id, current);

  trimMap(prefs, MAX_HISTORY_USERS);
}

function getPref(userId, key) {
  return prefs.get(String(userId))?.[key];
}

function clearUserMemory(userId) {
  memory.delete(historyKey(userId));
}

function clearAllCache() {
  memory.clear();
  prefs.clear();
  recentReactions.clear();

  modelCatalog = null;
  modelCatalogLoadedAt = 0;
  modelCatalogAttemptedAt = 0;
}

// ============================================================
// METRICS
// ============================================================

const stats = {
  started: Date.now(),
  requests: 0,
  errors: 0,
  searches: 0,
  searchFailures: 0,
  images: 0,
  files: 0,
  telegramErrors: 0,
  openRouterErrors: 0,
  firstTokenMs: [],
  totalMs: [],
};

function pushMetric(list, value) {
  if (!Number.isFinite(value)) return;

  list.push(Math.max(0, Math.round(value)));

  if (list.length > STATS_SAMPLE_LIMIT) {
    list.shift();
  }
}

function avg(values) {
  return values.length
    ? Math.round(
        values.reduce(
          (a, b) => a + b,
          0
        ) / values.length
      )
    : 0;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor(
    (seconds % 86400) / 3600
  );
  const m = Math.floor(
    (seconds % 3600) / 60
  );
  const s = seconds % 60;

  return [
    d ? `${d}d` : "",
    h ? `${h}h` : "",
    m ? `${m}m` : "",
    `${s}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

function statusText(admin = false) {
  const uptime = Math.floor(
    (Date.now() - stats.started) / 1000
  );

  const lines = [
    "🤖 *Bot Status*",
    "",
    `Uptime: ${esc(formatUptime(uptime))}`,
    `Requests: ${stats.requests}`,
    `Errors: ${stats.errors}`,
    `Searches: ${stats.searches}`,
    `Images: ${stats.images}`,
    `Files: ${stats.files}`,
    `Avg first token: ${
      stats.firstTokenMs.length
        ? `${avg(stats.firstTokenMs)} ms`
        : "—"
    }`,
    `Avg total: ${
      stats.totalMs.length
        ? `${avg(stats.totalMs)} ms`
        : "—"
    }`,
  ];

  if (admin) {
    lines.push(
      "",
      `Telegram errors: ${stats.telegramErrors}`,
      `OpenRouter errors: ${stats.openRouterErrors}`,
      `Search failures: ${stats.searchFailures}`,
      `Memory entries: ${memory.size}`,
      `Preferences: ${prefs.size}`,
      `In-flight queues: ${inFlightQueues.size}`
    );
  }

  return lines.join("\n");
}

// ============================================================
// SMART REACTIONS
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
  love:
    /\b(love|adorable|beautiful|cute|sweet)\b|❤️|😍|🥰|عاشق|عشق|قشنگ|ناز|دوست دارم/i,

  praise:
    /\b(good job|well done|nice job|great job|awesome|amazing|excellent|perfect|thank you|thanks)\b|ممنون|مرسی|دمت گرم|عالی|فوق.?العاده/i,

  hype:
    /\b(excited|can't wait|lets go|let's go|insane|huge)\b|🔥|بزن بریم|هیجان/i,

  sad:
    /\b(sad|depressed|crying|heartbroken|lost|miss|upset|disappointed)\b|😭|😢|غمگین|ناراحتم|گریه|دلتنگ|ناامید/i,

  angry:
    /\b(angry|furious|pissed|hate|wtf|bullshit)\b|😡|🤬|عصبانی|اعصابم|لعنت|مزخرف|افتضاح/i,

  funny:
    /\b(lol|lmao|rofl|haha+|hehe+|funny|joke)\b|😂|🤣|خنده|جوک|باحال/i,

  surprise:
    /\b(no way|really\?|seriously\?|unbelievable|shocking)\b|🤯|😮|😲|جدی؟|واقعا؟|چی؟|باورم نمیشه/i,

  help:
    /\b(help|can you|could you|please|how do i|how can i|show me|fix this|teach me)\b|کمک|میشه|میتونی|لطفا|چطور|چجوری|درستش کن/i,

  code:
    /\b(code|coding|program|programming|developer|debug|bug|error|exception|javascript|typescript|python|java|react|node|html|css|api|sql|github|git|docker|kubernetes|cloudflare|render|webhook)\b|کد|برنامه.?نویسی|باگ|خطا|پایتون|جاوااسکریپت/i,

  science:
    /\b(physics|chemistry|biology|quantum|science|math|mathematics|space|black hole|genetics)\b|فیزیک|شیمی|زیست|علم|کوانتوم|ریاضی|فضا/i,

  money:
    /\b(money|price|cost|budget|stock|crypto|bitcoin|ethereum|dollar|euro|forex|invest|business|salary|profit)\b|قیمت|پول|سهام|کریپتو|بیت.?کوین|دلار|یورو|سرمایه|کسب.?و.?کار|حقوق/i,

  news:
    /\b(latest|breaking|news|today|recent|current|what happened|update|election|president|war)\b|اخبار|امروز|جدیدترین|آخرین|جنگ|انتخابات|خبر جدید/i,

  travel:
    /\b(travel|trip|flight|hotel|vacation|tourist|tourism|visa|airport|passport)\b|سفر|پرواز|هتل|تعطیلات|ویزا|فرودگاه|پاسپورت/i,

  food:
    /\b(food|cook|cooking|recipe|restaurant|dinner|lunch|breakfast|pizza|burger|coffee|tea)\b|غذا|آشپزی|دستور.?غذا|رستوران|پیتزا|برگر|قهوه|چای/i,

  relationship:
    /\b(relationship|girlfriend|boyfriend|wife|husband|crush|date|love|breakup|friendship)\b|رابطه|دوست.?دختر|دوست.?پسر|همسر|عشق|جدایی|کراش|دوستی/i,
};

function chooseReaction(text, image = false, userId = "") {
  const s = String(text || "").trim();

  if (image && !s) return "👀";

  const score = new Map(
    RX.map((emoji) => [emoji, 0])
  );

  const add = (emoji, points) => {
    score.set(
      emoji,
      (score.get(emoji) || 0) + points
    );
  };

  if (
    /😭|😢|sad|depressed|غمگین|ناراحت|دلتنگ|ناامید/i.test(
      s
    )
  ) {
    add("😢", 30);
    add("😭", 10);
    add("💔", 8);
  }

  if (
    /😡|🤬|angry|furious|عصبانی|مزخرف|افتضاح/i.test(
      s
    )
  ) {
    add("😡", 30);
    add("👎", 7);
  }

  if (/😂|🤣|haha+|lol|lmao/i.test(s)) {
    add("😂", 30);
  }

  if (
    /❤️|😍|🥰|love|عشق|دوست دارم/i.test(
      s
    )
  ) {
    add("❤️", 28);
  }

  if (
    /🔥|excited|let's go|lets go|بزن بریم/i.test(
      s
    )
  ) {
    add("🔥", 25);
  }

  if (
    /🤯|😮|😲|no way|جدی؟|واقعا؟/i.test(
      s
    )
  ) {
    add("😮", 26);
    add("🤯", 8);
  }

  if (
    RX_PATTERNS.praise.test(s)
  ) {
    add("💯", 7);
    add("👏", 5);
  }

  if (
    RX_PATTERNS.help.test(s)
  ) {
    add("🙏", 5);
    add("🤔", 4);
  }

  if (
    RX_PATTERNS.code.test(s)
  ) {
    add("💡", 6);
    add("🧠", 4);
  }

  if (
    RX_PATTERNS.science.test(s)
  ) {
    add("🧠", 7);
    add("💡", 4);
  }

  if (
    RX_PATTERNS.money.test(s)
  ) {
    add("🧐", 7);
    add("💯", 3);
  }

  if (
    RX_PATTERNS.news.test(s)
  ) {
    add("🧐", 7);
    add("👀", 3);
  }

  if (
    RX_PATTERNS.travel.test(s)
  ) {
    add("✨", 6);
    add("👀", 3);
  }

  if (
    RX_PATTERNS.food.test(s)
  ) {
    add("❤️", 5);
    add("✨", 2);
  }

  if (
    RX_PATTERNS.relationship.test(s)
  ) {
    add("❤️", 7);
    add("💔", 4);
  }

  if (/[?؟]/.test(s)) {
    add("🤔", 5);
  }

  if (/[!！]{2,}/.test(s)) {
    add("🔥", 4);
  }

  if (image) {
    add("👀", 8);
  }

  let candidates = [...score.entries()]
    .sort((a, b) => b[1] - a[1]);

  if (
    !candidates.length ||
    candidates[0][1] <= 0
  ) {
    candidates = [["👍", 1]];
  }

  const last =
    recentReactions.get(String(userId))?.emoji;

  if (
    last &&
    candidates.length > 1 &&
    candidates[0][0] === last
  ) {
    candidates = candidates.slice(1);
  }

  const best =
    candidates[0]?.[0] || "👍";

  if (userId) {
    recentReactions.set(String(userId), {
      emoji: best,
      expires:
        Date.now() + REACTION_MEMORY_TTL_MS,
    });
  }

  return best;
}

// ============================================================
// TELEGRAM HTTP
// ============================================================

async function tg(
  method,
  body,
  {
    retries = 1,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = {}
) {
  if (!BOT_TOKEN) {
    return {
      ok: false,
      description: "BOT_TOKEN is missing",
    };
  }

  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    try {
      const response = await fetch(
        `${TG_API}/bot${BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify(
            body ?? {}
          ),
          signal:
            AbortSignal.timeout(
              timeoutMs
            ),
        }
      );

      const raw =
        await response.text();

      let data;

      try {
        data = raw
          ? JSON.parse(raw)
          : { ok: response.ok };
      } catch {
        data = {
          ok: false,
          description:
            raw ||
            response.statusText,
        };
      }

      if (
        response.ok &&
        data?.ok
      ) {
        return data;
      }

      stats.telegramErrors++;

      const retryAfter = Number(
        data?.parameters?.retry_after ||
          0
      );

      if (
        response.status === 429 &&
        attempt < retries
      ) {
        await sleep(
          Math.min(
            Math.max(
              retryAfter * 1000,
              250
            ),
            10000
          )
        );

        continue;
      }

      return data;
    } catch (error) {
      stats.telegramErrors++;

      if (attempt < retries) {
        await sleep(
          250 * (attempt + 1)
        );
        continue;
      }

      return {
        ok: false,
        description:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  return {
    ok: false,
    description:
      "Telegram request failed",
  };
}

async function sendMessage(
  chatId,
  text,
  replyTo,
  options = {}
) {
  const clean = String(text ?? "");

  if (!clean) {
    return {
      ok: false,
      description: "Empty message",
    };
  }

  const base = {
    chat_id: chatId,
    text: clean,

    ...(replyTo
      ? {
          reply_parameters: {
            message_id: replyTo,
          },
        }
      : {}),
  };

  if (options.markdown !== false) {
    const richText =
      await tg("sendMessage", {
        ...base,
        parse_mode: "MarkdownV2",
      });

    if (richText?.ok) {
      return richText;
    }
  }

  return tg("sendMessage", base);
}

async function sendPlain(
  chatId,
  text,
  replyTo
) {
  const clean = String(text ?? "");

  if (!clean) {
    return {
      ok: false,
      description: "Empty message",
    };
  }

  return tg("sendMessage", {
    chat_id: chatId,
    text: clean,

    ...(replyTo
      ? {
          reply_parameters: {
            message_id: replyTo,
          },
        }
      : {}),
  });
}

async function editMessagePlain(
  chatId,
  messageId,
  text
) {
  const clean = String(text ?? "");

  if (!clean) {
    return {
      ok: false,
      description: "Empty message",
    };
  }

  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: clean,
  });
}

async function editMessageRich(
  chatId,
  messageId,
  text
) {
  const clean = String(text ?? "");

  if (!clean) {
    return {
      ok: false,
      description: "Empty message",
    };
  }

  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,

    rich_message: {
      markdown: clean,
      is_rtl: detectRtl(clean),
    },
  });
}

async function sendRichMessage(
  chatId,
  text,
  replyTo
) {
  const clean = String(text ?? "");

  if (!clean) {
    return {
      ok: false,
      description:
        "Empty rich message",
    };
  }

  const rich =
    await tg("sendRichMessage", {
      chat_id: chatId,

      rich_message: {
        markdown: clean,
        is_rtl: detectRtl(clean),
      },

      ...(replyTo
        ? {
            reply_parameters: {
              message_id: replyTo,
            },
          }
        : {}),
    });

  if (rich?.ok) {
    return rich;
  }

  if (clean.length > TG_LIMIT) {
    return {
      ok: false,
      description:
        "Rich message unavailable for oversized chunk.",
    };
  }

  return sendMessage(
    chatId,
    clean,
    replyTo,
    {
      markdown: true,
    }
  );
}

async function sendRichMessageDraft(
  chatId,
  draftId,
  text
) {
  const clean = String(text ?? "")
    .slice(0, RICH_LIMIT);

  return tg(
    "sendRichMessageDraft",
    {
      chat_id: chatId,
      draft_id: draftId,

      rich_message: {
        markdown: clean,
        is_rtl: detectRtl(clean),
      },
    },
    {
      retries: 0,
    }
  );
}

async function sendTextMessageDraft(
  chatId,
  draftId,
  text
) {
  const clean = String(text ?? "")
    .slice(0, TG_LIMIT);

  return tg(
    "sendMessageDraft",
    {
      chat_id: chatId,
      draft_id: draftId,
      text: clean,
    },
    {
      retries: 0,
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
      retries: 0,
    }
  );
}

async function reactMessage(
  chatId,
  messageId,
  emoji
) {
  if (!RX.includes(emoji)) return;

  const result =
    await tg(
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
        retries: 0,
      }
    );

  if (!result.ok) {
    console.warn(
      `Reaction failed: ${sanitizeLog(
        result.description
      )}`
    );
  }
}

async function getMe() {
  const result =
    await tg("getMe", {});

  if (result.ok) {
    botInfo = result.result;
    botId = result.result.id;
  }

  return result;
}

// ============================================================
// FILES / IMAGES
// ============================================================

const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const FILE_MIME_BY_EXT = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",

  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",

  ts: "text/typescript",
  jsx: "text/jsx",
  tsx: "text/tsx",

  py: "text/x-python",
  java: "text/x-java-source",

  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++src",
  hpp: "text/x-c++src",

  cs: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  php: "text/plain",
  rb: "text/plain",

  sh: "text/x-shellscript",
  bash: "text/x-shellscript",

  html: "text/html",
  htm: "text/html",
  css: "text/css",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",

  log: "text/plain",
  rtf: "application/rtf",

  pdf: "application/pdf",

  doc: "application/msword",

  docx:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  xls: "application/vnd.ms-excel",

  xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

  ppt: "application/vnd.ms-powerpoint",

  pptx:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  odt:
    "application/vnd.oasis.opendocument.text",

  ods:
    "application/vnd.oasis.opendocument.spreadsheet",

  odp:
    "application/vnd.oasis.opendocument.presentation",

  zip: "application/zip",
};

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/javascript",
  "text/typescript",
  "text/jsx",
  "text/tsx",
  "text/x-python",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++src",
  "text/x-shellscript",
  "text/html",
  "text/css",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/rtf",
]);

function extensionOf(value) {
  const clean = String(
    value || ""
  )
    .toLowerCase()
    .split(/[?#]/)[0];

  const index =
    clean.lastIndexOf(".");

  return index >= 0
    ? clean.slice(index + 1)
    : "";
}

function mimeFromExtension(value) {
  return (
    FILE_MIME_BY_EXT[
      extensionOf(value)
    ] || ""
  );
}

function normalizeMime(value) {
  return String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function detectImageMime(
  buffer,
  path = "",
  httpMime = ""
) {
  const candidate =
    normalizeMime(httpMime);

  const extMime =
    mimeFromExtension(path);

  if (
    IMAGE_MIMES.has(candidate) &&
    imageMagicMatches(
      buffer,
      candidate
    )
  ) {
    return candidate;
  }

  if (
    IMAGE_MIMES.has(extMime) &&
    imageMagicMatches(
      buffer,
      extMime
    )
  ) {
    return extMime;
  }

  return "";
}

function imageMagicMatches(
  buffer,
  mime
) {
  const b = Buffer.from(buffer);

  if (!b.length) return false;

  if (mime === "image/jpeg") {
    return (
      b.length >= 3 &&
      b[0] === 0xff &&
      b[1] === 0xd8 &&
      b[2] === 0xff
    );
  }

  if (mime === "image/png") {
    return (
      b.length >= 8 &&
      b
        .subarray(0, 8)
        .equals(
          Buffer.from([
            137,
            80,
            78,
            71,
            13,
            10,
            26,
            10,
          ])
        )
    );
  }

  if (mime === "image/gif") {
    return (
      b.length >= 6 &&
      [
        "GIF87a",
        "GIF89a",
      ].includes(
        b.subarray(0, 6)
          .toString("ascii")
      )
    );
  }

  if (mime === "image/webp") {
    return (
      b.length >= 12 &&
      b
        .subarray(0, 4)
        .toString("ascii") ===
        "RIFF" &&
      b
        .subarray(8, 12)
        .toString("ascii") ===
        "WEBP"
    );
  }

  return false;
}

function detectFileMime(
  fileName,
  declaredMime,
  httpMime,
  buffer
) {
  const declared =
    normalizeMime(declaredMime);

  const http =
    normalizeMime(httpMime);

  const ext =
    mimeFromExtension(fileName);

  const candidates = [
    declared,
    http,
    ext,
  ].filter(Boolean);

  for (const mime of candidates) {
    if (
      mime ===
      "application/octet-stream"
    ) {
      continue;
    }

    if (IMAGE_MIMES.has(mime)) {
      if (
        imageMagicMatches(
          buffer,
          mime
        )
      ) {
        return mime;
      }

      continue;
    }

    return mime;
  }

  return "";
}

async function telegramFile(
  fileId
) {
  const meta =
    await tg("getFile", {
      file_id: fileId,
    });

  if (!meta.ok) {
    throw new Error(
      "Telegram could not resolve the file."
    );
  }

  const path = String(
    meta.result?.file_path || ""
  );

  const fileSize = Number(
    meta.result?.file_size || 0
  );

  if (!path) {
    throw new Error(
      "Telegram returned no file path."
    );
  }

  if (
    fileSize &&
    fileSize > MAX_DOWNLOAD_BYTES
  ) {
    throw new Error(
      `File is too large to process here (max ${Math.floor(
        MAX_DOWNLOAD_BYTES /
          (1024 * 1024)
      )} MB).`
    );
  }

  const response = await fetch(
    `${TG_API}/file/bot${BOT_TOKEN}/${path}`,
    {
      signal:
        AbortSignal.timeout(
          REQUEST_TIMEOUT_MS
        ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `File download failed (${response.status}).`
    );
  }

  const httpMime =
    normalizeMime(
      response.headers.get(
        "content-type"
      )
    );

  const contentLength = Number(
    response.headers.get(
      "content-length"
    ) || 0
  );

  if (
    contentLength >
    MAX_DOWNLOAD_BYTES
  ) {
    throw new Error(
      `File is too large to process here (max ${Math.floor(
        MAX_DOWNLOAD_BYTES /
          (1024 * 1024)
      )} MB).`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  if (
    arrayBuffer.byteLength >
    MAX_DOWNLOAD_BYTES
  ) {
    throw new Error(
      `File is too large to process here (max ${Math.floor(
        MAX_DOWNLOAD_BYTES /
          (1024 * 1024)
      )} MB).`
    );
  }

  const buffer =
    Buffer.from(arrayBuffer);

  return {
    buffer,
    path,
    httpMime,
    fileSize: buffer.length,
    base64:
      buffer.toString("base64"),
  };
}

function decodeTextFile(
  buffer,
  fileName,
  mime = ""
) {
  const normalized =
    normalizeMime(mime);

  const ext =
    extensionOf(fileName);

  const textLike =
    TEXT_MIMES.has(normalized) ||
    [
      "txt",
      "md",
      "markdown",
      "csv",
      "json",
      "js",
      "mjs",
      "cjs",
      "ts",
      "jsx",
      "tsx",
      "py",
      "java",
      "c",
      "h",
      "cpp",
      "hpp",
      "cs",
      "go",
      "rs",
      "php",
      "rb",
      "sh",
      "bash",
      "html",
      "htm",
      "css",
      "xml",
      "yaml",
      "yml",
      "log",
    ].includes(ext);

  if (!textLike) return null;

  return Buffer.from(buffer)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .slice(
      0,
      MAX_FILE_TEXT_CHARS
    );
}

function filePartFromDownload(
  file,
  fileName,
  declaredMime
) {
  const mime =
    detectFileMime(
      fileName,
      declaredMime,
      file.httpMime,
      file.buffer
    );

  if (
    !mime ||
    mime ===
      "application/octet-stream"
  ) {
    return null;
  }

  if (
    file.buffer.length >
    MAX_OR_FILE_BYTES
  ) {
    return null;
  }

  return {
    filename:
      String(
        fileName || "file"
      ).slice(0, 255),

    file_data:
      `data:${mime};base64,${file.base64}`,

    mime,
  };
}

// ============================================================
// WEB SEARCH
// ============================================================

const SEARCH_TOOL = [
  {
    type: "function",

    function: {
      name: "web_search",

      description:
        "Search the web for current, recent, live, or externally verifiable information. Use it when facts may have changed or need verification.",

      parameters: {
        type: "object",

        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
        },

        required: ["query"],

        additionalProperties: false,
      },
    },
  },
];

async function searchWeb(
  query
) {
  if (!LANGSEARCH_KEY) {
    throw new Error(
      "Web search is not configured."
    );
  }

  const cleanQuery =
    String(query || "")
      .trim()
      .slice(0, 500);

  if (!cleanQuery) {
    throw new Error(
      "Search query is empty."
    );
  }

  stats.searches++;

  const response =
    await fetch(
      LANGSEARCH_API,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",

          authorization:
            `Bearer ${LANGSEARCH_KEY}`,
        },

        body: JSON.stringify({
          query: cleanQuery,
          freshness: "noLimit",
          summary: true,
          count: 5,
        }),

        signal:
          AbortSignal.timeout(
            REQUEST_TIMEOUT_MS
          ),
      }
    );

  if (!response.ok) {
    stats.searchFailures++;

    throw new Error(
      `Search service returned ${response.status}.`
    );
  }

  let data;

  try {
    data =
      await response.json();
  } catch {
    stats.searchFailures++;

    throw new Error(
      "Search service returned invalid JSON."
    );
  }

  const results =
    Array.isArray(
      data?.data?.webPages?.value
    )
      ? data.data.webPages.value
      : [];

  if (!results.length) {
    return (
      "No useful search results were returned."
    );
  }

  return results
    .slice(0, 5)
    .map(
      (item, index) => {
        const name =
          String(
            item?.name ||
              "Untitled"
          ).slice(0, 180);

        const url =
          String(
            item?.url || ""
          ).slice(0, 500);

        const summary =
          String(
            item?.summary ||
              item?.snippet ||
              ""
          ).slice(0, 700);

        return [
          `[${index + 1}] ${name}`,
          `URL: ${url}`,
          summary,
        ].join("\n");
      }
    )
    .join("\n\n");
}

// ============================================================
// OPENROUTER / MODEL DISCOVERY
// ============================================================

async function fetchModelCatalog(
  force = false
) {
  const now = Date.now();

  if (
    !force &&
    modelCatalog &&
    now -
      modelCatalogLoadedAt <
      10 * 60 * 1000
  ) {
    return modelCatalog;
  }

  if (
    !force &&
    modelCatalogAttemptedAt &&
    now -
      modelCatalogAttemptedAt <
      60 * 1000
  ) {
    return modelCatalog;
  }

  if (!OR_KEY) return null;

  modelCatalogAttemptedAt = now;

  try {
    const response =
      await fetch(
        OR_MODELS_API,
        {
          headers: {
            authorization:
              `Bearer ${OR_KEY}`,
          },

          signal:
            AbortSignal.timeout(
              15000
            ),
        }
      );

    if (!response.ok) {
      return null;
    }

    const data =
      await response.json();

    if (!Array.isArray(data?.data)) {
      return null;
    }

    modelCatalog =
      new Map(
        data.data.map(
          (item) => [
            String(item.id),
            item,
          ]
        )
      );

    modelCatalogLoadedAt =
      now;

    modelCatalogAttemptedAt =
      now;

    return modelCatalog;
  } catch {
    return null;
  }
}

async function getModelInfo(
  model
) {
  const catalog =
    await fetchModelCatalog(
      false
    );

  return (
    catalog?.get(model) ||
    null
  );
}

async function ensureImageModel(
  model
) {
  /*
   * openrouter/free is explicitly documented
   * by OpenRouter as an image-capable router.
   */
  if (
    model ===
    "openrouter/free"
  ) {
    return true;
  }

  const info =
    await getModelInfo(model);

  const modalities =
    info?.architecture
      ?.input_modalities;

  if (!Array.isArray(modalities)) {
    throw new Error(
      "Vision model capability could not be verified. Set OPENROUTER_VISION_MODEL to a model with image input support."
    );
  }

  if (
    !modalities.includes(
      "image"
    )
  ) {
    throw new Error(
      `Configured vision model does not accept image input: ${model}`
    );
  }

  return true;
}

function chooseModel({
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

async function buildOpenRouterBody(
  messages,
  model,
  mode,
  tools
) {
  const body = {
    model,
    messages,
    stream: true,
  };

  let info = null;

  if (
    mode === "deep" ||
    tools?.length
  ) {
    info =
      await getModelInfo(model);
  }

  const supported =
    new Set(
      Array.isArray(
        info?.supported_parameters
      )
        ? info.supported_parameters
        : []
    );

  if (tools?.length) {
    const toolSupported =
      model === "openrouter/free" ||
      supported.has("tools");

    if (toolSupported) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
  }

  if (
    mode === "deep" &&
    supported.has(
      "reasoning"
    )
  ) {
    const efforts =
      info?.reasoning
        ?.supported_efforts;

    if (
      Array.isArray(efforts) &&
      efforts.length
    ) {
      const desired = [
        "high",
        "max",
        "xhigh",
        "medium",
      ].find((effort) =>
        efforts.includes(
          effort
        )
      );

      if (desired) {
        body.reasoning = {
          effort: desired,
          exclude: true,
        };
      } else {
        body.reasoning = {
          effort: efforts[0],
          exclude: true,
        };
      }
    } else {
      body.reasoning = {
        effort: "high",
        exclude: true,
      };
    }
  }

  return body;
}

async function orRequest(
  messages,
  model,
  mode,
  tools = null
) {
  if (!OR_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is missing."
    );
  }

  const body =
    await buildOpenRouterBody(
      messages,
      model,
      mode,
      tools
    );

  let response;

  try {
    response =
      await fetch(
        OR_API,
        {
          method: "POST",

          headers: {
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
          },

          body: JSON.stringify(
            body
          ),

          signal:
            AbortSignal.timeout(
              REQUEST_TIMEOUT_MS
            ),
        }
      );
  } catch (error) {
    stats.openRouterErrors++;

    throw new Error(
      `OpenRouter request failed: ${
        error instanceof Error
          ? error.message
          : "network error"
      }`
    );
  }

  if (!response.ok) {
    stats.openRouterErrors++;

    const raw =
      await response.text()
        .catch(() => "");

    let detail = "";

    try {
      const parsed =
        raw
          ? JSON.parse(raw)
          : null;

      detail =
        parsed?.error?.message ||
        parsed?.message ||
        "";
    } catch {
      detail = raw;
    }

    const suffix = detail
      ? `: ${sanitizeLog(
          detail
        ).slice(0, 300)}`
      : "";

    throw new OpenRouterError(
      response.status,
      `OpenRouter returned ${response.status}${suffix}`
    );
  }

  if (!response.body) {
    throw new OpenRouterError(
      502,
      "OpenRouter returned an empty stream."
    );
  }

  return response;
}

class OpenRouterError extends Error {
  constructor(
    status,
    message
  ) {
    super(message);

    this.name =
      "OpenRouterError";

    this.status = status;
  }
}

function cleanSystem(
  userId,
  mode
) {
  const extra = [];

  if (mode === "fast") {
    extra.push(
      "Be concise and prioritize speed. Do not search the web unless the system permits it."
    );
  }

  if (mode === "deep") {
    extra.push(
      "Be thorough. Verify time-sensitive claims with web search when appropriate."
    );
  }

  if (
    LANGSEARCH_KEY &&
    mode !== "fast"
  ) {
    extra.push(
      "Use the web_search tool when information is current, recent, live, or requires external verification. Do not search unnecessarily."
    );
  }

  extra.push(
    "Never expose internal tool calls, hidden reasoning, API keys, secrets, or implementation details."
  );

  extra.push(
    "Return a normal user-facing answer. Do not use hidden XML-style reaction tags or metadata markers."
  );

  const prefStyle =
    getPref(
      userId,
      "style"
    );

  const prefLang =
    getPref(
      userId,
      "language"
    );

  if (prefStyle) {
    extra.push(
      `Preferred style: ${prefStyle}.`
    );
  }

  if (prefLang) {
    extra.push(
      `Preferred language: ${prefLang}.`
    );
  }

  return (
    SYSTEM_PROMPT +
    (
      extra.length
        ? `\n\n${extra.join(
            "\n"
          )}`
        : ""
    )
  );
}

async function buildMessages({
  userId,
  prompt,
  image,
  file,
  fileText,
  mode,
}) {
  const messages = [
    {
      role: "system",
      content:
        cleanSystem(
          userId,
          mode
        ),
    },
  ];

  if (
    !image &&
    !file
  ) {
    messages.push(
      ...getHistory(
        userId
      ).slice(
        -(HISTORY_PAIRS * 2)
      )
    );
  }

  if (image) {
    messages.push({
      role: "user",

      content: [
        {
          type: "text",
          text:
            prompt ||
            "Describe this image in detail.",
        },

        {
          type: "image_url",

          image_url: {
            url:
              `data:${image.mime};base64,${image.base64}`,
          },
        },
      ],
    });

    return messages;
  }

  if (file?.part) {
    messages.push({
      role: "user",

      content: [
        {
          type: "text",
          text:
            prompt ||
            `Analyze the attached file: ${file.name}`,
        },

        {
          type: "file",

          file: {
            filename:
              file.part.filename,

            file_data:
              file.part.file_data,
          },
        },
      ],
    });

    return messages;
  }

  const finalPrompt =
    fileText
      ? [
          prompt ||
            "Analyze this file.",

          `File name: ${
            file?.name ||
            "unknown"
          }`,

          "File contents:",

          fileText,
        ].join("\n\n")
      : prompt;

  messages.push({
    role: "user",
    content: String(
      finalPrompt || ""
    ).slice(
      0,
      MAX_USER_PROMPT_CHARS +
        MAX_FILE_TEXT_CHARS
    ),
  });

  return messages;
}

// ============================================================
// STREAMING SSE
// ============================================================

async function streamOpenRouter(
  response,
  onPiece,
  onToolCalls
) {
  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let pending = "";

  const toolCalls = [];

  while (true) {
    const {
      value,
      done,
    } = await reader.read();

    if (done) break;

    pending +=
      decoder.decode(
        value,
        {
          stream: true,
        }
      );

    const lines =
      pending.split(
        /\r?\n/
      );

    pending =
      lines.pop() || "";

    for (
      const rawLine of lines
    ) {
      processSseLine(
        rawLine,
        onPiece,
        toolCalls
      );
    }
  }

  pending +=
    decoder.decode();

  if (pending) {
    for (
      const rawLine of pending.split(
        /\r?\n/
      )
    ) {
      processSseLine(
        rawLine,
        onPiece,
        toolCalls
      );
    }
  }

  if (
    typeof onToolCalls ===
    "function"
  ) {
    onToolCalls(
      toolCalls.filter(
        validToolCall
      )
    );
  }
}

function processSseLine(
  rawLine,
  onPiece,
  toolCalls
) {
  const line =
    rawLine.trim();

  if (
    !line.startsWith(
      "data:"
    )
  ) {
    return;
  }

  const payload =
    line.slice(5).trim();

  if (
    !payload ||
    payload === "[DONE]"
  ) {
    return;
  }

  let chunk;

  try {
    chunk =
      JSON.parse(payload);
  } catch {
    return;
  }

  const delta =
    chunk?.choices?.[0]
      ?.delta;

  if (
    Array.isArray(
      delta?.tool_calls
    )
  ) {
    mergeTools(
      toolCalls,
      delta.tool_calls
    );
  }

  const piece =
    typeof delta?.content ===
    "string"
      ? delta.content
      : "";

  if (
    piece &&
    typeof onPiece ===
      "function"
  ) {
    onPiece(piece);
  }
}

function mergeTools(
  acc,
  deltas
) {
  for (
    const delta of deltas
  ) {
    const index =
      Number.isInteger(
        delta?.index
      )
        ? delta.index
        : 0;

    if (!acc[index]) {
      acc[index] = {
        id: "",
        type: "function",

        function: {
          name: "",
          arguments: "",
        },
      };
    }

    if (delta?.id) {
      acc[index].id =
        delta.id;
    }

    if (
      delta?.function?.name
    ) {
      acc[index]
        .function.name +=
        delta.function.name;
    }

    if (
      delta?.function
        ?.arguments
    ) {
      acc[index]
        .function.arguments +=
        delta.function.arguments;
    }
  }
}

function validToolCall(
  call
) {
  return Boolean(
    call?.id &&
    call?.type ===
      "function" &&
    call?.function?.name ===
      "web_search"
  );
}

function parseSearchQuery(
  call
) {
  try {
    const parsed =
      JSON.parse(
        call?.function
          ?.arguments ||
          "{}"
      );

    return String(
      parsed?.query || ""
    )
      .trim()
      .slice(0, 500);
  } catch {
    return "";
  }
}

async function performToolCalls(
  toolCalls,
  searchState
) {
  const assistantToolCalls =
    toolCalls.map(
      (call) => ({
        id: call.id,
        type: "function",

        function: {
          name:
            "web_search",
          arguments:
            call.function
              ?.arguments ||
            "{}",
        },
      })
    );

  const toolMessages = [];

  for (
    const call of toolCalls
  ) {
    let result =
      "No search result.";

    const query =
      parseSearchQuery(
        call
      );

    if (!query) {
      result =
        "The search request was invalid because no query was supplied.";
    } else if (
      searchState.count >=
      MAX_SEARCHES
    ) {
      result =
        "Search limit reached for this request. Continue using the information already gathered.";
    } else {
      searchState.count++;

      try {
        result =
          await searchWeb(
            query
          );
      } catch (error) {
        result =
          `Search failed gracefully: ${
            error instanceof Error
              ? error.message
              : "unknown error"
          }`;
      }
    }

    toolMessages.push({
      role: "tool",
      tool_call_id:
        call.id,

      content:
        result.slice(
          0,
          6000
        ),
    });
  }

  return {
    assistantToolCalls,
    toolMessages,
  };
}

// ============================================================
// AI GENERATION
// ============================================================

async function generate({
  chatId,
  userId,
  prompt,
  image,
  file,
  fileText,
  mode,
  replyTo,
  isPrivate,
}) {
  const started =
    Date.now();

  stats.requests++;

  let full = "";
  let firstTokenRecorded =
    false;

  let finalModel = null;

  let streamMessageId =
    null;

  let lastEdit = 0;

  const draftIdValue =
    randomDraftId();

  let groupEditChain =
    Promise.resolve();

  let draftChain =
    Promise.resolve();

  let typingTimer = null;

  let draftFallbackMessageId =
    null;

  let useRichDraft =
    isPrivate;

  try {
    finalModel =
      chooseModel({
        image: Boolean(
          image
        ),
        file: Boolean(
          file
        ),
        mode,
      });

    if (image) {
      await ensureImageModel(
        finalModel
      );
    }

    console.log(
      `[request] model=${sanitizeLog(
        finalModel
      )} mode=${mode} image=${Boolean(
        image
      )} file=${Boolean(file)}`
    );

    const messages =
      await buildMessages({
        userId,
        prompt,
        image,
        file,
        fileText,
        mode,
      });

    if (!isPrivate) {
      const placeholder =
        await sendPlain(
          chatId,
          "🧠 Thinking…",
          replyTo
        );

      if (
        !placeholder?.ok ||
        !placeholder
          ?.result
          ?.message_id
      ) {
        throw new Error(
          "Could not create the Telegram streaming message."
        );
      }

      streamMessageId =
        placeholder.result
          .message_id;
    } else {
      draftChain =
        draftChain.then(
          async () => {
            const result =
              await sendRichMessageDraft(
                chatId,
                draftIdValue,
                ""
              );

            if (result.ok) {
              return;
            }

            const plain =
              await sendTextMessageDraft(
                chatId,
                draftIdValue,
                ""
              );

            if (plain.ok) {
              useRichDraft =
                false;
              return;
            }

            useRichDraft = false;

            const fallback =
              await sendPlain(
                chatId,
                "🧠 Thinking…",
                replyTo
              );

            if (fallback?.ok) {
              draftFallbackMessageId =
                fallback.result
                  ?.message_id ||
                null;
            }
          }
        );
    }

    typingTimer =
      setInterval(
        () => {
          typing(chatId)
            .catch(() => {});
        },
        TYPING_MS
      );

    typingTimer.unref?.();

    const searchState = {
      count: 0,
    };

    for (
      let round = 0;
      round < MAX_TOOL_ROUNDS;
      round++
    ) {
      let roundText = "";

      const toolCalls = [];

      const allowTools =
        Boolean(
          LANGSEARCH_KEY &&
          mode !== "fast" &&
          searchState.count <
            MAX_SEARCHES
        );

      const response =
        await orRequest(
          messages,
          finalModel,
          mode,
          allowTools
            ? SEARCH_TOOL
            : null
        );

      await streamOpenRouter(
        response,

        (piece) => {
          if (
            !firstTokenRecorded
          ) {
            firstTokenRecorded =
              true;

            pushMetric(
              stats.firstTokenMs,
              Date.now() -
                started
            );
          }

          roundText +=
            piece;

          full += piece;

          const now =
            Date.now();

          if (isPrivate) {
            if (
              now - lastEdit >=
                DRAFT_UPDATE_MS &&
              full.trim()
            ) {
              lastEdit = now;

              const preview =
                full.slice(
                  0,
                  RICH_LIMIT
                );

              draftChain =
                draftChain
                  .then(
                    async () => {
                      if (
                        useRichDraft
                      ) {
                        const richResult =
                          await sendRichMessageDraft(
                            chatId,
                            draftIdValue,
                            preview
                          );

                        if (
                          !richResult.ok
                        ) {
                          useRichDraft =
                            false;

                          const plainResult =
                            await sendTextMessageDraft(
                              chatId,
                              draftIdValue,
                              preview.slice(
                                0,
                                TG_LIMIT
                              )
                            );

                          if (
                            !plainResult.ok &&
                            !draftFallbackMessageId
                          ) {
                            const fallback =
                              await sendPlain(
                                chatId,
                                "🧠 Thinking…",
                                replyTo
                              );

                            if (
                              fallback?.ok
                            ) {
                              draftFallbackMessageId =
                                fallback
                                  .result
                                  ?.message_id ||
                                null;
                            }
                          }
                        }
                      } else if (
                        draftFallbackMessageId
                      ) {
                        const plain =
                          await editMessagePlain(
                            chatId,
                            draftFallbackMessageId,
                            preview.slice(
                              0,
                              TG_LIMIT
                            )
                          );

                        if (!plain.ok) {
                          draftFallbackMessageId =
                            null;
                        }
                      } else {
                        const plain =
                          await sendTextMessageDraft(
                            chatId,
                            draftIdValue,
                            preview.slice(
                              0,
                              TG_LIMIT
                            )
                          );

                        if (!plain.ok) {
                          const fallback =
                            await sendPlain(
                              chatId,
                              "🧠 Thinking…",
                              replyTo
                            );

                          if (
                            fallback?.ok
                          ) {
                            draftFallbackMessageId =
                              fallback
                                .result
                                ?.message_id ||
                              null;
                          }
                        }
                      }
                    }
                  )
                  .catch(
                    () => {}
                  );
            }
          } else if (
            streamMessageId &&
            now - lastEdit >=
              STREAM_EDIT_MS
          ) {
            lastEdit = now;

            const preview =
              full.slice(
                0,
                TG_LIMIT
              );

            groupEditChain =
              groupEditChain
                .then(
                  () =>
                    editMessagePlain(
                      chatId,
                      streamMessageId,
                      preview
                    )
                )
                .catch(
                  () => {}
                );
          }
        },

        (calls) => {
          toolCalls.push(
            ...calls
          );
        }
      );

      const validTools =
        toolCalls.filter(
          validToolCall
        );

      if (
        !validTools.length ||
        !allowTools
      ) {
        break;
      }

      const {
        assistantToolCalls,
        toolMessages,
      } = await performToolCalls(
        validTools,
        searchState
      );

      messages.push({
        role: "assistant",
        content:
          roundText || null,
        tool_calls:
          assistantToolCalls,
      });

      messages.push(
        ...toolMessages
      );
    }

    if (typingTimer) {
      clearInterval(
        typingTimer
      );
    }

    typingTimer = null;

    await Promise.allSettled(
      [
        groupEditChain,
        draftChain,
      ]
    );

    if (!full.trim()) {
      throw new Error(
        "The model returned no visible answer."
      );
    }

    if (isPrivate) {
      if (draftFallbackMessageId) {
        const finalParts =
          splitText(
            full,
            TG_LIMIT
          );

        if (
          finalParts[0]
        ) {
          let edited =
            await editMessageRich(
              chatId,
              draftFallbackMessageId,
              finalParts[0]
            );

          if (!edited.ok) {
            edited =
              await tg(
                "editMessageText",
                {
                  chat_id: chatId,
                  message_id:
                    draftFallbackMessageId,
                  text: finalParts[0],
                  parse_mode:
                    "MarkdownV2",
                }
              );
          }

          if (!edited.ok) {
            await editMessagePlain(
              chatId,
              draftFallbackMessageId,
              finalParts[0]
            );
          }
        }

        for (
          let i = 1;
          i < finalParts.length;
          i++
        ) {
          await sendRichMessage(
            chatId,
            finalParts[i]
          );
        }
      } else {
        await sendRichChunked(
          chatId,
          full,
          replyTo
        );
      }
    } else if (
      streamMessageId
    ) {
      await finalizeGroup(
        chatId,
        streamMessageId,
        full
      );
    } else {
      await sendRichChunked(
        chatId,
        full,
        replyTo
      );
    }

    pushMetric(
      stats.totalMs,
      Date.now() - started
    );

    saveHistory(
      userId,
      prompt,
      full
    );

    console.log(
      `[complete] model=${sanitizeLog(
        finalModel
      )} chars=${full.length} total_ms=${
        Date.now() - started
      } searches=${
        searchState.count
      }`
    );

    return full;
  } catch (error) {
    stats.errors++;

    if (typingTimer) {
      clearInterval(
        typingTimer
      );
    }

    typingTimer = null;

    await Promise.allSettled(
      [
        groupEditChain,
        draftChain,
      ]
    );

    const publicMessage =
      userFacingError(error);

    console.error(
      `[generate:error] model=${sanitizeLog(
        finalModel || "unknown"
      )} status=${
        error?.status || "n/a"
      } message=${sanitizeLog(
        error?.message || error
      )}`
    );

    try {
      if (!full.trim()) {
        if (streamMessageId) {
          await editMessagePlain(
            chatId,
            streamMessageId,
            publicMessage
          );
        } else if (
          draftFallbackMessageId
        ) {
          await editMessagePlain(
            chatId,
            draftFallbackMessageId,
            publicMessage
          );
        } else {
          await sendMessage(
            chatId,
            publicMessage,
            replyTo
          );
        }
      } else {
        const partial =
          `${full}\n\n⚠️ I couldn't finish this response.`;

        if (streamMessageId) {
          const firstPart =
            splitText(
              partial,
              TG_LIMIT
            )[0];

          let edited =
            await editMessageRich(
              chatId,
              streamMessageId,
              firstPart
            );

          if (!edited.ok) {
            edited =
              await tg(
                "editMessageText",
                {
                  chat_id: chatId,
                  message_id:
                    streamMessageId,
                  text: firstPart,
                  parse_mode:
                    "MarkdownV2",
                }
              );
          }

          if (!edited.ok) {
            await editMessagePlain(
              chatId,
              streamMessageId,
              firstPart
            );
          }
        } else {
          await sendRichChunked(
            chatId,
            partial,
            replyTo
          );
        }
      }
    } catch {
      try {
        await sendPlain(
          chatId,
          publicMessage,
          replyTo
        );
      } catch {}
    }

    throw error;
  }
}

// ============================================================
// FINAL MESSAGE HELPERS
// ============================================================

async function finalizeGroup(
  chatId,
  messageId,
  text
) {
  const parts =
    splitText(
      text,
      TG_LIMIT
    );

  if (!parts.length) return;

  let first =
    await editMessageRich(
      chatId,
      messageId,
      parts[0]
    );

  if (!first.ok) {
    first =
      await tg(
        "editMessageText",
        {
          chat_id: chatId,
          message_id: messageId,
          text: parts[0],
          parse_mode:
            "MarkdownV2",
        }
      );
  }

  if (!first.ok) {
    await editMessagePlain(
      chatId,
      messageId,
      parts[0]
    );
  }

  for (
    let i = 1;
    i < parts.length;
    i++
  ) {
    await sendRichMessage(
      chatId,
      parts[i]
    );

    if (
      i <
      parts.length - 1
    ) {
      await sleep(40);
    }
  }
}

async function sendRichChunked(
  chatId,
  text,
  replyTo
) {
  const richParts =
    splitText(
      text,
      RICH_LIMIT
    );

  let first = true;

  for (
    const richPart of richParts
  ) {
    const result =
      await sendRichMessage(
        chatId,
        richPart,
        first
          ? replyTo
          : undefined
      );

    if (result.ok) {
      first = false;
      await sleep(40);
      continue;
    }

    const fallbackParts =
      splitText(
        richPart,
        TG_LIMIT
      );

    for (
      const fallbackPart of fallbackParts
    ) {
      const fallback =
        await sendMessage(
          chatId,
          fallbackPart,
          first
            ? replyTo
            : undefined
        );

      if (!fallback.ok) {
        throw new Error(
          "Telegram could not send the final response."
        );
      }

      first = false;

      await sleep(40);
    }
  }
}

function splitText(
  text,
  limit
) {
  const input =
    String(text || "");

  if (!input) return [];

  if (
    input.length <= limit
  ) {
    return [input];
  }

  const result = [];

  let start = 0;

  while (
    start <
    input.length
  ) {
    const maxEnd =
      Math.min(
        start + limit,
        input.length
      );

    if (
      maxEnd >=
      input.length
    ) {
      const tail =
        input
          .slice(start)
          .trim();

      if (tail) {
        result.push(tail);
      }

      break;
    }

    const window =
      input.slice(
        start,
        maxEnd
      );

    const newline =
      window.lastIndexOf(
        "\n\n"
      );

    const newlineSingle =
      window.lastIndexOf(
        "\n"
      );

    const sentence =
      Math.max(
        window.lastIndexOf(
          ". "
        ),
        window.lastIndexOf(
          "! "
        ),
        window.lastIndexOf(
          "? "
        ),
        window.lastIndexOf(
          "؟ "
        ),
        window.lastIndexOf(
          "。"
        )
      );

    const space =
      window.lastIndexOf(
        " "
      );

    let cut;

    if (
      newline >=
      Math.floor(
        limit * 0.45
      )
    ) {
      cut =
        start +
        newline +
        2;
    } else if (
      newlineSingle >=
      Math.floor(
        limit * 0.5
      )
    ) {
      cut =
        start +
        newlineSingle +
        1;
    } else if (
      sentence >=
      Math.floor(
        limit * 0.55
      )
    ) {
      cut =
        start +
        sentence +
        2;
    } else if (
      space >=
      Math.floor(
        limit * 0.55
      )
    ) {
      cut =
        start +
        space +
        1;
    } else {
      cut = maxEnd;
    }

    const part =
      input
        .slice(
          start,
          cut
        )
        .trim();

    if (part) {
      result.push(part);
    }

    start = cut;
  }

  return result;
}

// ============================================================
// COMMANDS
// ============================================================

function parseCommand(text) {
  const raw =
    String(text || "")
      .trim();

  if (!raw.startsWith("/")) {
    return null;
  }

  const [
    first,
    ...rest
  ] = raw.split(/\s+/);

  const [
    commandName,
  ] = first.split("@");

  return {
    command:
      commandName.toLowerCase(),

    arg:
      rest
        .join(" ")
        .trim(),
  };
}

async function command(
  chatId,
  userId,
  text,
  messageId
) {
  const parsed =
    parseCommand(text);

  if (!parsed) return false;

  switch (
    parsed.command
  ) {
    case "/start":
      await sendMessage(
        chatId,
        [
          "🤖 *Welcome.*",
          "",
          "Send me a message to chat. In groups, mention me, reply to me, or use the trigger command.",
          "",
          "Use /help to see everything I support.",
        ].join("\n"),
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
          `✍️ Style set to: *${esc(
            parsed.arg
          )}*`,
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
          `🌐 Language set to: *${esc(
            parsed.arg
          )}*`,
          messageId
        );
      }

      return true;

    case "/clear":
    case "/clearmemory":
      clearUserMemory(
        userId
      );

      await sendMessage(
        chatId,
        "🧹 *Conversation memory cleared.*",
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
          "🤖 *Active models*",
          "",

          `Normal: \`${escCode(
            TEXT_MODEL
          )}\``,

          `Fast: \`${escCode(
            FAST_MODEL
          )}\``,

          `Deep: \`${escCode(
            DEEP_MODEL
          )}\``,

          `Vision: \`${escCode(
            VISION_MODEL
          )}\``,

          `Files: \`${escCode(
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

function helpText() {
  return [
    "🤖 *How to use the bot*",
    "",

    "💬 *Chat*",
    "• In a private chat, send a normal message.",
    "• In a group, mention me, reply to one of my messages, or use the trigger command.",
    `• Trigger command: \`${esc(
      TRIGGER || "!ai"
    )} your message\``,

    "",

    "⚡ *Modes*",
    "• `/fast` — prioritize speed and concise answers.",
    "• `/normal` — balanced default behavior.",
    "• `/deep` — more thorough reasoning and web research when useful.",

    "",

    "🧠 *Memory*",
    `• The bot keeps the most recent ${HISTORY_PAIRS} conversation pair${
      HISTORY_PAIRS === 1
        ? ""
        : "s"
    } in memory per user.`,

    "• `/clear` or `/clearmemory` clears your conversation history.",
    "• Memory is local to the running service and resets when it restarts.",

    "",

    "🌐 *Web search*",
    "• The bot can search automatically when a question needs current, recent, live, or externally verifiable information.",
    "• Search is not used for every message, and fast mode does not use the search tool.",

    "",

    "🖼 *Images*",
    "• Send an image with an optional question or instruction.",
    "• Images are automatically routed to the configured vision model.",
    "• Supported image formats: JPEG, PNG, WEBP, and GIF.",

    "",

    "📄 *Files*",
    "• You can attach common documents and text/code files.",
    "• The bot safely forwards supported files to the configured file model; text-like files can also be processed as text.",
    "• Processing is subject to Telegram/OpenRouter file-size and model limits.",

    "",

    "⚙️ *Preferences*",
    "• `/style concise` — choose a response style.",
    "• `/language English` — choose a preferred response language.",

    "",

    "📊 *Info*",
    "• `/status` — current runtime statistics.",
    "• `/stats` — same user-safe statistics view.",
    "• `/models` — active text, fast, deep, vision, and file models.",
    "• `/help` — show this guide again.",
  ].join("\n");
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

const ADMIN_IDS =
  new Set(
    String(
      process.env.ADMIN_IDS || ""
    )
      .split(",")
      .map(
        (value) =>
          value.trim()
      )
      .filter(Boolean)
  );

async function adminCommand(
  chatId,
  userId,
  text,
  messageId
) {
  if (
    !ADMIN_IDS.has(
      String(userId)
    )
  ) {
    return false;
  }

  const parsed =
    parseCommand(text);

  if (!parsed) return false;

  switch (
    parsed.command
  ) {
    case "/admin":
    case "/dev":
      await sendMessage(
        chatId,
        statusText(true),
        messageId
      );

      return true;

    case "/clearcache":
      clearAllCache();

      await sendMessage(
        chatId,
        "🧹 *Cache and in-memory state cleared.*",
        messageId
      );

      return true;

    default:
      return false;
  }
}

// ============================================================
// TARGETING
// ============================================================

function botMentioned(text) {
  if (!BOT_USERNAME) {
    return false;
  }

  const username =
    escapeRegExp(
      BOT_USERNAME
    );

  return new RegExp(
    `@${username}\\b`,
    "i"
  ).test(
    String(text || "")
  );
}

function triggerUsed(text) {
  if (!TRIGGER) {
    return false;
  }

  const source =
    String(text || "")
      .trim();

  const lower =
    source.toLowerCase();

  const trigger =
    TRIGGER.toLowerCase();

  return (
    lower === trigger ||
    lower.startsWith(
      `${trigger} `
    )
  );
}

function repliedToBot(
  message
) {
  const from =
    message
      ?.reply_to_message
      ?.from;

  if (!from?.is_bot) {
    return false;
  }

  if (
    botId &&
    from.id === botId
  ) {
    return true;
  }

  if (
    BOT_USERNAME &&
    String(
      from.username || ""
    ).toLowerCase() ===
      BOT_USERNAME.toLowerCase()
  ) {
    return true;
  }

  return false;
}

function stripTargeting(
  text
) {
  let result =
    String(text || "")
      .trim();

  if (BOT_USERNAME) {
    result = result
      .replace(
        new RegExp(
          `@${escapeRegExp(
            BOT_USERNAME
          )}\\b`,
          "ig"
        ),
        ""
      )
      .trim();
  }

  if (
    TRIGGER &&
    triggerUsed(result)
  ) {
    result =
      result
        .slice(
          TRIGGER.length
        )
        .trim();
  }

  return result;
}

// ============================================================
// UPDATE PROCESSING
// ============================================================

async function handleUpdate(
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
    message.from?.id ??
    chatId;

  const messageId =
    message.message_id;

  const text =
    String(
      message.text || ""
    );

  const caption =
    String(
      message.caption || ""
    );

  const sourceText =
    text || caption;

  const photos =
    Array.isArray(
      message.photo
    )
      ? message.photo
      : [];

  const isImage =
    photos.length > 0;

  const isFile =
    Boolean(
      message.document
    );

  const isPrivate =
    message.chat.type ===
    "private";

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
    const targeted =
      botMentioned(
        sourceText
      ) ||
      triggerUsed(
        sourceText
      ) ||
      repliedToBot(
        message
      );

    if (
      !targeted &&
      !isImage
    ) {
      return;
    }
  }

  const prompt =
    stripTargeting(
      sourceText
    ).slice(
      0,
      MAX_USER_PROMPT_CHARS
    );

  const rx =
    chooseReaction(
      prompt ||
        sourceText,
      isImage,
      userId
    );

  reactMessage(
    chatId,
    messageId,
    rx
  ).catch(
    () => {}
  );

  let image = null;
  let file = null;
  let fileText = "";

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (isImage) {
    stats.images++;

    try {
      const downloaded =
        await telegramFile(
          photos[
            photos.length - 1
          ].file_id
        );

      const mime =
        detectImageMime(
          downloaded.buffer,
          downloaded.path,
          downloaded.httpMime
        );

      if (!mime) {
        await sendMessage(
          chatId,
          "❌ I could not safely identify that image format. Please send a JPEG, PNG, WEBP, or GIF.",
          messageId
        );

        return;
      }

      image = {
        buffer:
          downloaded.buffer,

        base64:
          downloaded.base64,

        mime,
      };
    } catch (error) {
      await sendMessage(
        chatId,
        `❌ Image processing failed: ${esc(
          error instanceof Error
            ? error.message
            : "unknown error"
        )}`,
        messageId
      );

      return;
    }
  }

  // ----------------------------------------------------------
  // FILE
  // ----------------------------------------------------------

  if (isFile) {
    stats.files++;

    const document =
      message.document;

    const fileName =
      String(
        document.file_name ||
          "file"
      );

    try {
      const downloaded =
        await telegramFile(
          document.file_id
        );

      const mime =
        detectFileMime(
          fileName,
          document.mime_type,
          downloaded.httpMime,
          downloaded.buffer
        );

      if (!mime) {
        await sendMessage(
          chatId,
          "❌ I could not safely identify that file type.",
          messageId
        );

        return;
      }

      const decoded =
        decodeTextFile(
          downloaded.buffer,
          fileName,
          mime
        );

      const part =
        filePartFromDownload(
          downloaded,
          fileName,
          mime
        );

      file = {
        name: fileName,
        mime,
        part,
      };

      fileText =
        decoded || "";

      if (
        !part &&
        !fileText
      ) {
        await sendMessage(
          chatId,
          "❌ This file was downloaded successfully, but it is too large or not in a safely supported format for direct AI processing.",
          messageId
        );

        return;
      }
    } catch (error) {
      await sendMessage(
        chatId,
        `❌ File processing failed: ${esc(
          error instanceof Error
            ? error.message
            : "unknown error"
        )}`,
        messageId
      );

      return;
    }
  }

  const mode =
    normalizeMode(
      getPref(
        userId,
        "mode"
      )
    );

  return enqueueUser(
    userId,
    () =>
      generate({
        chatId,
        userId,

        prompt:
          prompt ||
          (
            isImage
              ? "Describe this image in detail."
              : isFile
              ? "Analyze this file."
              : ""
          ),

        image,
        file,
        fileText,
        mode,

        replyTo:
          messageId,

        isPrivate,
      })
  ).catch(
    () => {}
  );
}

function normalizeMode(
  mode
) {
  return [
    "fast",
    "normal",
    "deep",
  ].includes(mode)
    ? mode
    : "normal";
}

function enqueueUser(
  userId,
  task
) {
  const key =
    String(userId);

  const previous =
    inFlightQueues.get(
      key
    ) ||
    Promise.resolve();

  const next =
    previous
      .catch(
        () => {}
      )
      .then(task);

  const tracked =
    next.finally(
      () => {
        if (
          inFlightQueues.get(
            key
          ) === tracked
        ) {
          inFlightQueues.delete(
            key
          );
        }
      }
    );

  inFlightQueues.set(
    key,
    tracked
  );

  return tracked;
}

// ============================================================
// GLOBAL CONCURRENCY
// ============================================================

let activeJobs = 0;

const pendingJobs = [];

function withGlobalConcurrency(
  task
) {
  return new Promise(
    (resolve, reject) => {
      pendingJobs.push({
        task,
        resolve,
        reject,
      });

      drainJobs();
    }
  );
}

function drainJobs() {
  while (
    activeJobs <
      MAX_GLOBAL_CONCURRENCY &&
    pendingJobs.length
  ) {
    const job =
      pendingJobs.shift();

    activeJobs++;

    Promise.resolve()
      .then(job.task)
      .then(
        job.resolve,
        job.reject
      )
      .finally(() => {
        activeJobs--;

        drainJobs();
      });
  }
}

function processUpdate(
  update
) {
  return withGlobalConcurrency(
    () =>
      handleUpdate(
        update
      )
  );
}

// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function randomDraftId() {
  return Math.max(
    1,
    Math.floor(
      Math.random() *
        0x7fffffff
    )
  );
}

function esc(value) {
  return String(
    value ?? ""
  ).replace(
    /[_*\[\]()~`>#+\-=|{}.!\\]/g,
    "\\$&"
  );
}

function escCode(value) {
  return String(
    value ?? ""
  ).replace(
    /[`\\]/g,
    "\\$&"
  );
}

function escapeRegExp(
  value
) {
  return String(
    value ?? ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function sanitizeLog(
  value
) {
  return String(
    value ?? ""
  )
    .replace(
      /[\r\n]+/g,
      " "
    )
    .replace(
      /\s{2,}/g,
      " "
    )
    .slice(0, 500);
}

function detectRtl(
  text
) {
  const value =
    String(text || "");

  const rtl =
    (
      value.match(
        /[\u0590-\u08ff]/g
      ) || []
    ).length;

  const ltr =
    (
      value.match(
        /[A-Za-z]/g
      ) || []
    ).length;

  return (
    rtl > 10 &&
    rtl >= ltr * 0.25
  );
}

function userFacingError(
  error
) {
  const status =
    Number(
      error?.status || 0
    );

  if (
    status === 401 ||
    status === 403
  ) {
    return "❌ The AI provider rejected the request. Please check the bot configuration.";
  }

  if (status === 429) {
    return "❌ The AI service is temporarily rate-limited. Please try again in a moment.";
  }

  if (status >= 500) {
    return "❌ The AI service is temporarily unavailable. Please try again shortly.";
  }

  return "❌ I could not complete that request right now. Please try again.";
}

// ============================================================
// EXPRESS / WEBHOOK
// ============================================================

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

app.get(
  "/",
  (_req, res) => {
    res
      .status(200)
      .type("text/plain")
      .send("AI Bot Running");
  }
);

app.get(
  "/health",
  (_req, res) => {
    const healthy =
      Boolean(
        BOT_TOKEN &&
        OR_KEY &&
        WEBHOOK_SECRET &&
        WEBHOOK_PATH_TOKEN
      );

    res
      .status(
        healthy
          ? 200
          : 503
      )
      .json({
        ok: healthy,

        uptime_seconds:
          Math.floor(
            (Date.now() -
              stats.started) /
              1000
          ),
      });
  }
);

if (
  RAW_WEBHOOK_PATH_TOKEN &&
  !/^[A-Za-z0-9._~-]{8,256}$/.test(
    RAW_WEBHOOK_PATH_TOKEN
  )
) {
  console.error(
    "WEBHOOK_PATH_TOKEN contains unsafe URL characters. Use a URL-safe token."
  );
}

app.post(
  WEBHOOK_PATH,
  (req, res) => {
    const secret =
      req.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

    if (
      !WEBHOOK_SECRET ||
      !safeHeaderEqual(
        secret,
        WEBHOOK_SECRET
      )
    ) {
      return res
        .status(401)
        .type("text/plain")
        .send("Unauthorized");
    }

    const updateId =
      req.body?.update_id;

    if (
      updateId !==
        undefined &&
      updateId !== null
    ) {
      const key =
        `update:${String(
          updateId
        )}`;

      if (
        seenUpdates.has(
          key
        )
      ) {
        return res
          .status(200)
          .send("OK");
      }

      seenUpdates.set(
        key,
        Date.now() +
          SEEN_UPDATE_TTL_SEC *
            1000
      );
    }

    // Acknowledge Telegram immediately.
    res
      .status(200)
      .send("OK");

    processUpdate(
      req.body
    ).catch(
      (error) => {
        console.error(
          `[processUpdate:error] ${sanitizeLog(
            error?.message ||
              error
          )}`
        );
      }
    );
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

    if (
      !safeHeaderEqual(
        req.get(
          "X-Guest-Secret"
        ),
        GUEST_SECRET
      )
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
      )
        .trim()
        .slice(
          0,
          MAX_USER_PROMPT_CHARS
        );

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
      .status(200)
      .json({
        ok: true,
      });

    enqueueUser(
      `guest:${chatId}`,
      () =>
        withGlobalConcurrency(
          () =>
            generate({
              chatId,

              userId:
                `guest:${chatId}`,

              prompt,

              image: null,
              file: null,
              fileText: "",

              mode: "normal",

              replyTo:
                undefined,

              isPrivate:
                true,
            })
        )
    ).catch(
      () => {}
    );
  }
);

// ============================================================
// STARTUP
// ============================================================

const server =
  app.listen(
    PORT,
    async () => {
      console.log(
        `Server listening on ${PORT}`
      );

      console.log(
        "Webhook route configured."
      );

      try {
        const me =
          await getMe();

        if (me.ok) {
          console.log(
            `Bot connected${
              me.result
                ?.username
                ? ` as @${sanitizeLog(
                    me.result
                      .username
                  )}`
                : ""
            }.`
          );
        } else {
          console.error(
            `Telegram getMe failed: ${sanitizeLog(
              me.description
            )}`
          );
        }
      } catch (error) {
        console.error(
          `Telegram startup check failed: ${sanitizeLog(
            error?.message ||
              error
          )}`
        );
      }

      fetchModelCatalog(
        false
      ).catch(
        () => {}
      );
    }
  );

server.on(
  "error",
  (error) => {
    console.error(
      `HTTP server error: ${sanitizeLog(
        error?.message ||
          error
      )}`
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      `[unhandledRejection] ${sanitizeLog(
        reason?.message ||
          reason
      )}`
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      `[uncaughtException] ${sanitizeLog(
        error?.message ||
          error
      )}`
    );
  }
);

function safeHeaderEqual(
  a,
  b
) {
  const x =
    Buffer.from(
      String(a || "")
    );

  const y =
    Buffer.from(
      String(b || "")
    );

  if (
    x.length !==
    y.length
  ) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i < x.length;
    i++
  ) {
    diff |=
      x[i] ^ y[i];
  }

  return diff === 0;
}
