import express from "express";

// ============================================================
// CONFIG
// ============================================================

const TG = "https://api.telegram.org";
const OR = "https://openrouter.ai/api/v1/chat/completions";

const TEXT_MODEL = process.env.OPENROUTER_MODEL || "minimax/minimax-m2.7:free";
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "openrouter/free";
const FILE_MODEL = process.env.OPENROUTER_FILE_MODEL || "openrouter/free";

const PORT = process.env.PORT || 3000;
const WEBHOOK_PATH_TOKEN = process.env.WEBHOOK_PATH_TOKEN || "change-this-token";
const WEBHOOK_PATH = `/webhook/${WEBHOOK_PATH_TOKEN}`;

const BOT_TOKEN = process.env.BOT_TOKEN;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const BOT_USERNAME = process.env.BOT_USERNAME || "";
const TRIGGER = process.env.TRIGGER_COMMAND || "!ai";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are a helpful AI assistant. Answer accurately, clearly, naturally, and concisely.";

const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY;
const GUEST_SECRET = process.env.GUEST_API_SECRET;

const MAX_SEARCHES = 3;
const HISTORY_PAIRS = 4;
const TG_LIMIT = 4096;
const RICH_LIMIT = 32768;

let botId = null;

// ============================================================
// SIMPLE MEMORY
// ============================================================

const mem = new Map();

function memGet(k) {
  const x = mem.get(k);
  if (!x) return null;
  if (x.expires && Date.now() > x.expires) {
    mem.delete(k);
    return null;
  }
  return x.value;
}

function memSet(k, value, ttl = 0) {
  mem.set(k, { value, expires: ttl ? Date.now() + ttl * 1000 : 0 });
}

setInterval(() => {
  for (const [k, x] of mem) {
    if (x.expires && Date.now() > x.expires) mem.delete(k);
  }
}, 300000);

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

function avg(a) {
  return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
}

function statusText() {
  const up = Math.floor((Date.now() - stats.started) / 1000);
  return [
    "🤖 *Bot Status*",
    "",
    `Uptime: ${up}s`,
    `Requests: ${stats.requests}`,
    `Errors: ${stats.errors}`,
    `Searches: ${stats.searches}`,
    `Images: ${stats.images}`,
    `Files: ${stats.files}`,
    `Avg first token: ${avg(stats.firstTokenMs)}ms`,
    `Avg total: ${avg(stats.totalMs)}ms`,
    "",
    `Text: \`${esc(TEXT_MODEL)}\``,
    `Vision: \`${esc(VISION_MODEL)}\``,
    `File: \`${esc(FILE_MODEL)}\``,
  ].join("\n");
}

// ============================================================
// REACTIONS
// ============================================================

const RX = [
  "👍","👎","❤️","🔥","😂","😢","😡","🤔","😮","🎉","💯","👀",
  "🧠","🙏","👏","💡","💔","🤝","🚀","✨","😎","😭","🥰","😴","🤯","🧐"
];

