// ============================================================
// TELEGRAM AI BOT
// Render / Abasthan (Node.js / Express) + OpenRouter + LangSearch
// Production JavaScript
//
// Webhook security:
//   1. Secret/random URL path: /webhook/<WEBHOOK_PATH_TOKEN>
//   2. Telegram secret header:
//      X-Telegram-Bot-Api-Secret-Token
//
// Model routing:
//   - Normal text requests -> OPENROUTER_MODEL
//   - Image requests       -> OPENROUTER_VISION_MODEL
//
// Image MIME handling:
//   - Never sends application/octet-stream to OpenRouter
//   - Detects image type from Telegram file_path
//
// Smart reactions:
//   - Chosen locally
//   - No extra AI/API request
//   - Based on topic, intent, sentiment, tone, emoji and image
//
// ============================================================

// ============================================================
// REQUIRED ENV VARS
// ============================================================
//
// BOT_TOKEN
// OPENROUTER_API_KEY
// WEBHOOK_SECRET
// WEBHOOK_PATH_TOKEN
//
// ============================================================
// OPTIONAL ENV VARS
// ============================================================
//
// BOT_USERNAME
// TRIGGER_COMMAND
// SYSTEM_PROMPT
// OPENROUTER_MODEL
// OPENROUTER_VISION_MODEL
// OPENROUTER_HTTP_REFERER
// OPENROUTER_X_TITLE
// LANGSEARCH_API_KEY
// GUEST_API_SECRET
// PORT
//
// ============================================================

import express from "express";

// ============================================================
// CONFIG
// ============================================================

const TELEGRAM_API =
  "https://api.telegram.org";

const OPENROUTER_API =
  "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL =
  "minimax/minimax-m2.7:free";

const DEFAULT_VISION_MODEL =
  "openrouter/free";

// Telegram limits.
const TELEGRAM_TEXT_LIMIT =
  4096;

const RICH_TEXT_LIMIT =
  32768;

// ------------------------------------------------------------
// Live-streaming throttle
// ------------------------------------------------------------

const STREAM_EDIT_INTERVAL_MS =
  1000;

const MIN_STREAM_EDIT_INTERVAL_MS =
  700;

const MIN_STREAM_NEW_CHARS =
  30;

// Switch from repeatedly editing one streaming message to
// chunked new-message delivery once the visible answer gets long.
const SWITCH_TO_NEW_MESSAGES_AT =
  3000;

// Backoff for rate-limited streaming edits.
const EDIT_BACKOFF_INITIAL_MS =
  1000;

const EDIT_BACKOFF_MAX_MS =
  8000;

const EDIT_FAILS_BEFORE_SWITCH =
  3;

// Per-read timeout for OpenRouter SSE streams.
const SSE_CHUNK_TIMEOUT_MS =
  15000;

// Number of previous user/assistant pairs.
const HISTORY_PAIRS =
  2;

// Webhook duplicate protection.
const UPDATE_DEDUP_TTL_SECONDS =
  300;

// ------------------------------------------------------------
// Web search config
// ------------------------------------------------------------

const LANGSEARCH_SEARCH_API =
  "https://api.langsearch.com/v1/web-search";

const MAX_WEB_SEARCHES =
  3;

const MAX_TOOL_LOOP_ITERATIONS =
  MAX_WEB_SEARCHES + 3;

const MAX_SEARCH_RESULTS =
  5;

const MAX_RESULT_TITLE_LENGTH =
  150;

const MAX_RESULT_CONTENT_LENGTH =
  500;

// ============================================================
// SMART REACTION CONFIG
// ============================================================
//
// These are normal emoji reactions that are broadly useful.
// The chat can still restrict which reactions are available;
// Telegram will simply return an error and the bot continues.
//
// ============================================================

const ALLOWED_REACTIONS =
  new Set([
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
  ]);

// ============================================================
// SMART REACTION PATTERNS
// ============================================================