const P = {
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

function reaction(text, image = false) {
  const s = String(text || "").trim();
  if (image && !s) return "👀";

  const score = Object.fromEntries(RX.map(x => [x, 0]));
  const hit = (r) => r.test(s) ? 1 : 0;

  if (/😂|🤣|haha+|lol|lmao/i.test(s)) score["😂"] += 20;
  if (/😭|😢|sad|depressed|غمگین|ناراحت/i.test(s)) score["😢"] += 20;
  if (/😡|🤬|angry|furious|عصبانی/i.test(s)) score["😡"] += 20;
  if (/❤️|😍|🥰|love|عشق/i.test(s)) score["❤️"] += 20;
  if (/🔥|excited|بزن بریم/i.test(s)) score["🔥"] += 15;
  if (/🤯|😮|😲|no way|جدی؟/i.test(s)) score["😮"] += 18;
  if (/🙏|please|لطفا|کمک/i.test(s)) score["🙏"] += 8;

  score["❤️"] += hit(P.love) * 5;
  score["💯"] += hit(P.praise) * 4;
  score["👏"] += hit(P.praise) * 2;
  score["🔥"] += hit(P.hype) * 5;
  score["🚀"] += hit(P.hype) * 2;
  score["😢"] += hit(P.sad) * 6;
  score["😭"] += hit(P.sad) * 2;
  score["😡"] += hit(P.angry) * 7;
  score["😂"] += hit(P.funny) * 7;
  score["😮"] += hit(P.surprise) * 6;
  score["🤔"] += hit(P.help) * 4;
  score["💡"] += hit(P.code) * 4;
  score["🧠"] += hit(P.code) * 3;
  score["🧠"] += hit(P.science) * 5;
  score["💡"] += hit(P.science) * 2;
  score["🧐"] += hit(P.money) * 5;
  score["💯"] += hit(P.money) * 2;
  score["🧐"] += hit(P.news) * 6;
  score["👀"] += hit(P.news) * 2;
  score["✨"] += hit(P.travel) * 5;
  score["👀"] += hit(P.travel) * 2;
  score["❤️"] += hit(P.food) * 3;
  score["❤️"] += hit(P.relationship) * 5;
  score["💔"] += hit(P.relationship) * 3;

  if (/[?؟]/.test(s)) score["🤔"] += 4;
  if (/[!！]{2,}/.test(s)) score["🔥"] += 3;
  if (image) score["👀"] += 7;

  let best = "👍", bestScore = 0;
  for (const x of RX) {
    if (score[x] > bestScore) {
      best = x;
      bestScore = score[x];
    }
  }
  return best;
}

// ============================================================
// TELEGRAM
// ============================================================

async function tg(method, body) {
  try {
    const r = await fetch(`${TG}/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { ok: false, description: text }; }

    if (!r.ok) {
      const retry =
        r.status === 429 ? data?.parameters?.retry_after : null;

      if (retry && retry <= 10) {
        await sleep(retry * 1000);
        return tg(method, body);
      }
    }
    return data;
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

async function sendMessage(chatId, text, replyTo) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (replyTo) body.reply_to_message_id = replyTo;

  let r = await tg("sendMessage", body);
  if (!r.ok) {
    const plain = { chat_id: chatId, text };
    if (replyTo) plain.reply_to_message_id = replyTo;
    r = await tg("sendMessage", plain);
  }
  return r;
}

async function sendPlain(chatId, text, replyTo) {
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  return tg("sendMessage", body);
}

async function editMessage(chatId, messageId, text) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
  });
}

async function typing(chatId) {
  return tg("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

async function reactMessage(chatId, messageId, emoji) {
  if (!ALLOWED_REACTION(emoji)) return;
  const r = await tg("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
    is_big: false,
  });
  if (!r.ok) console.warn("Reaction failed:", r.description);
}

function ALLOWED_REACTION(x) {
  return RX.includes(x);
}

// ============================================================
// MEMORY / PREFERENCES
// ============================================================

async function getHistory(userId) {
  try {
    const x = memGet(`history:${userId}`);
    return x ? JSON.parse(x) : [];
  } catch {
    return [];
  }
}

async function saveHistory(userId, prompt, answer) {
  const h = await getHistory(userId);
  h.push({ role: "user", content: prompt });
  h.push({ role: "assistant", content: answer });
  memSet(
    `history:${userId}`,
    JSON.stringify(h.slice(-HISTORY_PAIRS * 2))
  );
}

const prefs = new Map();

function setPref(userId, key, value) {
  const p = prefs.get(userId) || {};
  p[key] = value;
  prefs.set(userId, p);
}

function getPref(userId, key) {
  return prefs.get(userId)?.[key];
}

// ============================================================
// FILES / IMAGES
// ============================================================

async function telegramFile(fileId) {
  const r = await tg("getFile", { file_id: fileId });
  if (!r.ok) throw new Error(r.description || "getFile failed");

  const path = r.result.file_path;
  const res = await fetch(`${TG}/file/bot${BOT_TOKEN}/${path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  let mime = (res.headers.get("content-type") || "")
    .split(";")[0]
    .toLowerCase();

  if (!mime.startsWith("image/") || mime === "application/octet-stream") {
    mime = imageMime(path);
  }

  return {
    buffer,
    path,
    mime,
    base64: Buffer.from(buffer).toString("base64"),
  };
}

function imageMime(path) {
  const x = String(path || "").toLowerCase();
  if (x.endsWith(".png")) return "image/png";
  if (x.endsWith(".webp")) return "image/webp";
  if (x.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function decodeTextFile(buffer, path = "") {
  const ext = path.toLowerCase().split(".").pop();
  if (["txt","md","json","csv","js","ts","py","java","html","css","log"].includes(ext)) {
    return Buffer.from(buffer).toString("utf8");
  }
  return null;
}

// ============================================================
// WEB SEARCH
// ============================================================

const SEARCH_TOOL = [{
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current or externally verifiable information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
}];

async function searchWeb(query) {
  if (!LANGSEARCH_KEY) throw new Error("LANGSEARCH_API_KEY not configured");

  stats.searches++;

  const r = await fetch("https://api.langsearch.com/v1/web-search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LANGSEARCH_KEY}`,
    },
    body: JSON.stringify({
      query,
      freshness: "noLimit",
      summary: true,
      count: 5,
    }),
  });

  if (!r.ok) throw new Error(`Search failed: ${r.status}`);

  const d = await r.json();
  const results = d?.data?.webPages?.value || [];

  return results.slice(0, 5).map((x, i) =>
    `[${i + 1}] ${x.name || ""}\nURL: ${x.url || ""}\n${(x.summary || x.snippet || "").slice(0, 500)}`
  ).join("\n\n");
}

// ============================================================
// OPENROUTER
// ============================================================

async function orRequest(messages, model, stream = true, tools = null) {
  if (!OR_KEY) throw new Error("OPENROUTER_API_KEY is missing");

  const body = {
    model,
    messages,
    stream,
  };

  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  return fetch(OR, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OR_KEY}`,
      "content-type": "application/json",
      ...(process.env.OPENROUTER_HTTP_REFERER
        ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
        : {}),
      ...(process.env.OPENROUTER_X_TITLE
        ? { "X-Title": process.env.OPENROUTER_X_TITLE }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

function cleanSystem(userId, mode) {
  let extra = "";

  if (mode === "fast") {
    extra += "\nBe concise and prioritize speed.";
  }

  if (mode === "deep") {
    extra += "\nBe thorough. Use web search when appropriate.";
  }

  const prefStyle = getPref(userId, "style");
  const prefLang = getPref(userId, "language");

  if (prefStyle) extra += `\nPreferred style: ${prefStyle}.`;
  if (prefLang) extra += `\nPreferred language: ${prefLang}.`;

  return SYSTEM_PROMPT + extra;
}

async function buildMessages(userId, prompt, image, mode) {
  const messages = [{
    role: "system",
    content: cleanSystem(userId, mode),
  }];

  if (!image) {
    const h = await getHistory(userId);
    messages.push(...h.slice(-HISTORY_PAIRS * 2));
  }

  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: prompt || "Describe this image in detail." },
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mime};base64,${image.base64}`,
          },
        },
      ],
    });
  } else {
    messages.push({
      role: "user",
      content: prompt,
    });
  }

  return messages;
}

// ============================================================
// MODEL ROUTING
// ============================================================

function chooseModel({ image, file, mode, prompt }) {
  if (image) return VISION_MODEL;
  if (file) return FILE_MODEL;
  if (mode === "fast") return TEXT_MODEL;
  if (mode === "deep") return TEXT_MODEL;

  const s = String(prompt || "");

  if (/image|screenshot|photo|picture|عکس|تصویر/i.test(s)) return VISION_MODEL;
  return TEXT_MODEL;
}

// ============================================================
// STREAMING
// ============================================================

async function generate({
  chatId,
  userId,
  prompt,
  image,
  fileText,
  mode,
  replyTo,
  isPrivate,
}) {
  const started = Date.now();
  stats.requests++;

  let streamMessage = null;
  let full = "";
  let firstToken = null;
  let searches = 0;
  let lastEdit = 0;

  try {
    const model = chooseModel({
      image,
      file: Boolean(fileText),
      mode,
      prompt,
    });

    const messages = await buildMessages(
      userId,
      fileText
        ? `${prompt}\n\nFile contents:\n${fileText.slice(0, 50000)}`
        : prompt,
      image,
      mode
    );

    if (!isPrivate) {
      streamMessage = await sendPlain(
        chatId,
        "🧠 Thinking…",
        replyTo
      );
      if (!streamMessage?.result) {
        throw new Error("Could not create streaming message");
      }
    }

    const timer = setInterval(() => {
      typing(chatId).catch(() => {});
    }, 5000);

    try {
      for (let round = 0; round < 5; round++) {
        full = "";

        const useTools =
          searches < MAX_SEARCHES &&
          mode !== "fast" &&
          !fileText?.length > 45000;

        const response = await orRequest(
          messages,
          model,
          true,
          useTools ? SEARCH_TOOL : null
        );

        if (!response.ok) {
          const e = await response.text();
          throw new Error(`OpenRouter ${response.status}: ${e}`);
        }

        if (!response.body) throw new Error("Empty OpenRouter body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const toolCalls = [];

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;

            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }

            const c = chunk?.choices?.[0];
            const d = c?.delta;

            if (d?.tool_calls) {
              mergeTools(toolCalls, d.tool_calls);
            }

            const piece = typeof d?.content === "string" ? d.content : "";
            if (!piece) continue;

            if (firstToken === null) {
              firstToken = Date.now() - started;
              stats.firstTokenMs.push(firstToken);
            }

            full += piece;

            if (isPrivate) {
              // Rich draft if available; otherwise plain messages at end.
              if (Date.now() - lastEdit > 900) {
                lastEdit = Date.now();
                await tg("sendRichMessageDraft", {
                  chat_id: chatId,
                  draft_id: draftId(),
                  rich_message: { markdown: full },
                }).catch(() => {});
              }
            } else if (streamMessage?.result?.message_id && Date.now() - lastEdit > 900) {
              lastEdit = Date.now();
              await editMessage(chatId, streamMessage.result.message_id, full.slice(0, TG_LIMIT));
            }
          }
        }

        const validTools = toolCalls.filter(
          x => x?.function?.name === "web_search" && x.id
        );

        if (validTools.length && useTools) {
          const assistantToolCalls = validTools.map(x => ({
            id: x.id,
            type: "function",
            function: {
              name: "web_search",
              arguments: x.function?.arguments || "{}",
            },
          }));

          const toolMessages = [];

          for (const call of validTools) {
            let q = "";
            try {
              q = JSON.parse(call.function.arguments || "{}")?.query || "";
            } catch {}

            let result = "No search result.";

            if (q && searches < MAX_SEARCHES) {
              searches++;
              try {
                result = await searchWeb(q);
              } catch (e) {
                result = `Search failed: ${e.message}`;
              }
            }

            toolMessages.push({
              role: "tool",
              tool_call_id: call.id,
              content: result,
            });
          }

          messages.push({
            role: "assistant",
            content: full,
            tool_calls: assistantToolCalls,
          });

          messages.push(...toolMessages);
          continue;
        }

        break;
      }
    } finally {
      clearInterval(timer);
    }

    if (!full.trim()) throw new Error("Model returned no answer");

    if (isPrivate) {
      await sendFinalPrivate(chatId, full, replyTo);
    } else if (streamMessage?.result?.message_id) {
      await finalizeGroup(chatId, streamMessage.result.message_id, full);
    } else {
      await sendChunked(chatId, full, replyTo);
    }

    stats.totalMs.push(Date.now() - started);
    await saveHistory(userId, prompt, full);

    return full;
  } catch (e) {
    stats.errors++;
    console.error("generate:", e);

    const msg = `❌ **Error generating response**\n\n${e.message}`;

    if (isPrivate) {
      await sendChunked(chatId, msg, replyTo).catch(() => {});
    } else if (streamMessage?.result?.message_id) {
      await editMessage(chatId, streamMessage.result.message_id, msg).catch(() => {});
    } else {
      await sendMessage(chatId, msg, replyTo).catch(() => {});
    }
    throw e;
  }
}