const REACTION_PATTERNS = {
  // ----------------------------------------------------------
  // Love / affection
  // ----------------------------------------------------------

  love: [
    /\blove\b/i,
    /\bloved\b/i,
    /\badorable\b/i,
    /\bador(e|able)\b/i,
    /\bbeautiful\b/i,
    /\bcute\b/i,
    /\bsweet\b/i,
    /\b❤️\b/u,
    /\b😍\b/u,
    /\b🥰\b/u,
    /عاشق/,
    /عشق/,
    /دوستت دارم/,
    /دوست دارم/,
    /قشنگ/,
    /بامزه/,
    /ناز/,
  ],

  // ----------------------------------------------------------
  // Praise / appreciation
  // ----------------------------------------------------------

  praise: [
    /\bgood job\b/i,
    /\bwell done\b/i,
    /\bnice job\b/i,
    /\bgreat job\b/i,
    /\bawesome\b/i,
    /\bamazing\b/i,
    /\bexcellent\b/i,
    /\bperfect\b/i,
    /\bfantastic\b/i,
    /\bwonderful\b/i,
    /\bthank you\b/i,
    /\bthanks\b/i,
    /\bthx\b/i,
    /ممنون/,
    /مرسی/,
    /دمت گرم/,
    /خسته نباشی/,
    /دستت درد نکنه/,
    /عالی/,
    /فوق.?العاده/,
    /محشر/,
    /کارت درسته/,
  ],

  // ----------------------------------------------------------
  // Excitement
  // ----------------------------------------------------------

  excitement: [
    /\bso excited\b/i,
    /\bexcited\b/i,
    /\bcan't wait\b/i,
    /\bhuge\b/i,
    /\binsane\b/i,
    /\blet's go\b/i,
    /\blets go\b/i,
    /\byesss+\b/i,
    /\bwoo+\b/i,
    /\b🔥\b/u,
    /هیجان/,
    /بزن بریم/,
    /وااای/,
    /عجب/,
  ],

  // ----------------------------------------------------------
  // Sadness
  // ----------------------------------------------------------

  sadness: [
    /\bsad\b/i,
    /\bsadly\b/i,
    /\bdepressed\b/i,
    /\bcrying\b/i,
    /\bheartbroken\b/i,
    /\blost\b/i,
    /\bmiss\b/i,
    /\bmissing\b/i,
    /\bupset\b/i,
    /\bdisappointed\b/i,
    /\b😭\b/u,
    /\b😢\b/u,
    /غمگین/,
    /ناراحتم/,
    /دلم گرفته/,
    /بدبختم/,
    /گریه/,
    /دلتنگ/,
    /ناامید/,
    /ناراحت/,
  ],

  // ----------------------------------------------------------
  // Anger
  // ----------------------------------------------------------

  anger: [
    /\bangry\b/i,
    /\bfurious\b/i,
    /\bpissed\b/i,
    /\bhate\b/i,
    /\bwtf\b/i,
    /\bwhy the hell\b/i,
    /\bthis is bullshit\b/i,
    /\b🤬\b/u,
    /\b😡\b/u,
    /عصبانی/,
    /اعصابم/,
    /لعنت/,
    /مزخرف/,
    /افتضاح/,
    /مسخره/,
    /چقدر بد/,
  ],

  // ----------------------------------------------------------
  // Frustration
  // ----------------------------------------------------------

  frustration: [
    /\bfrustrated\b/i,
    /\bfrustrating\b/i,
    /\bdoesn't work\b/i,
    /\bdoesnt work\b/i,
    /\bnot working\b/i,
    /\bbroken\b/i,
    /\bi can't\b/i,
    /\bi cannot\b/i,
    /\bcan't fix\b/i,
    /\bcannot fix\b/i,
    /\bfailed\b/i,
    /\bfailing\b/i,
    /\berror\b/i,
    /\bexception\b/i,
    /کار نمی.?کنه/,
    /خرابه/,
    /درست نمی.?شه/,
    /نمی.?تونم/,
    /اعصاب/,
    /خطا/,
    /ارور/,
    /مشکل/,
  ],

  // ----------------------------------------------------------
  // Humor
  // ----------------------------------------------------------

  humor: [
    /\blol\b/i,
    /\blmao\b/i,
    /\brofl\b/i,
    /\bhaha+\b/i,
    /\bhehe+\b/i,
    /\bthat's funny\b/i,
    /\bfunny\b/i,
    /\bjoke\b/i,
    /\b😂\b/u,
    /\b🤣\b/u,
    /خنده/,
    /جوک/,
    /باحال/,
    /باحاله/,
  ],

  // ----------------------------------------------------------
  // Surprise / shock
  // ----------------------------------------------------------

  surprise: [
    /\bno way\b/i,
    /\breally\?!/i,
    /\bseriously\?!/i,
    /\bwhat\?!/i,
    /\bunbelievable\b/i,
    /\bshocking\b/i,
    /\bwtf\?!/i,
    /\b😮\b/u,
    /\b🤯\b/u,
    /جدی؟/,
    /واقعا؟/,
    /واقعاً؟/,
    /چی؟/,
    /باورم نمیشه/,
    /باورم نمیشه/,
    /غیرممکن/,
  ],

  // ----------------------------------------------------------
  // Help / request
  // ----------------------------------------------------------

  help: [
    /\bhelp\b/i,
    /\bcan you\b/i,
    /\bcould you\b/i,
    /\bwould you\b/i,
    /\bplease\b/i,
    /\bhow do i\b/i,
    /\bhow can i\b/i,
    /\bshow me\b/i,
    /\bfix this\b/i,
    /\bteach me\b/i,
    /\bguide me\b/i,
    /کمک/,
    /میشه/,
    /میتونی/,
    /لطفا/,
    /لطفاً/,
    /چطور/,
    /چجوری/,
    /چگونه/,
    /نشونم بده/,
    /درستش کن/,
    /یادم بده/,
    /راهنمایی/,
  ],

  // ----------------------------------------------------------
  // Coding / programming
  // ----------------------------------------------------------

  coding: [
    /\bcode\b/i,
    /\bcoding\b/i,
    /\bprogram\b/i,
    /\bprogramming\b/i,
    /\bdeveloper\b/i,
    /\bdebug\b/i,
    /\bdebugging\b/i,
    /\bbug\b/i,
    /\berror\b/i,
    /\bexception\b/i,
    /\bstack trace\b/i,
    /\bjavascript\b/i,
    /\btypescript\b/i,
    /\bpython\b/i,
    /\bjava\b/i,
    /\bcsharp\b/i,
    /\bc\+\+\b/i,
    /\brust\b/i,
    /\bnode\.?js\b/i,
    /\breact\b/i,
    /\bnext\.?js\b/i,
    /\bhtml\b/i,
    /\bcss\b/i,
    /\bapi\b/i,
    /\bsql\b/i,
    /\bdatabase\b/i,
    /\bgithub\b/i,
    /\bgit\b/i,
    /\bdocker\b/i,
    /\bkubernetes\b/i,
    /\bcloudflare\b/i,
    /\brender\b/i,
    /\bserver\b/i,
    /\bwebhook\b/i,
    /کد/,
    /برنامه.?نویسی/,
    /باگ/,
    /جاوااسکریپت/,
    /پایتون/,
    /تایپ.?اسکریپت/,
    /ری.?اکت/,
    /سرور/,
    /وب.?هوک/,
  ],

  // ----------------------------------------------------------
  // Science / technical knowledge
  // ----------------------------------------------------------

  science: [
    /\bphysics\b/i,
    /\bchemistry\b/i,
    /\bbiology\b/i,
    /\bquantum\b/i,
    /\bscientific\b/i,
    /\bscience\b/i,
    /\bmathematics\b/i,
    /\bmath\b/i,
    /\bspace\b/i,
    /\bblack hole\b/i,
    /\bgalaxy\b/i,
    /\bneuroscience\b/i,
    /\bgenetics\b/i,
    /\bthermodynamics\b/i,
    /\brelativity\b/i,
    /فیزیک/,
    /شیمی/,
    /زیست/,
    /علم/,
    /کوانتوم/,
    /ریاضی/,
    /فضا/,
    /سیاه.?چاله/,
    /نسبیت/,
  ],

  // ----------------------------------------------------------
  // Money / finance / business
  // ----------------------------------------------------------

  money: [
    /\bmoney\b/i,
    /\bprice\b/i,
    /\bcost\b/i,
    /\bcheap\b/i,
    /\bexpensive\b/i,
    /\bbudget\b/i,
    /\bstock\b/i,
    /\bstocks\b/i,
    /\bshare\b/i,
    /\bshares\b/i,
    /\bcrypto\b/i,
    /\bbitcoin\b/i,
    /\bethereum\b/i,
    /\bdollar\b/i,
    /\beuro\b/i,
    /\bforex\b/i,
    /\binvest/i,
    /\binvestment\b/i,
    /\bbusiness\b/i,
    /\bsalary\b/i,
    /\bprofit\b/i,
    /\bfinancial\b/i,
    /قیمت/,
    /پول/,
    /سهام/,
    /ارز/,
    /کریپتو/,
    /بیت.?کوین/,
    /دلار/,
    /یورو/,
    /سرمایه/,
    /سرمایه.?گذاری/,
    /کسب.?و.?کار/,
    /حقوق/,
    /درآمد/,
  ],

  // ----------------------------------------------------------
  // News / current events
  // ----------------------------------------------------------

  news: [
    /\blatest\b/i,
    /\bbreaking\b/i,
    /\bnews\b/i,
    /\btoday\b/i,
    /\btonight\b/i,
    /\brecent\b/i,
    /\bcurrent\b/i,
    /\bwhat happened\b/i,
    /\bwhat's happening\b/i,
    /\bwhat is happening\b/i,
    /\belection\b/i,
    /\bpresident\b/i,
    /\bwar\b/i,
    /\bupdate\b/i,
    /\bupdates\b/i,
    /\biran\b/i,
    /\bamerica\b/i,
    /\brussia\b/i,
    /\bukraine\b/i,
    /اخبار/,
    /امروز/,
    /جدیدترین/,
    /آخرین/,
    /چه خبر/,
    /اتفاق/,
    /جنگ/,
    /انتخابات/,
    /رئیس.?جمهور/,
    /خبر جدید/,
  ],

  // ----------------------------------------------------------
  // Travel
  // ----------------------------------------------------------

  travel: [
    /\btravel\b/i,
    /\btrip\b/i,
    /\bflight\b/i,
    /\bhotel\b/i,
    /\bvacation\b/i,
    /\btourist\b/i,
    /\btourism\b/i,
    /\bvisa\b/i,
    /\bairport\b/i,
    /\bpassport\b/i,
    /\bbooking\b/i,
    /سفر/,
    /پرواز/,
    /هتل/,
    /تعطیلات/,
    /ویزا/,
    /فرودگاه/,
    /پاسپورت/,
    /رزرو/,
  ],

  // ----------------------------------------------------------
  // Food
  // ----------------------------------------------------------

  food: [
    /\bfood\b/i,
    /\bcook\b/i,
    /\bcooking\b/i,
    /\brecipe\b/i,
    /\brestaurant\b/i,
    /\bdinner\b/i,
    /\blunch\b/i,
    /\bbreakfast\b/i,
    /\bpizza\b/i,
    /\bburger\b/i,
    /\bcoffee\b/i,
    /\btea\b/i,
    /غذا/,
    /آشپزی/,
    /دستور.?غذا/,
    /رستوران/,
    /پیتزا/,
    /برگر/,
    /قهوه/,
    /چای/,
    /صبحانه/,
    /ناهار/,
    /شام/,
  ],

  // ----------------------------------------------------------
  // Relationships / emotional
  // ----------------------------------------------------------

  relationship: [
    /\brelationship\b/i,
    /\bgirlfriend\b/i,
    /\bboyfriend\b/i,
    /\bwife\b/i,
    /\bhusband\b/i,
    /\bcrush\b/i,
    /\bdate\b/i,
    /\blove\b/i,
    /\bbreakup\b/i,
    /\bbroken heart\b/i,
    /\bfriendship\b/i,
    /رابطه/,
    /دوست.?دختر/,
    /دوست.?پسر/,
    /همسر/,
    /عشق/,
    /جدایی/,
    /کراش/,
    /دوستی/,
  ],
};

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeReactionText(
  text
) {
  return String(
    text || ""
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

// ============================================================
// MATCH COUNTER
// ============================================================

function countMatches(
  text,
  patterns
) {
  let score =
    0;

  for (
    const pattern of
    patterns
  ) {
    if (
      pattern.test(
        text
      )
    ) {
      score++;
    }
  }

  return score;
}

// ============================================================
// SMART LOCAL REACTION ENGINE
// ============================================================

function chooseSmartReaction(
  text,
  isImage = false
) {
  const value =
    normalizeReactionText(
      text
    );

  // ----------------------------------------------------------
  // Completely empty image
  // ----------------------------------------------------------

  if (
    isImage &&
    !value
  ) {
    return "👀";
  }

  // ----------------------------------------------------------
  // Reaction scores
  // ----------------------------------------------------------

  const scores = {
    "👍":
      1,

    "👎":
      0,

    "❤️":
      0,

    "🔥":
      0,

    "😂":
      0,

    "😢":
      0,

    "😡":
      0,

    "🤔":
      0,

    "😮":
      0,

    "🎉":
      0,

    "💯":
      0,

    "👀":
      0,

    "🧠":
      0,

    "🙏":
      0,

    "👏":
      0,

    "💡":
      0,

    "💔":
      0,

    "🤝":
      0,

    "🚀":
      0,

    "✨":
      0,

    "😎":
      0,

    "😭":
      0,

    "🥰":
      0,

    "😴":
      0,

    "🤯":
      0,

    "🧐":
      0,
  };

  // ----------------------------------------------------------
  // Explicit emoji signals
  // ----------------------------------------------------------

  if (
    value.includes("😂") ||
    value.includes("🤣")
  ) {
    scores["😂"] +=
      15;
  }

  if (
    value.includes("😭") ||
    value.includes("😢")
  ) {
    scores["😢"] +=
      15;
  }

  if (
    value.includes("😡") ||
    value.includes("🤬")
  ) {
    scores["😡"] +=
      15;
  }

  if (
    value.includes("❤️") ||
    value.includes("♥️") ||
    value.includes("😍") ||
    value.includes("🥰")
  ) {
    scores["❤️"] +=
      15;
  }

  if (
    value.includes("🔥")
  ) {
    scores["🔥"] +=
      12;
  }

  if (
    value.includes("🤯")
  ) {
    scores["🤯"] +=
      15;
  }

  if (
    value.includes("😮") ||
    value.includes("😲")
  ) {
    scores["😮"] +=
      15;
  }

  if (
    value.includes("🙏")
  ) {
    scores["🙏"] +=
      12;
  }

  if (
    value.includes("👏")
  ) {
    scores["👏"] +=
      12;
  }

  // ----------------------------------------------------------
  // Punctuation / tone
  // ----------------------------------------------------------

  const questionMarks =
    (
      value.match(
        /[?؟]/g
      ) || []
    ).length;

  const exclamationMarks =
    (
      value.match(
        /[!！]/g
      ) || []
    ).length;

  const laughingPatterns =
    (
      value.match(
        /(?:ha){2,}/gi
      ) || []
    ).length;

  const uppercaseLetters =
    (
      value.match(
        /[A-Z]/g
      ) || []
    ).length;

  const englishLetters =
    (
      value.match(
        /[A-Za-z]/g
      ) || []
    ).length;

  if (
    questionMarks >=
    1
  ) {
    scores["🤔"] +=
      3;
  }

  if (
    questionMarks >=
    2
  ) {
    scores["😮"] +=
      2;
  }

  if (
    exclamationMarks >=
    2
  ) {
    scores["🔥"] +=
      3;

    scores["😮"] +=
      2;
  }

  if (
    laughingPatterns >
    0
  ) {
    scores["😂"] +=
      10;
  }

  if (
    englishLetters >
      10 &&
    uppercaseLetters /
      englishLetters >
      0.6
  ) {
    scores["😮"] +=
      4;

    scores["🔥"] +=
      2;
  }

  // ----------------------------------------------------------
  // Category detection
  // ----------------------------------------------------------

  const loveScore =
    countMatches(
      value,
      REACTION_PATTERNS.love
    );

  const praiseScore =
    countMatches(
      value,
      REACTION_PATTERNS.praise
    );

  const excitementScore =
    countMatches(
      value,
      REACTION_PATTERNS.excitement
    );

  const sadnessScore =
    countMatches(
      value,
      REACTION_PATTERNS.sadness
    );

  const angerScore =
    countMatches(
      value,
      REACTION_PATTERNS.anger
    );

  const frustrationScore =
    countMatches(
      value,
      REACTION_PATTERNS.frustration
    );

  const humorScore =
    countMatches(
      value,
      REACTION_PATTERNS.humor
    );

  const surpriseScore =
    countMatches(
      value,
      REACTION_PATTERNS.surprise
    );

  const helpScore =
    countMatches(
      value,
      REACTION_PATTERNS.help
    );

  const codingScore =
    countMatches(
      value,
      REACTION_PATTERNS.coding
    );

  const scienceScore =
    countMatches(
      value,
      REACTION_PATTERNS.science
    );

  const moneyScore =
    countMatches(
      value,
      REACTION_PATTERNS.money
    );

  const newsScore =
    countMatches(
      value,
      REACTION_PATTERNS.news
    );

  const travelScore =
    countMatches(
      value,
      REACTION_PATTERNS.travel
    );

  const foodScore =
    countMatches(
      value,
      REACTION_PATTERNS.food
    );

  const relationshipScore =
    countMatches(
      value,
      REACTION_PATTERNS.relationship
    );

  // ----------------------------------------------------------
  // Sentiment / tone
  // ----------------------------------------------------------

  scores["❤️"] +=
    loveScore * 5;

  scores["💯"] +=
    praiseScore * 4;

  scores["👏"] +=
    praiseScore * 2;

  scores["🔥"] +=
    excitementScore * 4;

  scores["🚀"] +=
    excitementScore * 2;

  scores["😢"] +=
    sadnessScore * 6;

  scores["😭"] +=
    sadnessScore * 3;

  scores["😡"] +=
    angerScore * 7;

  scores["😡"] +=
    frustrationScore * 3;

  scores["😂"] +=
    humorScore * 7;

  scores["😮"] +=
    surpriseScore * 6;

  scores["🤔"] +=
    helpScore * 2;

  scores["🙏"] +=
    helpScore * 3;

  // ----------------------------------------------------------
  // Topic mapping
  //
  // Topic should normally matter less than strong emotion.
  // ----------------------------------------------------------

  scores["💡"] +=
    codingScore * 4;

  scores["🧠"] +=
    codingScore * 3;

  scores["🧠"] +=
    scienceScore * 5;

  scores["💡"] +=
    scienceScore * 3;

  scores["💯"] +=
    moneyScore * 3;

  scores["🧐"] +=
    moneyScore * 3;

  scores["🧐"] +=
    newsScore * 6;

  scores["👀"] +=
    newsScore * 2;

  scores["✨"] +=
    travelScore * 5;

  scores["👀"] +=
    travelScore * 2;

  scores["❤️"] +=
    foodScore * 3;

  scores["✨"] +=
    foodScore * 2;

  scores["❤️"] +=
    relationshipScore * 4;

  scores["💔"] +=
    relationshipScore * 3;

  // ----------------------------------------------------------
  // Image context
  // ----------------------------------------------------------

  if (isImage) {
    scores["👀"] +=
      7;

    scores["🤔"] +=
      2;
  }

  // ----------------------------------------------------------
  // Explicit question
  // ----------------------------------------------------------

  if (
    questionMarks >
      0 ||
    helpScore >
      0
  ) {
    scores["🤔"] +=
      4;
  }

  // ----------------------------------------------------------
  // Strong emotional overrides
  // ----------------------------------------------------------

  if (
    sadnessScore >=
    2
  ) {
    scores["😢"] +=
      10;
  }

  if (
    angerScore >=
    2
  ) {
    scores["😡"] +=
      10;
  }

  if (
    frustrationScore >=
    2
  ) {
    scores["😡"] +=
      5;
  }

  if (
    humorScore >=
    2
  ) {
    scores["😂"] +=
      10;
  }

  if (
    excitementScore >=
    2
  ) {
    scores["🔥"] +=
      10;
  }

  if (
    surpriseScore >=
    2
  ) {
    scores["😮"] +=
      10;
  }

  // ----------------------------------------------------------
  // Pick winner
  // ----------------------------------------------------------

  let bestEmoji =
    "👍";

  let bestScore =
    -Infinity;

  for (
    const emoji of
    ALLOWED_REACTIONS
  ) {
    const score =
      Number(
        scores[emoji] ||
          0
      );

    if (
      score >
      bestScore
    ) {
      bestScore =
        score;

      bestEmoji =
        emoji;
    }
  }

  // ----------------------------------------------------------
  // Safety
  // ----------------------------------------------------------

  if (
    !ALLOWED_REACTIONS.has(
      bestEmoji
    )
  ) {
    return "👍";
  }

  return bestEmoji;
}

// ============================================================
// TELEGRAM REACTION
// ============================================================

async function setAIReaction(
  token,
  chatId,
  messageId,
  emoji
) {
  if (
    !chatId ||
    !messageId ||
    !ALLOWED_REACTIONS.has(
      emoji
    )
  ) {
    return;
  }

  try {
    const result =
      await telegramPost(
        token,
        "setMessageReaction",
        {
          chat_id:
            chatId,

          message_id:
            messageId,

          reaction: [
            {
              type:
                "emoji",

              emoji:
                emoji,
            },
          ],

          is_big:
            false,
        }
      );

    if (
      !result.ok
    ) {
      console.warn(
        "AI reaction failed:",
        result.description
      );
    }
  } catch (error) {
    console.warn(
      "AI reaction error:",
      error
    );
  }
}

// ============================================================
// CONFIGURATION
// ============================================================

let cachedBotUserId =
  null;

// ============================================================
// IN-MEMORY KV
// ============================================================

class SimpleKV {
  constructor() {
    this.store =
      new Map();
  }

  async get(
    key
  ) {
    const entry =
      this.store.get(
        key
      );

    if (!entry) {
      return null;
    }

    if (
      entry.expiresAt &&
      Date.now() >
        entry.expiresAt
    ) {
      this.store.delete(
        key
      );

      return null;
    }

    return entry.value;
  }

  async put(
    key,
    value,
    options = {}
  ) {
    const expiresAt =
      options &&
      options.expirationTtl
        ? Date.now() +
          options.expirationTtl *
            1000
        : null;

    this.store.set(
      key,
      {
        value,
        expiresAt,
      }
    );
  }

  sweep() {
    const now =
      Date.now();

    for (
      const [
        key,
        entry,
      ] of this.store.entries()
    ) {
      if (
        entry.expiresAt &&
        now >
          entry.expiresAt
      ) {
        this.store.delete(
          key
        );
      }
    }
  }
}

const chatHistoryStore =
  new SimpleKV();

setInterval(
  () =>
    chatHistoryStore.sweep(),
  5 * 60 * 1000
);

// ============================================================
// ENV
// ============================================================

const env = {
  BOT_TOKEN:
    process.env.BOT_TOKEN,

  OPENROUTER_API_KEY:
    process.env.OPENROUTER_API_KEY,

  BOT_USERNAME:
    process.env.BOT_USERNAME,

  TRIGGER_COMMAND:
    process.env.TRIGGER_COMMAND,

  SYSTEM_PROMPT:
    process.env.SYSTEM_PROMPT,

  OPENROUTER_MODEL:
    process.env.OPENROUTER_MODEL,

  OPENROUTER_VISION_MODEL:
    process.env.OPENROUTER_VISION_MODEL,

  OPENROUTER_HTTP_REFERER:
    process.env.OPENROUTER_HTTP_REFERER,

  OPENROUTER_X_TITLE:
    process.env.OPENROUTER_X_TITLE,

  LANGSEARCH_API_KEY:
    process.env.LANGSEARCH_API_KEY,

  WEBHOOK_SECRET:
    process.env.WEBHOOK_SECRET,

  WEBHOOK_PATH_TOKEN:
    process.env.WEBHOOK_PATH_TOKEN,

  GUEST_API_SECRET:
    process.env.GUEST_API_SECRET,

  CHAT_HISTORY:
    chatHistoryStore,
};

// ============================================================
// WEBHOOK PATH
// ============================================================

const WEBHOOK_PATH_TOKEN =
  env.WEBHOOK_PATH_TOKEN ||
  "change-this-webhook-path-token";

const WEBHOOK_PATH =
  `/webhook/${WEBHOOK_PATH_TOKEN}`;

// ============================================================
// ENV VALIDATION
// ============================================================

if (!env.BOT_TOKEN) {
  console.error(
    "Missing required env var: BOT_TOKEN"
  );
}

if (
  !env.OPENROUTER_API_KEY
) {
  console.error(
    "Missing required env var: OPENROUTER_API_KEY"
  );
}

if (!env.WEBHOOK_SECRET) {
  console.error(
    "Missing required env var: WEBHOOK_SECRET. " +
      "Webhook requests will be rejected."
  );
}

if (!env.WEBHOOK_PATH_TOKEN) {
  console.warn(
    "WEBHOOK_PATH_TOKEN is not set."
  );
}

console.log(
  "Text model:",
  env.OPENROUTER_MODEL ||
    DEFAULT_MODEL
);

console.log(
  "Vision model:",
  env.OPENROUTER_VISION_MODEL ||
    DEFAULT_VISION_MODEL
);

console.log(
  "Smart reactions: ON"
);

// ============================================================
// EXPRESS SERVER
// ============================================================

const app =
  express();

app.use(
  express.json({
    limit:
      "1mb",
  })
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/",
  (req, res) => {
    res
      .status(200)
      .send(
        "AI Bot Running"
      );
  }
);

// ============================================================
// WEBHOOK
// ============================================================

app.post(
  WEBHOOK_PATH,
  async (req, res) => {
    const providedSecret =
      req.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

    const expectedSecret =
      env.WEBHOOK_SECRET;

    console.log(
      "========== TELEGRAM WEBHOOK =========="
    );

    console.log(
      "Webhook path:",
      req.path
    );

    console.log(
      "Secret configured:",
      Boolean(
        expectedSecret
      )
    );

    console.log(
      "Secret header received:",
      Boolean(
        providedSecret
      )
    );

    console.log(
      "Received secret length:",
      providedSecret
        ? providedSecret.length
        : 0
    );

    console.log(
      "Expected secret length:",
      expectedSecret
        ? expectedSecret.length
        : 0
    );

    const secretMatches =
      Boolean(
        expectedSecret &&
        providedSecret &&
        providedSecret ===
          expectedSecret
      );

    console.log(
      "Secret matches:",
      secretMatches
    );

    if (!expectedSecret) {
      res
        .status(500)
        .send(
          "Webhook secret is not configured."
        );

      return;
    }

    if (!secretMatches) {
      console.warn(
        "Rejected /webhook request with missing/invalid secret token."
      );

      res
        .status(401)
        .send(
          "Unauthorized"
        );

      return;
    }

    console.log(
      "Webhook authentication: SUCCESS"
    );

    const update =
      req.body;

    // ACK immediately.
    res
      .status(200)
      .send("OK");

    // --------------------------------------------------------
    // Deduplication
    // --------------------------------------------------------

    try {
      if (
        update &&
        update.update_id !==
          undefined
      ) {
        const key =
          `update:${update.update_id}`;

        const seen =
          await env.CHAT_HISTORY.get(
            key
          );

        if (seen) {
          console.log(
            "Duplicate update:",
            update.update_id
          );

          return;
        }

        await env.CHAT_HISTORY.put(
          key,
          "1",
          {
            expirationTtl:
              UPDATE_DEDUP_TTL_SECONDS,
          }
        );
      }
    } catch (error) {
      console.error(
        "KV dedup error:",
        error
      );
    }

    processUpdate(
      update,
      env
    ).catch(
      (error) => {
        console.error(
          "processUpdate fatal error:",
          error
        );
      }
    );
  }
);

// ============================================================
// OPTIONAL GUEST ENDPOINT
// ============================================================

app.post(
  "/guest",
  async (req, res) => {
    if (
      !env.GUEST_API_SECRET
    ) {
      res
        .status(404)
        .send(
          "Not found"
        );

      return;
    }

    const providedSecret =
      req.get(
        "X-Guest-Secret"
      );

    if (
      providedSecret !==
      env.GUEST_API_SECRET
    ) {
      res
        .status(401)
        .send(
          "Unauthorized"
        );

      return;
    }

    res
      .status(200)
      .send("OK");

    processUpdate(
      {
        guest_message:
          req.body,
      },
      env
    ).catch(
      (error) => {
        console.error(
          "guest processUpdate error:",
          error
        );
      }
    );
  }
);

// ============================================================
// SERVER START
// ============================================================

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  () => {
    console.log(
      `Server listening on port ${PORT}`
    );

    console.log(
      `Webhook path: ${WEBHOOK_PATH}`
    );
  }
);

// ============================================================
// PROCESS UPDATE
// ============================================================

async function processUpdate(
  update,
  env
) {
  try {
    const token =
      env.BOT_TOKEN;

    if (!token) {
      console.error(
        "BOT_TOKEN is missing."
      );

      return;
    }

    const botUsername =
      env.BOT_USERNAME ||
      "sssss12aabot";

    const triggerCommand =
      env.TRIGGER_COMMAND ||
      "!ai";

    const systemPrompt =
      env.SYSTEM_PROMPT ||
      "You are a helpful AI assistant. Answer accurately, clearly, and naturally. Use Markdown when useful.";

    // ========================================================
    // GUEST MODE
    // ========================================================

    if (
      update &&
      update.guest_message
    ) {
      await handleGuestMode(
        token,
        env,
        update.guest_message,
        systemPrompt
      );

      return;
    }

    // ========================================================
    // NORMAL TELEGRAM MESSAGE
    // ========================================================

    const message =
      update &&
      (
        update.message ||
        update.edited_message
      );

    if (!message) {
      return;
    }

    const chat =
      message.chat;

    if (!chat) {
      return;
    }

    const chatId =
      chat.id;

    const userId =
      message.from &&
      message.from.id
        ? message.from.id
        : chatId;

    const messageId =
      message.message_id;

    const text =
      message.text ||
      "";

    const caption =
      message.caption ||
      "";

    const photos =
      Array.isArray(
        message.photo
      )
        ? message.photo
        : null;

    const isPrivate =
      chat.type ===
      "private";

    // ========================================================
    // /start
    // ========================================================

    if (
      text.trim() ===
      "/start"
    ) {
      // React to the command too.
      const reaction =
        chooseSmartReaction(
          text,
          false
        );

      setAIReaction(
        token,
        chatId,
        messageId,
        reaction
      ).catch(
        () => {}
      );

      await handleStart(
        token,
        chatId,
        messageId,
        env
      );

      return;
    }

    // ========================================================
    // /help
    // ========================================================

    if (
      text.trim() ===
      "/help"
    ) {
      const reaction =
        chooseSmartReaction(
          text,
          false
        );

      setAIReaction(
        token,
        chatId,
        messageId,
        reaction
      ).catch(
        () => {}
      );

      await sendMessage(
        token,
        chatId,
        [
          "🤖 *How to use me*",
          "",
          "Private chat:",
          "Just send a message.",
          "",
          "Group chat:",
          `@${botUsername} your question`,
          `${triggerCommand} your question`,
          "or reply to one of my messages.",
          "",
          "Images are supported.",
          "",
          "AI reactions: ON",
          "Streaming: ON",
          "",
          "Text Model: `" +
            escapeMarkdown(
              env.OPENROUTER_MODEL ||
                DEFAULT_MODEL
            ) +
            "`",
          "Vision Model: `" +
            escapeMarkdown(
              env.OPENROUTER_VISION_MODEL ||
                DEFAULT_VISION_MODEL
            ) +
            "`",
        ].join(
          "\n"
        ),
        messageId
      );

      return;
    }

    // ========================================================
    // GET BOT USER ID
    // ========================================================

    if (
      cachedBotUserId ===
      null
    ) {
      try {
        cachedBotUserId =
          await getBotUserId(
            token
          );
      } catch (error) {
        console.error(
          "getMe failed:",
          error
        );
      }
    }

    // ========================================================
    // CHECK MESSAGE TARGET
    // ========================================================

    let shouldReply =
      false;

    let prompt =
      text ||
      caption;

    let isImage =
      false;

    // ========================================================
    // PHOTO
    // ========================================================

    if (
      photos &&
      photos.length > 0
    ) {
      isImage =
        true;

      if (isPrivate) {
        shouldReply =
          true;
      } else {
        shouldReply =
          isMentionedOrTriggered(
            caption,
            botUsername,
            triggerCommand,
            message,
            cachedBotUserId
          );

        if (shouldReply) {
          prompt =
            extractPrompt(
              caption,
              botUsername,
              triggerCommand,
              message
            );
        }
      }
    }

    // ========================================================
    // TEXT
    // ========================================================

    else {
      if (isPrivate) {
        shouldReply =
          true;
      } else {
        shouldReply =
          isMentionedOrTriggered(
            text,
            botUsername,
            triggerCommand,
            message,
            cachedBotUserId
          );

        if (shouldReply) {
          prompt =
            extractPrompt(
              text,
              botUsername,
              triggerCommand,
              message
            );
        }
      }
    }

    // --------------------------------------------------------
    // IMPORTANT:
    //
    // Only react when this message is actually going to be
    // handled by the bot.
    //
    // The reaction is LOCAL and fire-and-forget, so it does not
    // delay the OpenRouter request or streaming.
    // --------------------------------------------------------

    if (!shouldReply) {
      return;
    }

    const reactionText =
      prompt ||
      caption ||
      text ||
      "";

    const reaction =
      chooseSmartReaction(
        reactionText,
        isImage
      );

    setAIReaction(
      token,
      chatId,
      messageId,
      reaction
    ).catch(
      () => {}
    );

    console.log(
      "Smart reaction:",
      {
        reaction,
        isImage,
      }
    );

    // ========================================================
    // EMPTY IMAGE PROMPT
    // ========================================================

    if (
      isImage &&
      !prompt
    ) {
      prompt =
        "Describe this image in detail.";
    }

    // ========================================================
    // EMPTY MESSAGE
    // ========================================================

    if (!prompt) {
      await sendMessage(
        token,
        chatId,
        "Please write something.",
        messageId
      );

      return;
    }

    // ========================================================
    // IMAGE
    // ========================================================

    let imageData =
      null;

    if (
      isImage &&
      photos
    ) {
      try {
        const largest =
          photos[
            photos.length - 1
          ];

        imageData =
          await downloadImage(
            token,
            largest.file_id
          );
      } catch (error) {
        console.error(
          "Image processing error:",
          error
        );

        await sendMessage(
          token,
          chatId,
          "❌ I couldn't process that image.",
          messageId
        );

        return;
      }
    }

    // ========================================================
    // AI GENERATION
    // ========================================================

    await generateAI(
      token,
      env,
      chatId,
      userId,
      prompt,
      systemPrompt,
      imageData,
      messageId,
      isPrivate
    );
  } catch (error) {
    console.error(
      "processUpdate fatal error:",
      error
    );
  }
}

// ============================================================
// /START
// ============================================================

async function handleStart(
  token,
  chatId,
  replyToMessageId,
  env
) {
  const model =
    env.OPENROUTER_MODEL ||
    DEFAULT_MODEL;

  const visionModel =
    env.OPENROUTER_VISION_MODEL ||
    DEFAULT_VISION_MODEL;

  const result =
    await sendMessage(
      token,
      chatId,
      [
        "🤖 *AI Bot Ready*",
        "",
        "Welcome!",
        "",
        `Text Model: \`${escapeMarkdown(model)}\``,
        `Vision Model: \`${escapeMarkdown(visionModel)}\``,
        "Provider: OpenRouter",
        "⚡ Live streaming: ON",
        "✨ Smart reactions: ON",
        "",
        "Just send me a message.",
        "",
        "In groups:",
        `@${env.BOT_USERNAME || "sssss12aabot"} your question`,
        `${env.TRIGGER_COMMAND || "!ai"} your question`,
        "or reply to one of my messages.",
        "",
        "Creator: @Hose3in",
      ].join(
        "\n"
      ),
      replyToMessageId
    );

  console.log(
    "/start result:",
    result
  );

  return result;
}

// ============================================================
// MAIN AI GENERATOR
// ============================================================

async function generateAI(
  token,
  env,
  chatId,
  userId,
  prompt,
  systemPrompt,
  imageData,
  replyToMessageId,
  isPrivate
) {
  console.log(
    "========== AI GENERATION =========="
  );

  console.log(
    "Request contains image:",
    Boolean(
      imageData
    )
  );

  console.log(
    "Selected model:",
    imageData
      ? (
          env.OPENROUTER_VISION_MODEL ||
          DEFAULT_VISION_MODEL
        )
      : (
          env.OPENROUTER_MODEL ||
          DEFAULT_MODEL
        )
  );

  // ----------------------------------------------------------
  // STREAM STATE
  // ----------------------------------------------------------

  let fullAnswer =
    "";

  let lastDisplayed =
    "";

  let lastDraftAt =
    0;

  let lastEditChars =
    0;

  let streamMessageIds =
    [];

  const groupStreamState = {
    mode:
      "edit",

    editBackoffMs:
      0,

    editBackoffUntil:
      0,

    consecutiveEditFails:
      0,

    newModeSentLength:
      0,
  };

  let usingRichDraft =
    false;

  // ----------------------------------------------------------
  // Rich draft
  // ----------------------------------------------------------

  const draftId =
    generateDraftId();

  // ----------------------------------------------------------
  // Typing
  // ----------------------------------------------------------

  let typingActive =
    true;

  const typingTimer =
    setInterval(
      function () {
        if (
          typingActive
        ) {
          sendTyping(
            token,
            chatId
          ).catch(
            function () {}
          );
        }
      },
      5000
    );

  // ----------------------------------------------------------
  // SSE reader
  // ----------------------------------------------------------

  async function readOpenRouterStream(
    response
  ) {
    let sseBuffer =
      "";

    const toolCallAccumulator =
      [];

    let finishReason =
      null;

    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    try {
      while (true) {
        let result;

        try {
          result =
            await withTimeout(
              reader.read(),
              SSE_CHUNK_TIMEOUT_MS,
              "SSE read"
            );
        } catch (error) {
          console.warn(
            "OpenRouter SSE read failed/timeout:",
            error instanceof Error
              ? error.message
              : String(
                  error
                )
          );

          try {
            await reader.cancel();
          } catch (
            cancelError
          ) {
            console.warn(
              "SSE reader cancel failed:",
              cancelError
            );
          }

          break;
        }

        if (result.done) {
          break;
        }

        sseBuffer +=
          decoder.decode(
            result.value,
            {
              stream:
                true,
            }
          );

        const lines =
          sseBuffer.split(
            "\n"
          );

        sseBuffer =
          lines.pop() ||
          "";

        for (
          const rawLine of
          lines
        ) {
          const line =
            rawLine.trim();

          if (
            !line.startsWith(
              "data:"
            )
          ) {
            continue;
          }

          const payload =
            line
              .slice(5)
              .trim();

          if (
            payload ===
            "[DONE]"
          ) {
            continue;
          }

          let chunk;

          try {
            chunk =
              JSON.parse(
                payload
              );
          } catch {
            continue;
          }

          const choice =
            chunk &&
            chunk.choices &&
            chunk.choices[0];

          const delta =
            choice &&
            choice.delta;

          if (
            choice &&
            choice.finish_reason
          ) {
            finishReason =
              choice.finish_reason;
          }

          if (!delta) {
            continue;
          }

          // ----------------------------------------------------
          // Tool calls
          // ----------------------------------------------------

          if (
            Array.isArray(
              delta.tool_calls
            )
          ) {
            mergeToolCallDelta(
              toolCallAccumulator,
              delta.tool_calls
            );
          }

          // ----------------------------------------------------
          // Reasoning
          // ----------------------------------------------------

          const hasReasoning =
            Boolean(
              delta.reasoning ||
              delta.reasoning_details
            );

          if (
            hasReasoning &&
            usingRichDraft &&
            !fullAnswer
          ) {
            const now =
              Date.now();

            if (
              now -
                lastDraftAt >=
              STREAM_EDIT_INTERVAL_MS
            ) {
              lastDraftAt =
                now;

              await sendRichMessageDraft(
                token,
                chatId,
                draftId,
                "<tg-thinking>Thinking...</tg-thinking>"
              );
            }
          }

          // ----------------------------------------------------
          // Content
          // ----------------------------------------------------

          const content =
            extractContent(
              delta
            );

          if (!content) {
            continue;
          }

          fullAnswer +=
            content;

          // ----------------------------------------------------
          // STREAM THROTTLE
          // ----------------------------------------------------

          const now =
            Date.now();

          const newChars =
            fullAnswer.length -
            lastEditChars;

          if (
            now -
              lastDraftAt <
              MIN_STREAM_EDIT_INTERVAL_MS ||
            newChars <
              MIN_STREAM_NEW_CHARS
          ) {
            continue;
          }

          lastDraftAt =
            now;

          lastEditChars =
            fullAnswer.length;

          // ==================================================
          // PRIVATE — RICH DRAFT
          // ==================================================

          if (
            usingRichDraft
          ) {
            const liveText =
              fullAnswer;

            if (
              liveText !==
              lastDisplayed
            ) {
              lastDisplayed =
                liveText;

              const draftResult =
                await sendRichMessageDraft(
                  token,
                  chatId,
                  draftId,
                  liveText
                );

              if (
                !draftResult.ok
              ) {
                console.error(
                  "Rich draft update failed:",
                  draftResult.description ||
                    draftResult.error
                );
              }
            }

            continue;
          }

          // ==================================================
          // GROUP
          // ==================================================

          if (
            streamMessageIds.length >
            0
          ) {
            if (
              fullAnswer !==
              lastDisplayed
            ) {
              lastDisplayed =
                fullAnswer;

              await syncGroupStream(
                token,
                chatId,
                streamMessageIds,
                fullAnswer,
                groupStreamState
              );
            }
          }
        }
      }
    } catch (error) {
      console.error(
        "OpenRouter SSE reader failed:",
        error
      );
    }

    return {
      toolCalls:
        toolCallAccumulator.filter(
          Boolean
        ),

      finishReason,
    };
  }

  // ----------------------------------------------------------
  // SEARCH STATUS
  // ----------------------------------------------------------

  async function showSearchingStatus() {
    if (
      usingRichDraft
    ) {
      lastDraftAt =
        Date.now();

      await sendRichMessageDraft(
        token,
        chatId,
        draftId,
        "<tg-thinking>🔎 Searching the web...</tg-thinking>"
      );

      return;
    }

    if (
      streamMessageIds.length >
      0
    ) {
      await editPlainMessage(
        token,
        chatId,
        streamMessageIds[0],
        "🔎 Searching the web…",
        true
      );
    }
  }

  try {
    // ========================================================
    // PRIVATE CHAT
    // ========================================================

    if (
      isPrivate
    ) {
      const richDraftResult =
        await sendRichMessageDraft(
          token,
          chatId,
          draftId,
          "<tg-thinking>Thinking...</tg-thinking>",
          undefined
        );

      if (
        richDraftResult.ok
      ) {
        usingRichDraft =
          true;

        console.log(
          "Rich draft streaming enabled."
        );
      } else {
        console.warn(
          "Rich draft unavailable; falling back:",
          richDraftResult
        );

        const fallback =
          await sendPlainMessage(
            token,
            chatId,
            "🧠 Thinking…",
            replyToMessageId
          );

        if (
          !fallback.ok ||
          !fallback.result
        ) {
          throw new Error(
            "Could not create fallback Telegram message."
          );
        }

        streamMessageIds.push(
          fallback.result.message_id
        );
      }
    }

    // ========================================================
    // GROUP CHAT
    // ========================================================

    else {
      const initial =
        await sendPlainMessage(
          token,
          chatId,
          "🧠 Thinking…",
          replyToMessageId
        );

      if (
        !initial.ok ||
        !initial.result
      ) {
        throw new Error(
          "Could not create Telegram streaming message."
        );
      }

      streamMessageIds.push(
        initial.result.message_id
      );
    }

    // ========================================================
    // BUILD MESSAGES
    // ========================================================

    let currentMessages =
      await buildMessages(
        env,
        userId,
        prompt,
        systemPrompt,
        imageData
      );

    // ========================================================
    // OPENROUTER + SEARCH LOOP
    // ========================================================

    let searchRoundsUsed =
      0;

    let finalAnswer =
      "";

    for (
      let iteration = 0;
      iteration <
      MAX_TOOL_LOOP_ITERATIONS;
      iteration++
    ) {
      fullAnswer =
        "";

      lastDisplayed =
        "";

      lastDraftAt =
        0;

      lastEditChars =
        0;

      const toolsForThisRound =
        searchRoundsUsed <
        MAX_WEB_SEARCHES
          ? WEB_SEARCH_TOOLS
          : null;

      const response =
        await createOpenRouterRequest(
          env,
          currentMessages,
          true,
          toolsForThisRound,
          Boolean(
            imageData
          )
        );

      console.log(
        "OpenRouter HTTP:",
        response.status,
        {
          toolsEnabled:
            Boolean(
              toolsForThisRound
            ),

          searchRoundsUsed,

          hasImage:
            Boolean(
              imageData
            ),
        }
      );

      if (!response.ok) {
        const errorText =
          await response.text();

        throw new Error(
          `OpenRouter API ${response.status}: ${errorText}`
        );
      }

      if (!response.body) {
        throw new Error(
          "OpenRouter returned an empty body."
        );
      }

      const roundResult =
        await readOpenRouterStream(
          response
        );

      const requestedToolCalls =
        roundResult.toolCalls;

      // --------------------------------------------------------
      // Web search tool call
      // --------------------------------------------------------

      if (
        toolsForThisRound &&
        requestedToolCalls.length >
          0
      ) {
        const assistantToolCalls =
          [];

        const toolResultMessages =
          [];

        for (
          const call of
          requestedToolCalls
        ) {
          if (
            !call ||
            !call.id ||
            !call.function ||
            call.function.name !==
              "web_search"
          ) {
            continue;
          }

          assistantToolCalls.push({
            id:
              call.id,

            type:
              "function",

            function: {
              name:
                "web_search",

              arguments:
                call.function
                  .arguments ||
                "{}",
            },
          });

          let toolResultText;

          if (
            searchRoundsUsed >=
            MAX_WEB_SEARCHES
          ) {
            toolResultText =
              "Maximum number of web searches has been reached for this request. Please answer using the information already gathered.";
          } else {
            const parsedArgs =
              safeParseJSON(
                call.function
                  .arguments
              );

            const query =
              parsedArgs &&
              typeof parsedArgs.query ===
                "string"
                ? parsedArgs.query.trim()
                : "";

            if (!query) {
              toolResultText =
                "Web search was not performed because no valid search query was provided.";
            } else {
              searchRoundsUsed++;

              try {
                const rawResults =
                  await searchWeb(
                    query,
                    env
                  );

                const normalized =
                  normalizeSearchResults(
                    rawResults
                  );

                toolResultText =
                  formatSearchResultsForModel(
                    query,
                    normalized
                  );
              } catch (
                searchError
              ) {
                console.error(
                  "LangSearch search failed:",
                  searchError
                );

                toolResultText =
                  "Web search was unavailable or failed. No reliable search results could be retrieved for this query.";
              }
            }
          }

          toolResultMessages.push({
            role:
              "tool",

            tool_call_id:
              call.id,

            content:
              toolResultText,
          });
        }

        if (
          assistantToolCalls.length ===
          0
        ) {
          finalAnswer =
            fullAnswer.trim() ||
            "I wasn't able to complete that request.";

          break;
        }

        await showSearchingStatus();

        currentMessages =
          currentMessages.concat(
            [
              {
                role:
                  "assistant",

                content:
                  fullAnswer,

                tool_calls:
                  assistantToolCalls,
              },
            ],

            toolResultMessages
          );

        continue;
      }

      // --------------------------------------------------------
      // Final answer
      // --------------------------------------------------------

      finalAnswer =
        fullAnswer.trim();

      break;
    }

    if (!finalAnswer) {
      throw new Error(
        "OpenRouter returned no answer content."
      );
    }

    console.log(
      "Final answer length:",
      finalAnswer.length
    );

    // ========================================================
    // PRIVATE
    // ========================================================

    if (
      usingRichDraft
    ) {
      await sendFinalRichResponse(
        token,
        chatId,
        finalAnswer,
        replyToMessageId
      );
    }

    // ========================================================
    // GROUP
    // ========================================================

    else if (
      streamMessageIds.length >
      0
    ) {
      await finalizeGroupMessages(
        token,
        chatId,
        streamMessageIds,
        finalAnswer
      );
    }

    // ========================================================
    // SAVE HISTORY
    // ========================================================

    if (!imageData) {
      await saveConversation(
        env,
        userId,
        prompt,
        finalAnswer
      );
    }
  } catch (error) {
    console.error(
      "generateAI failed:",
      error
    );

    // --------------------------------------------------------
    // PRIVATE ERROR
    // --------------------------------------------------------

    if (
      usingRichDraft
    ) {
      try {
        await sendFinalRichResponse(
          token,
          chatId,
          "❌ **Error generating response**\n\n" +
            (
              error instanceof Error
                ? error.message
                : String(
                    error
                  )
            ),
          replyToMessageId
        );
      } catch (
        fallbackError
      ) {
        console.error(
          "Rich error response failed:",
          fallbackError
        );
      }
    }

    // --------------------------------------------------------
    // GROUP ERROR
    // --------------------------------------------------------

    else if (
      streamMessageIds.length >
      0
    ) {
      const errorText =
        "❌ Error generating response.\n\n" +
        (
          error instanceof Error
            ? error.message
            : String(
                error
              )
        );

      try {
        if (fullAnswer) {
          await syncGroupStream(
            token,
            chatId,
            streamMessageIds,
            fullAnswer,
            groupStreamState
          );
        } else {
          await syncGroupStream(
            token,
            chatId,
            streamMessageIds,
            errorText,
            groupStreamState
          );
        }
      } catch (
        editError
      ) {
        console.error(
          "Error message update failed:",
          editError
        );
      }
    }
  } finally {
    typingActive =
      false;

    clearInterval(
      typingTimer
    );
  }
}

// ============================================================
// GROUP STREAM SYNC
// ============================================================

async function syncGroupStream(
  token,
  chatId,
  streamMessageIds,
  text,
  state = null
) {
  const streamState =
    state ||
    {
      mode:
        "edit",

      editBackoffMs:
        0,

      editBackoffUntil:
        0,

      consecutiveEditFails:
        0,

      newModeSentLength:
        0,
    };

  const parts =
    splitText(
      text,
      TELEGRAM_TEXT_LIMIT
    );

  if (
    parts.length ===
    0
  ) {
    return;
  }

  // ----------------------------------------------------------
  // NEW MESSAGE MODE
  // ----------------------------------------------------------

  if (
    streamState.mode ===
    "new"
  ) {
    await appendNewModeStream(
      token,
      chatId,
      text,
      streamState,
      false,
      streamMessageIds
    );

    return;
  }

  // ----------------------------------------------------------
  // Long answer
  // ----------------------------------------------------------

  if (
    text.length >=
    SWITCH_TO_NEW_MESSAGES_AT
  ) {
    await switchGroupStreamToNewMessages(
      token,
      chatId,
      streamMessageIds,
      text,
      streamState
    );

    return;
  }

  // ----------------------------------------------------------
  // Backoff
  // ----------------------------------------------------------

  if (
    streamState.editBackoffUntil >
    Date.now()
  ) {
    return;
  }

  const lastIndex =
    parts.length - 1;

  if (
    streamMessageIds[
      lastIndex
    ] ===
    undefined
  ) {
    const part =
      parts[lastIndex];

    const sent =
      await sendPlainMessage(
        token,
        chatId,
        part
      );

    if (
      sent.ok &&
      sent.result
    ) {
      streamMessageIds.push(
        sent.result.message_id
      );

      streamState.editBackoffMs =
        0;

      streamState.editBackoffUntil =
        0;

      streamState.consecutiveEditFails =
        0;
    }

    return;
  }

  const messageId =
    streamMessageIds[
      lastIndex
    ];

  const part =
    parts[lastIndex];

  const edited =
    await editPlainMessage(
      token,
      chatId,
      messageId,
      part,
      true
    );

  if (edited.ok) {
    streamState.consecutiveEditFails =
      0;

    streamState.editBackoffMs =
      0;

    streamState.editBackoffUntil =
      0;

    return;
  }

  const retryAfter =
    getTelegramRetryAfter(
      edited
    );

  if (
    retryAfter !==
    null
  ) {
    streamState.consecutiveEditFails++;

    streamState.editBackoffMs =
      Math.min(
        streamState.editBackoffMs >
        0
          ? streamState.editBackoffMs *
              2
          : EDIT_BACKOFF_INITIAL_MS,

        EDIT_BACKOFF_MAX_MS
      );

    const retryAfterMs =
      Math.min(
        retryAfter *
          1000,

        EDIT_BACKOFF_MAX_MS
      );

    const waitMs =
      Math.max(
        streamState.editBackoffMs,
        retryAfterMs
      );

    streamState.editBackoffUntil =
      Date.now() +
      waitMs;

    console.warn(
      `Group edit rate-limited (${streamState.consecutiveEditFails}); backoff ${waitMs}ms`
    );

    if (
      streamState.consecutiveEditFails >=
      EDIT_FAILS_BEFORE_SWITCH
    ) {
      await switchGroupStreamToNewMessages(
        token,
        chatId,
        streamMessageIds,
        text,
        streamState
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // Markdown fallback
  // ----------------------------------------------------------

  const markdownEdited =
    await editMarkdownMessage(
      token,
      chatId,
      messageId,
      part,
      true
    );

  if (
    markdownEdited.ok
  ) {
    streamState.consecutiveEditFails =
      0;

    streamState.editBackoffMs =
      0;

    streamState.editBackoffUntil =
      0;

    return;
  }

  streamState.consecutiveEditFails++;

  console.warn(
    "Group stream edit failed:",
    edited.description,
    markdownEdited.description
  );

  if (
    streamState.consecutiveEditFails >=
    EDIT_FAILS_BEFORE_SWITCH
  ) {
    await switchGroupStreamToNewMessages(
      token,
      chatId,
      streamMessageIds,
      text,
      streamState
    );
  }
}

// ============================================================
// SWITCH TO NEW MESSAGE MODE
// ============================================================

async function switchGroupStreamToNewMessages(
  token,
  chatId,
  streamMessageIds,
  fullText,
  state
) {
  for (
    const messageId of
    streamMessageIds.splice(
      0
    )
  ) {
    await safeDeleteMessage(
      token,
      chatId,
      messageId
    );
  }

  state.mode =
    "new";

  state.consecutiveEditFails =
    0;

  state.editBackoffMs =
    0;

  state.editBackoffUntil =
    0;

  state.newModeSentLength =
    0;

  return await appendNewModeStream(
    token,
    chatId,
    fullText,
    state,
    false,
    streamMessageIds
  );
}

// ============================================================
// NEW MESSAGE STREAM MODE
// ============================================================

async function appendNewModeStream(
  token,
  chatId,
  fullText,
  state,
  useRich,
  streamMessageIds,
  replyToMessageId
) {
  const text =
    String(
      fullText || ""
    );

  const previousLength =
    state.newModeSentLength ||
    0;

  const tail =
    text.slice(
      previousLength
    );

  if (!tail) {
    return true;
  }

  const limit =
    useRich
      ? RICH_TEXT_LIMIT
      : TELEGRAM_TEXT_LIMIT;

  let sentLength =
    previousLength;

  for (
    let i = 0;
    i < tail.length;
    i += limit
  ) {
    const chunk =
      tail.slice(
        i,
        i + limit
      );

    const result =
      await sendNewMessage(
        token,
        chatId,
        chunk,
        useRich,
        null,
        i === 0
          ? replyToMessageId
          : undefined
      );

    if (
      !result.ok
    ) {
      console.error(
        "New-mode chunk send failed:",
        result
      );

      return false;
    }

    sentLength +=
      chunk.length;

    if (
      result.result &&
      Array.isArray(
        streamMessageIds
      )
    ) {
      streamMessageIds.push(
        result.result.message_id
      );
    }

    await sleep(
      50
    );
  }

  state.newModeSentLength =
    sentLength;

  return true;
}

// ============================================================
// FINALIZE GROUP MESSAGES
// ============================================================

async function finalizeGroupMessages(
  token,
  chatId,
  streamMessageIds,
  text
) {
  const parts =
    splitText(
      text,
      TELEGRAM_TEXT_LIMIT
    );

  if (
    parts.length ===
    0
  ) {
    return;
  }

  for (
    let i = 0;
    i < parts.length;
    i++
  ) {
    const part =
      parts[i];

    const existingMessageId =
      streamMessageIds[i];

    if (
      existingMessageId !==
      undefined
    ) {
      const richEdit =
        await editRichMessage(
          token,
          chatId,
          existingMessageId,
          part
        );

      if (
        richEdit.ok
      ) {
        continue;
      }

      console.warn(
        "Rich edit failed; falling back to Markdown:",
        richEdit.description
      );

      const markdownEdit =
        await editMarkdownMessage(
          token,
          chatId,
          existingMessageId,
          part
        );

      if (
        markdownEdit.ok
      ) {
        continue;
      }

      console.warn(
        "Markdown edit failed; falling back to plain text:",
        markdownEdit.description
      );

      const plainEdit =
        await editPlainMessage(
          token,
          chatId,
          existingMessageId,
          part
        );

      if (
        !plainEdit.ok
      ) {
        console.error(
          "Plain edit failed:",
          plainEdit.description
        );

        const replacement =
          await sendPlainMessage(
            token,
            chatId,
            part
          );

        if (
          replacement.ok &&
          replacement.result
        ) {
          streamMessageIds[i] =
            replacement.result.message_id;

          await safeDeleteMessage(
            token,
            chatId,
            existingMessageId
          );
        }
      }

      continue;
    }

    // --------------------------------------------------------
    // Additional page
    // --------------------------------------------------------

    const richResult =
      await sendRichMessage(
        token,
        chatId,
        part
      );

    if (
      richResult.ok &&
      richResult.result
    ) {
      streamMessageIds.push(
        richResult.result.message_id
      );

      continue;
    }

    console.warn(
      "Additional rich message failed; falling back:",
      richResult.description
    );

    const plainResult =
      await sendPlainMessage(
        token,
        chatId,
        part
      );

    if (
      plainResult.ok &&
      plainResult.result
    ) {
      streamMessageIds.push(
        plainResult.result.message_id
      );
    } else {
      console.error(
        "Additional final message failed:",
        plainResult
      );
    }
  }

  // ----------------------------------------------------------
  // Delete stale extra pages
  // ----------------------------------------------------------

  if (
    streamMessageIds.length >
    parts.length
  ) {
    for (
      let i = parts.length;
      i < streamMessageIds.length;
      i++
    ) {
      await safeDeleteMessage(
        token,
        chatId,
        streamMessageIds[i]
      );
    }

    streamMessageIds.length =
      parts.length;
  }
}

// ============================================================
// FINAL RICH RESPONSE
// ============================================================

async function sendFinalRichResponse(
  token,
  chatId,
  text,
  replyToMessageId
) {
  const parts =
    splitText(
      text,
      RICH_TEXT_LIMIT
    );

  let first =
    true;

  for (
    const part of
    parts
  ) {
    const result =
      await sendRichMessage(
        token,
        chatId,
        part,
        first
          ? replyToMessageId
          : undefined
      );

    if (
      !result.ok
    ) {
      await sendChunked(
        token,
        chatId,
        part,
        false,
        null,
        first
          ? replyToMessageId
          : undefined
      );
    }

    first =
      false;
  }
}

// ============================================================
// SEND RICH MESSAGE
// ============================================================

async function sendRichMessage(
  token,
  chatId,
  markdownText,
  replyToMessageId
) {
  const body = {
    chat_id:
      chatId,

    rich_message: {
      markdown:
        markdownText,
    },
  };

  if (
    replyToMessageId !==
      undefined &&
    replyToMessageId !==
      null
  ) {
    body.reply_parameters = {
      message_id:
        replyToMessageId,
    };
  }

  return await telegramPost(
    token,
    "sendRichMessage",
    body
  );
}

// ============================================================
// SEND RICH MESSAGE DRAFT
// ============================================================

async function sendRichMessageDraft(
  token,
  chatId,
  draftId,
  markdownText,
  messageThreadId
) {
  const body = {
    chat_id:
      chatId,

    draft_id:
      draftId,

    rich_message: {
      markdown:
        markdownText,
    },
  };

  if (
    messageThreadId !==
    undefined
  ) {
    body.message_thread_id =
      messageThreadId;
  }

  return await telegramPost(
    token,
    "sendRichMessageDraft",
    body
  );
}

// ============================================================
// EDIT RICH MESSAGE
// ============================================================

async function editRichMessage(
  token,
  chatId,
  messageId,
  markdownText
) {
  return await telegramPost(
    token,
    "editMessageText",
    {
      chat_id:
        chatId,

      message_id:
        messageId,

      rich_message: {
        markdown:
          markdownText,
      },
    }
  );
}

// ============================================================
// SEND MARKDOWN MESSAGE
// ============================================================

async function sendMessage(
  token,
  chatId,
  text,
  replyToMessageId
) {
  const body = {
    chat_id:
      chatId,

    text:
      text,

    parse_mode:
      "Markdown",
  };

  if (
    replyToMessageId !==
      undefined &&
    replyToMessageId !==
      null
  ) {
    body.reply_to_message_id =
      replyToMessageId;
  }

  const result =
    await telegramPost(
      token,
      "sendMessage",
      body
    );

  if (
    !result.ok
  ) {
    return await sendPlainMessage(
      token,
      chatId,
      text,
      replyToMessageId
    );
  }

  return result;
}

// ============================================================
// PLAIN MESSAGE
// ============================================================

async function sendPlainMessage(
  token,
  chatId,
  text,
  replyToMessageId
) {
  const body = {
    chat_id:
      chatId,

    text:
      text,
  };

  if (
    replyToMessageId !==
      undefined &&
    replyToMessageId !==
      null
  ) {
    body.reply_to_message_id =
      replyToMessageId;
  }

  return await telegramPost(
    token,
    "sendMessage",
    body
  );
}

// ============================================================
// EDIT MARKDOWN
// ============================================================

async function editMarkdownMessage(
  token,
  chatId,
  messageId,
  text,
  skipRateLimitRetry = false
) {
  return await telegramPost(
    token,
    "editMessageText",
    {
      chat_id:
        chatId,

      message_id:
        messageId,

      text:
        text,

      parse_mode:
        "Markdown",
    },
    false,
    skipRateLimitRetry
  );
}

// ============================================================
// EDIT PLAIN MESSAGE
// ============================================================

async function editPlainMessage(
  token,
  chatId,
  messageId,
  text,
  skipRateLimitRetry = false
) {
  return await telegramPost(
    token,
    "editMessageText",
    {
      chat_id:
        chatId,

      message_id:
        messageId,

      text:
        text,
    },
    false,
    skipRateLimitRetry
  );
}

// ============================================================
// CHUNKED MESSAGE DELIVERY
// ============================================================

async function sendNewMessage(
  token,
  chatId,
  text,
  useRich,
  toRichHtml,
  replyToMessageId
) {
  if (
    useRich
  ) {
    const result =
      await sendRichMessage(
        token,
        chatId,
        text,
        replyToMessageId
      );

    if (
      result.ok ||
      !toRichHtml
    ) {
      return result;
    }

    return await sendPlainMessage(
      token,
      chatId,
      text,
      replyToMessageId
    );
  }

  return await sendPlainMessage(
    token,
    chatId,
    text,
    replyToMessageId
  );
}

async function appendChunk(
  token,
  chatId,
  fullText,
  lastSentLength,
  useRich,
  toRichHtml,
  replyToMessageId
) {
  const tail =
    String(
      fullText || ""
    ).slice(
      lastSentLength
    );

  if (!tail) {
    return lastSentLength;
  }

  const limit =
    useRich
      ? RICH_TEXT_LIMIT
      : TELEGRAM_TEXT_LIMIT;

  for (
    let i = 0;
    i < tail.length;
    i += limit
  ) {
    const chunk =
      tail.slice(
        i,
        i + limit
      );

    const result =
      await sendNewMessage(
        token,
        chatId,
        chunk,
        useRich,
        toRichHtml,
        i === 0
          ? replyToMessageId
          : undefined
      );

    if (
      !result.ok
    ) {
      throw (
        result.error ||
        new Error(
          result.description ||
            "Chunk send failed."
        )
      );
    }

    await sleep(
      50
    );
  }

  return fullText.length;
}

async function sendChunked(
  token,
  chatId,
  fullText,
  useRich,
  toRichHtml,
  replyToMessageId
) {
  const limit =
    useRich
      ? RICH_TEXT_LIMIT
      : TELEGRAM_TEXT_LIMIT;

  const text =
    String(
      fullText || ""
    );

  if (!text) {
    return;
  }

  for (
    let i = 0;
    i < text.length;
    i += limit
  ) {
    const chunk =
      text.slice(
        i,
        i + limit
      );

    const result =
      await sendNewMessage(
        token,
        chatId,
        chunk,
        useRich,
        toRichHtml,
        i === 0
          ? replyToMessageId
          : undefined
      );

    if (
      !result.ok
    ) {
      throw (
        result.error ||
        new Error(
          result.description ||
            "Chunked send failed."
        )
      );
    }

    await sleep(
      50
    );
  }
}

// ============================================================
// TELEGRAM API
// ============================================================

const MAX_FLOOD_WAIT_RETRY_SECONDS =
  10;

async function telegramPost(
  token,
  method,
  body,
  isRetry = false,
  skipRateLimitRetry = false
) {
  try {
    const response =
      await fetch(
        `${TELEGRAM_API}/bot${token}/${method}`,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              body
            ),
        }
      );

    const responseText =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(
          responseText
        );
    } catch {
      data = {
        ok:
          false,

        description:
          responseText,
      };
    }

    if (!response.ok) {
      console.error(
        `Telegram HTTP ${response.status} ${method}:`,
        data
      );

      const retryAfter =
        response.status ===
          429 &&
        data &&
        data.parameters &&
        typeof data.parameters
          .retry_after ===
          "number"
          ? data.parameters
              .retry_after
          : null;

      if (
        retryAfter !==
          null &&
        !isRetry &&
        !skipRateLimitRetry
      ) {
        const waitSeconds =
          Math.min(
            retryAfter,
            MAX_FLOOD_WAIT_RETRY_SECONDS
          );

        console.warn(
          `Telegram flood control on ${method}; retrying once after ${waitSeconds}s.`
        );

        await sleep(
          waitSeconds *
            1000
        );

        return await telegramPost(
          token,
          method,
          body,
          true,
          true
        );
      }
    }

    return data;
  } catch (error) {
    console.error(
      `Telegram ${method} network error:`,
      error
    );

    return {
      ok:
        false,

      description:
        String(
          error
        ),
    };
  }
}

// ============================================================
// TELEGRAM RETRY-AFTER
// ============================================================

function getTelegramRetryAfter(
  result
) {
  if (
    !result ||
    !result.ok
  ) {
    const value =
      result &&
      result.parameters &&
      result.parameters
        .retry_after;

    if (
      typeof value ===
        "number" &&
      Number.isFinite(
        value
      )
    ) {
      return value;
    }

    const nested =
      result &&
      result.data &&
      result.data.parameters &&
      result.data.parameters
        .retry_after;

    if (
      typeof nested ===
        "number" &&
      Number.isFinite(
        nested
      )
    ) {
      return nested;
    }
  }

  return null;
}

// ============================================================
// TYPING
// ============================================================

async function sendTyping(
  token,
  chatId
) {
  return await telegramPost(
    token,
    "sendChatAction",
    {
      chat_id:
        chatId,

      action:
        "typing",
    }
  );
}

// ============================================================
// BOT ID
// ============================================================

async function getBotUserId(
  token
) {
  const result =
    await telegramPost(
      token,
      "getMe",
      {}
    );

  if (
    !result.ok ||
    !result.result
  ) {
    throw new Error(
      "getMe failed: " +
        result.description
    );
  }

  return result.result.id;
}

// ============================================================
// IMAGE DOWNLOAD
// ============================================================

async function downloadImage(
  token,
  fileId
) {
  const file =
    await telegramPost(
      token,
      "getFile",
      {
        file_id:
          fileId,
      }
    );

  if (
    !file.ok ||
    !file.result
  ) {
    throw new Error(
      "Telegram getFile failed: " +
        file.description
    );
  }

  const filePath =
    file.result.file_path;

  const response =
    await fetch(
      `${TELEGRAM_API}/file/bot${token}/${filePath}`
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Image download failed: HTTP ${response.status}`
    );
  }

  const buffer =
    await response.arrayBuffer();

  // ----------------------------------------------------------
  // IMPORTANT:
  //
  // application/octet-stream is not valid as the image media
  // type for the OpenRouter image data URL.
  //
  // Use a known image content-type only.
  // Otherwise detect from Telegram's file path.
  // ----------------------------------------------------------

  const headerMimeType =
    (
      response.headers.get(
        "content-type"
      ) || ""
    )
      .split(
        ";"
      )[0]
      .trim()
      .toLowerCase();

  const detectedMimeType =
    detectImageMimeType(
      filePath
    );

  const supportedMimeTypes =
    new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);

  const mimeType =
    supportedMimeTypes.has(
      headerMimeType
    )
      ? headerMimeType
      : detectedMimeType;

  console.log(
    "Image MIME diagnostics:",
    {
      filePath,

      headerMimeType,

      detectedMimeType,

      selectedMimeType:
        mimeType,
    }
  );

  if (
    !supportedMimeTypes.has(
      mimeType
    )
  ) {
    throw new Error(
      `Unsupported image MIME type: ${mimeType}. ` +
        `Telegram file path: ${filePath}`
    );
  }

  return {
    base64:
      arrayBufferToBase64(
        buffer
      ),

    mimeType,
  };
}

// ============================================================
// IMAGE MIME
// ============================================================

function detectImageMimeType(
  path
) {
  const value =
    String(
      path || ""
    )
      .toLowerCase();

  if (
    value.endsWith(
      ".jpg"
    ) ||
    value.endsWith(
      ".jpeg"
    )
  ) {
    return "image/jpeg";
  }

  if (
    value.endsWith(
      ".png"
    )
  ) {
    return "image/png";
  }

  if (
    value.endsWith(
      ".webp"
    )
  ) {
    return "image/webp";
  }

  if (
    value.endsWith(
      ".gif"
    )
  ) {
    return "image/gif";
  }

  // Telegram photos are normally JPEG.
  return "image/jpeg";
}

// ============================================================
// BUILD OPENROUTER MESSAGES
// ============================================================

async function buildMessages(
  env,
  userId,
  prompt,
  systemPrompt,
  imageData
) {
  const messages =
    [];

  // ----------------------------------------------------------
  // System
  // ----------------------------------------------------------

  if (systemPrompt) {
    messages.push({
      role:
        "system",

      content:
        systemPrompt +
        TOOL_SYSTEM_INSTRUCTIONS,
    });
  }

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  if (imageData) {
    messages.push({
      role:
        "user",

      content: [
        {
          type:
            "text",

          text:
            prompt,
        },

        {
          type:
            "image_url",

          image_url: {
            url:
              `data:${imageData.mimeType};base64,${imageData.base64}`,
          },
        },
      ],
    });

    return messages;
  }

  // ----------------------------------------------------------
  // HISTORY
  // ----------------------------------------------------------

  const history =
    await getUserHistory(
      env,
      userId
    );

  const recent =
    history.slice(
      -(HISTORY_PAIRS * 2)
    );

  for (
    const message of
    recent
  ) {
    if (
      message &&
      (
        message.role ===
          "user" ||
        message.role ===
          "assistant"
      )
    ) {
      messages.push(
        message
      );
    }
  }

  // ----------------------------------------------------------
  // CURRENT QUESTION
  // ----------------------------------------------------------

  messages.push({
    role:
      "user",

    content:
      prompt,
  });

  return messages;
}

// ============================================================
// OPENROUTER
// ============================================================

async function createOpenRouterRequest(
  env,
  messages,
  stream,
  tools,
  hasImage = false
) {
  const apiKey =
    env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured."
    );
  }

  // ----------------------------------------------------------
  // Model selection
  // ----------------------------------------------------------

  const model =
    hasImage
      ? (
          env.OPENROUTER_VISION_MODEL ||
          DEFAULT_VISION_MODEL
        )
      : (
          env.OPENROUTER_MODEL ||
          DEFAULT_MODEL
        );

  // ----------------------------------------------------------
  // Body
  // ----------------------------------------------------------

  const body = {
    model:
      model,

    messages:
      messages,

    stream:
      stream,
  };

  if (
    tools &&
    tools.length > 0
  ) {
    body.tools =
      tools;

    body.tool_choice =
      "auto";
  }

  // ----------------------------------------------------------
  // Headers
  // ----------------------------------------------------------

  const headers = {
    Authorization:
      `Bearer ${apiKey}`,

    "Content-Type":
      "application/json",
  };

  if (
    env.OPENROUTER_HTTP_REFERER
  ) {
    headers[
      "HTTP-Referer"
    ] =
      env.OPENROUTER_HTTP_REFERER;
  }

  if (
    env.OPENROUTER_X_TITLE
  ) {
    headers[
      "X-Title"
    ] =
      env.OPENROUTER_X_TITLE;
  }

  console.log(
    "OpenRouter request:",
    {
      model:
        model,

      stream:
        stream,

      hasImage:
        hasImage,

      tools:
        Boolean(
          tools &&
          tools.length
        ),
    }
  );

  return await fetch(
    OPENROUTER_API,
    {
      method:
        "POST",

      headers:
        headers,

      body:
        JSON.stringify(
          body
        ),
    }
  );
}

// ============================================================
// WEB SEARCH
// ============================================================

async function searchWeb(
  query,
  env
) {
  if (
    !env.LANGSEARCH_API_KEY
  ) {
    throw new Error(
      "LANGSEARCH_API_KEY is not configured."
    );
  }

  const response =
    await fetch(
      LANGSEARCH_SEARCH_API,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${env.LANGSEARCH_API_KEY}`,
        },

        body:
          JSON.stringify({
            query,

            freshness:
              "noLimit",

            summary:
              true,

            count:
              MAX_SEARCH_RESULTS,
          }),
      }
    );

  if (
    !response.ok
  ) {
    const errorText =
      await response
        .text()
        .catch(
          () => ""
        );

    throw new Error(
      `LangSearch search failed: ${response.status} ${errorText}`
    );
  }

  const data =
    await response.json();

  if (
    data &&
    typeof data.code ===
      "number" &&
    data.code !== 200
  ) {
    throw new Error(
      `LangSearch search failed: ${data.code} ${
        data.msg ||
        "unknown error"
      }`
    );
  }

  return data;
}