// ============================================================
// STREAM HELPERS
// ============================================================

function mergeTools(acc, deltas) {
  for (const d of deltas) {
    const i = typeof d.index === "number" ? d.index : 0;

    if (!acc[i]) {
      acc[i] = {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
    }

    if (d.id) acc[i].id = d.id;
    if (d.function?.name) acc[i].function.name += d.function.name;
    if (d.function?.arguments) acc[i].function.arguments += d.function.arguments;
  }
}

async function finalizeGroup(chatId, messageId, text) {
  const parts = splitText(text, TG_LIMIT);

  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      await editMessage(chatId, messageId, parts[i]);
    } else {
      await sendPlain(chatId, parts[i]);
    }
  }
}

async function sendFinalPrivate(chatId, text, replyTo) {
  const parts = splitText(text, RICH_LIMIT);

  for (let i = 0; i < parts.length; i++) {
    const r = await tg("sendRichMessage", {
      chat_id: chatId,
      rich_message: { markdown: parts[i] },
      ...(i === 0 && replyTo
        ? { reply_parameters: { message_id: replyTo } }
        : {}),
    });

    if (!r.ok) {
      await sendChunked(chatId, parts[i], i === 0 ? replyTo : undefined);
    }
  }
}

async function sendChunked(chatId, text, replyTo) {
  for (const [i, part] of splitText(text, TG_LIMIT).entries()) {
    await sendPlain(chatId, part, i === 0 ? replyTo : undefined);
    await sleep(40);
  }
}