// ============================================================
// SEARCH NORMALIZATION
// ============================================================

function normalizeSearchResults(
  data
) {
  const rawResults =
    data &&
    data.data &&
    data.data.webPages &&
    Array.isArray(
      data.data.webPages.value
    )
      ? data.data.webPages.value
      : [];

  return rawResults
    .slice(
      0,
      MAX_SEARCH_RESULTS
    )
    .map(
      (
        result,
        index
      ) => ({
        id:
          index + 1,

        title:
          truncateText(
            result &&
              result.name,
            MAX_RESULT_TITLE_LENGTH
          ),

        url:
          (
            result &&
            result.url
          ) ||
          "",

        content:
          truncateText(
            (
              result &&
              (
                result.summary ||
                result.snippet
              )
            ) ||
              "",
            MAX_RESULT_CONTENT_LENGTH
          ),
      })
    );
}

// ============================================================
// FORMAT SEARCH RESULTS
// ============================================================

function formatSearchResultsForModel(
  query,
  normalized
) {
  if (
    !normalized ||
    normalized.length ===
      0
  ) {
    return (
      `Web search results for: "${query}"\n\n` +
      "No results were found for this query."
    );
  }

  const lines = [
    `Web search results for: "${query}"`,
    "",
  ];

  for (
    const result of
    normalized
  ) {
    lines.push(
      `[${result.id}]`
    );

    lines.push(
      `Title: ${
        result.title ||
        "(untitled)"
      }`
    );

    lines.push(
      `URL: ${result.url}`
    );

    lines.push(
      `Content: ${result.content}`
    );

    lines.push("");
  }

  return lines
    .join(
      "\n"
    )
    .trim();
}

// ============================================================
// TRUNCATE
// ============================================================

function truncateText(
  text,
  maxLength
) {
  const value =
    String(
      text || ""
    );

  if (
    value.length <=
    maxLength
  ) {
    return value;
  }

  return (
    value
      .slice(
        0,
        maxLength
      )
      .trim() +
    "…"
  );
}

// ============================================================
// SAFE JSON
// ============================================================

function safeParseJSON(
  text
) {
  try {
    return JSON.parse(
      text
    );
  } catch {
    return null;
  }
}

// ============================================================
// TOOL CALL STREAM ACCUMULATION
// ============================================================

function mergeToolCallDelta(
  accumulator,
  deltaToolCalls
) {
  for (
    const call of
    deltaToolCalls
  ) {
    const index =
      typeof call.index ===
        "number"
        ? call.index
        : 0;

    if (
      !accumulator[index]
    ) {
      accumulator[index] =
        {
          id:
            "",

          type:
            "function",

          function: {
            name:
              "",

            arguments:
              "",
          },
        };
    }

    const entry =
      accumulator[index];

    if (call.id) {
      entry.id =
        call.id;
    }

    if (call.type) {
      entry.type =
        call.type;
    }

    if (
      call.function
    ) {
      if (
        call.function.name
      ) {
        entry.function.name +=
          call.function.name;
      }

      if (
        call.function.arguments
      ) {
        entry.function.arguments +=
          call.function.arguments;
      }
    }
  }
}