function splitText(text, limit) {
  const s = String(text || "");
  if (s.length <= limit) return s ? [s] : [];

  const out = [];
  let i = 0;

  while (i < s.length) {
    let end = Math.min(i + limit, s.length);

    if (end < s.length) {
      const n = s.lastIndexOf("\n", end);
      const sp = s.lastIndexOf(" ", end);
      if (n > i + limit * 0.5) end = n + 1;
      else if (sp > i + limit * 0.5) end = sp + 1;
    }

    const part = s.slice(i, end).trim();
    if (part) out.push(part);
    i = end;
  }

  return out;
}

// ============================================================
// COMMANDS
// ============================================================

async function command(chatId, userId, text, messageId) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd.toLowerCase()) {
    case "/fast":
      setPref(userId, "mode", "fast");
      await sendMessage(chatId, "⚡ Fast mode enabled.", messageId);
      return true;

    case "/deep":
      setPref(userId, "mode", "deep");
      await sendMessage(chatId, "🧠 Deep mode enabled.", messageId);
      return true;

    case "/normal":
      setPref(userId, "mode", "normal");
      await sendMessage(chatId, "🙂 Normal mode enabled.", messageId);
      return true;

    case "/style":
      if (!arg) {
        await sendMessage(chatId, "Usage: `/style concise`", messageId);
      } else {
        setPref(userId, "style", arg);
        await sendMessage(chatId, `Style set to: *${esc(arg)}*`, messageId);
      }
      return true;

    case "/language":
      if (!arg) {
        await sendMessage(chatId, "Usage: `/language English`", messageId);
      } else {
        setPref(userId, "language", arg);
        await sendMessage(chatId, `Language set to: *${esc(arg)}*`, messageId);
      }
      return true;

    case "/clear":
    case "/clearmemory":
      mem.delete(`history:${userId}`);
      await sendMessage(chatId, "🧹 Memory cleared.", messageId);
      return true;

    case "/status":
      await sendMessage(chatId, statusText(), messageId);
      return true;

    case "/stats":
      await sendMessage(chatId, statusText(), messageId);
      return true;

    case "/models":
      await sendMessage(
        chatId,
        [
          "🤖 *Models*",
          "",
          `Text: \`${esc(TEXT_MODEL)}\``,
          `Vision: \`${esc(VISION_MODEL)}\``,
          `Files: \`${esc(FILE_MODEL)}\``,
        ].join("\n"),
        messageId
      );
      return true;

    case "/help":
      await sendMessage(
        chatId,
        [
          "🤖 *Commands*",
          "",
          "/fast — faster responses",
          "/normal — normal mode",
          "/deep — deeper responses",
          "/style concise",
          "/language English",
          "/clear — clear memory",
          "/status — bot statistics",
          "/models — active models",
          "",
          "Reply to a message with `/summarize`",
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

const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

async function adminCommand(chatId, userId, text, messageId) {
  if (!ADMIN_IDS.has(String(userId))) return false;

  switch (text.trim().split(/\s+/)[0].toLowerCase()) {
    case "/admin":
    case "/dev":
      await sendMessage(chatId, statusText(), messageId);
      return true;

    case "/clearcache":
      mem.clear();
      await sendMessage(chatId, "🧹 Cache cleared.", messageId);
      return true;

    default:
      return false;
  }
}

// ============================================================
// PROCESS UPDATE
// ============================================================

async function processUpdate(update) {
  const message = update?.message || update?.edited_message;
  if (!message?.chat) return;

  const chatId = message.chat.id;
  const userId = message.from?.id || chatId;
  const messageId = message.message_id;
  const text = message.text || "";
  const caption = message.caption || "";
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const isImage = photos.length > 0;
  const isPrivate = message.chat.type === "private";

  // ----------------------------------------------------------
  // Commands
  // ----------------------------------------------------------

  if (await adminCommand(chatId, userId, text, messageId)) return;
  if (await command(chatId, userId, text, messageId)) return;

  // ----------------------------------------------------------
  // Targeting
  // ----------------------------------------------------------

  if (!isPrivate) {
    const mentioned =
      BOT_USERNAME &&
      new RegExp(`@${escapeRegExp(BOT_USERNAME)}`, "i").test(text);

    const triggered =
      text.toLowerCase() === TRIGGER.toLowerCase() ||
      text.toLowerCase().startsWith(TRIGGER.toLowerCase() + " ");

    const replied =
      message.reply_to_message?.from?.is_bot &&
      (
        (botId && message.reply_to_message.from.id === botId) ||
        (BOT_USERNAME &&
          message.reply_to_message.from.username?.toLowerCase() ===
            BOT_USERNAME.replace(/^@/, "").toLowerCase())
      );

    if (!mentioned && !triggered && !replied && !isImage) return;
  }

  let prompt = text || caption;

  if (!isPrivate) {
    prompt = prompt
      .replace(new RegExp(`@${escapeRegExp(BOT_USERNAME || "")}`, "ig"), "")
      .replace(new RegExp(`^${escapeRegExp(TRIGGER)}\\s*`, "i"), "")
      .trim();
  }

  if (isImage && !prompt) {
    prompt = "Describe this image in detail.";
  }

  // ----------------------------------------------------------
  // Smart local reaction
  // ----------------------------------------------------------

  const rx = reaction(prompt || caption || text, isImage);

  // Reaction immediately; never blocks AI generation.
  reactMessage(chatId, messageId, rx).catch(() => {});

  // ----------------------------------------------------------
  // Attachments
  // ----------------------------------------------------------

  let image = null;
  let fileText = "";

  if (isImage) {
    stats.images++;

    try {
      image = await telegramFile(photos[photos.length - 1].file_id);
    } catch (e) {
      await sendMessage(chatId, `❌ Image processing failed: ${e.message}`, messageId);
      return;
    }
  }

  // Generic document support.
  if (message.document) {
    stats.files++;

    try {
      const f = await telegramFile(message.document.file_id);
      fileText =
        decodeTextFile(f.buffer, message.document.file_name || "") ||
        "";

      if (!fileText) {
        // For a PDF, extractable text isn't guaranteed through Telegram itself.
        // Send model a note rather than pretending we extracted it.
        fileText =
          `File name: ${message.document.file_name || "unknown"}\n` +
          `MIME type: ${message.document.mime_type || "unknown"}\n` +
          "The file was downloaded successfully, but local text extraction is unavailable for this file type.";
      }
    } catch (e) {
      await sendMessage(chatId, `❌ File processing failed: ${e.message}`, messageId);
      return;
    }
  }

  // ----------------------------------------------------------
  // Mode
  // ----------------------------------------------------------

  const mode =
    getPref(userId, "mode") ||
    (
      /\bdeep\b/i.test(text) ? "deep" :
      /\bfast\b/i.test(text) ? "fast" :
      "normal"
    );

  // ----------------------------------------------------------
  // AI
  // ----------------------------------------------------------

  try {
    await generate({
      chatId,
      userId,
      prompt,
      image,
      fileText,
      mode,
      replyTo: messageId,
      isPrivate,
    });
  } catch {}
}

// ============================================================
// UTILS
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function draftId() {
  return Math.floor(Math.random() * 2147483000) + 1;
}

function esc(x) {
  return String(x || "").replace(
    /([_*\[\]()~`>#+\-=|{}.!\\])/g,
    "\\$1"
  );
}

function escapeRegExp(x) {
  return String(x || "").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// ============================================================
// STARTUP
// ============================================================

if (!BOT_TOKEN) console.error("Missing BOT_TOKEN");
if (!OR_KEY) console.error("Missing OPENROUTER_API_KEY");
if (!WEBHOOK_SECRET) console.error("Missing WEBHOOK_SECRET");

const app = express();

app.use(express.json({ limit: "20mb" }));

app.get("/", (_, res) => {
  res.status(200).send("AI Bot Running");
});

app.post(WEBHOOK_PATH, async (req, res) => {
  const secret = req.get("X-Telegram-Bot-Api-Secret-Token");

  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  res.status(200).send("OK");

  const updateId = req.body?.update_id;

  if (updateId !== undefined) {
    const key = `update:${updateId}`;
    if (memGet(key)) return;
    memSet(key, true, 300);
  }

  processUpdate(req.body).catch(e =>
    console.error("processUpdate:", e)
  );
});

app.post("/guest", async (req, res) => {
  if (!GUEST_SECRET) return res.status(404).send("Not found");

  if (req.get("X-Guest-Secret") !== GUEST_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  res.status(200).send("OK");

  const g = req.body || {};
  const chatId = g.chat_id || g.chatId;

  if (!chatId) return;

  try {
    await generate({
      chatId,
      userId: `guest:${chatId}`,
      prompt: g.prompt || g.text || "",
      image: null,
      fileText: "",
      mode: "normal",
      replyTo: undefined,
      isPrivate: true,
    });
  } catch {}
});

app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  console.log(`Webhook: ${WEBHOOK_PATH}`);

  try {
    const r = await tg("getMe", {});
    if (r.ok) {
      botId = r.result.id;
      console.log(`Bot: @${r.result.username}`);
    }
  } catch {}
});