// ============================================================
// GUEST MODE
// ============================================================

async function handleGuestMode(
  token,
  env,
  guestMessage,
  systemPrompt
) {
  const prompt =
    guestMessage.prompt ||
    guestMessage.text ||
    "";

  if (!prompt) {
    return;
  }

  const guestChatId =
    guestMessage.chat_id ||
    guestMessage.chatId;

  if (!guestChatId) {
    console.error(
      "Guest message is missing chat_id/chatId; nothing to reply to."
    );

    return;
  }

  let messages = [
    {
      role:
        "system",

      content:
        systemPrompt +
        TOOL_SYSTEM_INSTRUCTIONS,
    },

    {
      role:
        "user",

      content:
        prompt,
    },
  ];

  let searchRoundsUsed =
    0;

  let finalAnswer =
    "";

  for (
    let iteration = 0;
    iteration <
    MAX_TOOL_LOOP_ITERATIONS;
    iteration++
  ) {
    const toolsForThisRound =
      searchRoundsUsed <
      MAX_WEB_SEARCHES
        ? WEB_SEARCH_TOOLS
        : null;

    const response =
      await createOpenRouterRequest(
        env,
        messages,
        false,
        toolsForThisRound,
        false
      );

    if (
      !response.ok
    ) {
      const errorText =
        await response.text();

      throw new Error(
        `OpenRouter API ${response.status}: ${errorText}`
      );
    }

    const data =
      await response.json();

    const choice =
      data &&
      data.choices &&
      data.choices[0];

    if (!choice) {
      throw new Error(
        "OpenRouter returned no choices."
      );
    }

    const assistantMessage =
      choice.message;

    if (
      assistantMessage &&
      Array.isArray(
        assistantMessage.tool_calls
      ) &&
      toolsForThisRound
    ) {
      const assistantToolCalls =
        [];

      const toolResultMessages =
        [];

      for (
        const call of
        assistantMessage.tool_calls
      ) {
        if (
          !call ||
          !call.id ||
          !call.function ||
          call.function.name !==
            "web_search"
        ) {
          continue;
        }

        assistantToolCalls.push(
          call
        );

        const args =
          safeParseJSON(
            call.function.arguments
          );

        const query =
          args &&
          typeof args.query ===
            "string"
            ? args.query.trim()
            : "";

        let resultText;

        if (!query) {
          resultText =
            "Web search was not performed because no valid search query was provided.";
        } else if (
          searchRoundsUsed >=
          MAX_WEB_SEARCHES
        ) {
          resultText =
            "Maximum number of web searches has been reached for this request.";
        } else {
          searchRoundsUsed++;

          try {
            const rawResults =
              await searchWeb(
                query,
                env
              );

            const normalized =
              normalizeSearchResults(
                rawResults
              );

            resultText =
              formatSearchResultsForModel(
                query,
                normalized
              );
          } catch (
            searchError
          ) {
            console.error(
              "Guest LangSearch failed:",
              searchError
            );

            resultText =
              "Web search failed or was unavailable.";
          }
        }

        toolResultMessages.push({
          role:
            "tool",

          tool_call_id:
            call.id,

          content:
            resultText,
        });
      }

      if (
        assistantToolCalls.length >
        0
      ) {
        messages =
          messages.concat(
            [
              {
                role:
                  "assistant",

                content:
                  assistantMessage.content ||
                  "",

                tool_calls:
                  assistantToolCalls,
              },
            ],

            toolResultMessages
          );

        continue;
      }
    }

    finalAnswer =
      (
        assistantMessage &&
        assistantMessage.content
      ) ||
      "";

    break;
  }

  if (!finalAnswer) {
    finalAnswer =
      "I couldn't generate a response.";
  }

  await sendChunked(
    token,
    guestChatId,
    finalAnswer,
    false,
    null,
    undefined
  );
}

// ============================================================
// EXTRACT CONTENT
// ============================================================

function extractContent(
  delta
) {
  if (!delta) {
    return "";
  }

  return (
    delta.content ||
    ""
  );
}

// ============================================================
// SPLIT TEXT
// ============================================================

function splitText(
  text,
  limit
) {
  const value =
    String(
      text || ""
    );

  if (!value) {
    return [];
  }

  if (
    value.length <=
    limit
  ) {
    return [
      value,
    ];
  }

  const parts =
    [];

  let start =
    0;

  while (
    start <
    value.length
  ) {
    let end =
      Math.min(
        start + limit,
        value.length
      );

    if (
      end <
      value.length
    ) {
      const newline =
        value.lastIndexOf(
          "\n",
          end
        );

      if (
        newline >
        start +
          Math.floor(
            limit * 0.5
          )
      ) {
        end =
          newline + 1;
      } else {
        const space =
          value.lastIndexOf(
            " ",
            end
          );

        if (
          space >
          start +
            Math.floor(
              limit * 0.5
            )
        ) {
          end =
            space + 1;
        }
      }
    }

    const part =
      value
        .slice(
          start,
          end
        )
        .trim();

    if (part) {
      parts.push(
        part
      );
    }

    start =
      end;
  }

  return parts;
}

// ============================================================
// TIMEOUT
// ============================================================

function withTimeout(
  promise,
  ms,
  label = "operation"
) {
  let timer;

  const timeout =
    new Promise(
      (_, reject) => {
        timer =
          setTimeout(
            () => {
              reject(
                new Error(
                  `${label} timed out after ${ms}ms`
                )
              );
            },
            ms
          );
      }
    );

  return Promise.race(
    [
      promise,
      timeout,
    ]
  ).finally(
    () => {
      clearTimeout(
        timer
      );
    }
  );
}

// ============================================================
// SLEEP
// ============================================================

function sleep(
  ms
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ============================================================
// DRAFT ID
// ============================================================

function generateDraftId() {
  return (
    Math.floor(
      Math.random() *
        2147483000
    ) + 1
  );
}

// ============================================================
// MARKDOWN ESCAPE
// ============================================================

function escapeMarkdown(
  value
) {
  return String(
    value || ""
  ).replace(
    /([_*\[\]()~`>#+\-=|{}.!\\])/g,
    "\\$1"
  );
}

// ============================================================
// MESSAGE TARGETING
// ============================================================

function isMentionedOrTriggered(
  text,
  botUsername,
  triggerCommand,
  message,
  botUserId
) {
  const value =
    String(
      text || ""
    ).trim();

  if (!value) {
    return false;
  }

  const lower =
    value.toLowerCase();

  const username =
    String(
      botUsername || ""
    )
      .replace(
        /^@/,
        ""
      )
      .toLowerCase();

  const trigger =
    String(
      triggerCommand || ""
    ).toLowerCase();

  // @bot mention
  if (
    username &&
    lower.includes(
      `@${username}`
    )
  ) {
    return true;
  }

  // Trigger command
  if (
    trigger &&
    (
      lower ===
        trigger ||
      lower.startsWith(
        `${trigger} `
      )
    )
  ) {
    return true;
  }

  // Reply to bot
  if (
    message &&
    message.reply_to_message &&
    message.reply_to_message
      .from
  ) {
    const repliedFrom =
      message.reply_to_message
        .from;

    if (
      repliedFrom.is_bot &&
      (
        (
          botUserId &&
          repliedFrom.id ===
            botUserId
        ) ||
        (
          username &&
          String(
            repliedFrom.username ||
              ""
          ).toLowerCase() ===
            username
        )
      )
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================
// EXTRACT PROMPT
// ============================================================

function extractPrompt(
  text,
  botUsername,
  triggerCommand,
  message
) {
  let value =
    String(
      text || ""
    ).trim();

  const username =
    String(
      botUsername || ""
    )
      .replace(
        /^@/,
        ""
      );

  const mentionRegex =
    username
      ? new RegExp(
          `@${escapeRegExp(
            username
          )}`,
          "ig"
        )
      : null;

  if (mentionRegex) {
    value =
      value.replace(
        mentionRegex,
        ""
      );
  }

  const trigger =
    String(
      triggerCommand || ""
    );

  if (
    trigger &&
    value
      .toLowerCase()
      .startsWith(
        trigger.toLowerCase()
      )
  ) {
    value =
      value.slice(
        trigger.length
      );
  }

  value =
    value
      .replace(
        /^[\s,:؛،-]+/u,
        ""
      )
      .trim();

  if (
    !value &&
    message &&
    message.reply_to_message &&
    message.reply_to_message
      .text
  ) {
    return "";
  }

  return value;
}

// ============================================================
// ESCAPE REGEXP
// ============================================================

function escapeRegExp(
  value
) {
  return String(
    value || ""
  ).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// ============================================================
// HISTORY
// ============================================================

async function getUserHistory(
  env,
  userId
) {
  if (
    !env.CHAT_HISTORY
  ) {
    return [];
  }

  try {
    const key =
      `history:${userId}`;

    const raw =
      await env.CHAT_HISTORY.get(
        key
      );

    if (!raw) {
      return [];
    }

    const parsed =
      JSON.parse(
        raw
      );

    return Array.isArray(
      parsed
    )
      ? parsed
      : [];
  } catch (error) {
    console.error(
      "History read failed:",
      error
    );

    return [];
  }
}

// ============================================================
// SAVE CONVERSATION
// ============================================================

async function saveConversation(
  env,
  userId,
  userPrompt,
  assistantAnswer
) {
  if (
    !env.CHAT_HISTORY
  ) {
    return;
  }

  try {
    const key =
      `history:${userId}`;

    const existing =
      await getUserHistory(
        env,
        userId
      );

    existing.push({
      role:
        "user",

      content:
        userPrompt,
    });

    existing.push({
      role:
        "assistant",

      content:
        assistantAnswer,
    });

    const trimmed =
      existing.slice(
        -(HISTORY_PAIRS * 2)
      );

    await env.CHAT_HISTORY.put(
      key,
      JSON.stringify(
        trimmed
      )
    );
  } catch (error) {
    console.error(
      "History save failed:",
      error
    );
  }
}

// ============================================================
// ARRAY BUFFER -> BASE64
// ============================================================

function arrayBufferToBase64(
  buffer
) {
  const bytes =
    new Uint8Array(
      buffer
    );

  let binary =
    "";

  const chunkSize =
    0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk =
      bytes.subarray(
        i,
        Math.min(
          i + chunkSize,
          bytes.length
        )
      );

    binary +=
      String.fromCharCode(
        ...chunk
      );
  }

  return Buffer.from(
    binary,
    "binary"
  ).toString(
    "base64"
  );
}

// ============================================================
// END OF FILE
// ============================================================
