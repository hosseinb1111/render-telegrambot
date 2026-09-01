import express from "express";

const TG_API="https://api.telegram.org";
const OR_API="https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS_API="https://openrouter.ai/api/v1/models";
const LANGSEARCH_API="https://api.langsearch.com/v1/web-search";

const BOT_TOKEN=process.env.BOT_TOKEN||"";
const OR_KEY=process.env.OPENROUTER_API_KEY||"";
const WEBHOOK_SECRET=process.env.WEBHOOK_SECRET||"";
const RAW_WEBHOOK_PATH_TOKEN=String(process.env.WEBHOOK_PATH_TOKEN||"");
const WEBHOOK_PATH_TOKEN=/^[A-Za-z0-9._~-]{8,256}$/.test(RAW_WEBHOOK_PATH_TOKEN)?RAW_WEBHOOK_PATH_TOKEN:"";
const GUEST_SECRET=process.env.GUEST_API_SECRET||"";
const LANGSEARCH_KEY=process.env.LANGSEARCH_API_KEY||"";
const BOT_USERNAME=String(process.env.BOT_USERNAME||"").replace(/^@/,"");
const TRIGGER=String(process.env.TRIGGER_COMMAND||"!ai").trim();
const SYSTEM_PROMPT=process.env.SYSTEM_PROMPT||"You are a helpful AI assistant. Answer accurately, clearly, naturally, and concisely.";
const TEXT_MODEL=process.env.OPENROUTER_MODEL||"minimax/minimax-m2.7:free";
const FAST_MODEL=process.env.OPENROUTER_FAST_MODEL||TEXT_MODEL;
const DEEP_MODEL=process.env.OPENROUTER_DEEP_MODEL||TEXT_MODEL;
const VISION_MODEL=process.env.OPENROUTER_VISION_MODEL||"openrouter/free";
const FILE_MODEL=process.env.OPENROUTER_FILE_MODEL||"openrouter/free";
const PORT=Number(process.env.PORT||3000);

function clampInt(value,fallback,min,max){
  const n=Number(value);
  if(!Number.isFinite(n))return fallback;
  return Math.min(max,Math.max(min,Math.trunc(n)));
}

const HISTORY_PAIRS=clampInt(process.env.HISTORY_PAIRS,4,1,20);
const MAX_SEARCHES=clampInt(process.env.MAX_SEARCHES,3,0,10);
const MAX_TOOL_ROUNDS=clampInt(process.env.MAX_TOOL_ROUNDS,5,1,10);
const MAX_HISTORY_USERS=clampInt(process.env.MAX_HISTORY_USERS,5000,100,50000);
const MAX_MEMORY_ENTRIES=clampInt(process.env.MAX_MEMORY_ENTRIES,10000,1000,100000);
const MAX_USER_PROMPT_CHARS=clampInt(process.env.MAX_USER_PROMPT_CHARS,16000,1000,50000);
const MAX_FILE_TEXT_CHARS=clampInt(process.env.MAX_FILE_TEXT_CHARS,30000,1000,100000);
const MAX_DOWNLOAD_BYTES=clampInt(process.env.MAX_DOWNLOAD_BYTES,20*1024*1024,1024,20*1024*1024);
const MAX_OR_FILE_BYTES=clampInt(process.env.MAX_OPENROUTER_FILE_BYTES,12*1024*1024,1024,20*1024*1024);
const TG_LIMIT=4096;
const RICH_LIMIT=32768;
const STREAM_EDIT_MS=900;
const DRAFT_UPDATE_MS=900;
const TYPING_MS=4000;
const REQUEST_TIMEOUT_MS=clampInt(process.env.REQUEST_TIMEOUT_MS,45000,5000,120000);
const MAX_GLOBAL_CONCURRENCY=clampInt(process.env.MAX_GLOBAL_CONCURRENCY,8,1,32);
const SEEN_UPDATE_TTL_SEC=600;
const REACTION_MEMORY_TTL_MS=10*60*1000;
const STATS_SAMPLE_LIMIT=200;
const WEBHOOK_PATH=WEBHOOK_PATH_TOKEN?`/webhook/${WEBHOOK_PATH_TOKEN}`:"/webhook/UNCONFIGURED";

let botId=null;
let modelCatalog=null;
let modelCatalogLoadedAt=0;
let modelCatalogAttemptedAt=0;
let botInfo=null;

function configWarnings(){
  const missing=[];
  if(!BOT_TOKEN)missing.push("BOT_TOKEN");
  if(!OR_KEY)missing.push("OPENROUTER_API_KEY");
  if(!WEBHOOK_SECRET)missing.push("WEBHOOK_SECRET");
  if(!WEBHOOK_PATH_TOKEN)missing.push("WEBHOOK_PATH_TOKEN");
  if(missing.length)console.error(`Missing required environment variables: ${missing.join(", ")}`);
}
configWarnings();

const memory=new Map();
const prefs=new Map();
const recentReactions=new Map();
const inFlightQueues=new Map();
const seenUpdates=new Map();

function memGet(key){
  const item=memory.get(key);
  if(!item)return null;
  if(item.expires&&Date.now()>item.expires){memory.delete(key);return null;}
  return item.value;
}

function memSet(key,value,ttlSeconds=0){
  if(memory.has(key))memory.delete(key);
  memory.set(key,{value,expires:ttlSeconds>0?Date.now()+ttlSeconds*1000:0});
  trimMap(memory,MAX_MEMORY_ENTRIES);
}

function trimMap(map,maxSize){
  while(map.size>maxSize){
    const first=map.keys().next().value;
    if(first===undefined)break;
    map.delete(first);
  }
}

function cleanupMemory(){
  const now=Date.now();
  for(const[key,item]of memory)if(item.expires&&now>item.expires)memory.delete(key);
  for(const[key,expiresAt]of seenUpdates)if(now>expiresAt)seenUpdates.delete(key);
  for(const[key,item]of recentReactions)if(now>item.expires)recentReactions.delete(key);
}

const memoryCleanupTimer=setInterval(cleanupMemory,300000);
memoryCleanupTimer.unref?.();

function historyKey(userId){return `history:${String(userId)}`;}

function getHistory(userId){
  const raw=memGet(historyKey(userId));
  if(!raw)return [];
  try{
    const parsed=JSON.parse(raw);
    if(!Array.isArray(parsed))return [];
    return parsed.filter(item=>item&&(item.role==="user"||item.role==="assistant")&&typeof item.content==="string"&&item.content.length>0);
  }catch{return [];}
}

function saveHistory(userId,prompt,answer){
  const cleanPrompt=String(prompt||"").slice(0,MAX_USER_PROMPT_CHARS);
  const cleanAnswer=String(answer||"").slice(0,RICH_LIMIT);
  if(!cleanPrompt||!cleanAnswer)return;
  const history=getHistory(userId);
  history.push({role:"user",content:cleanPrompt});
  history.push({role:"assistant",content:cleanAnswer});
  memSet(historyKey(userId),JSON.stringify(history.slice(-(HISTORY_PAIRS*2))));
  enforceHistoryUserLimit();
}

function enforceHistoryUserLimit(){
  let count=0;
  for(const key of memory.keys())if(key.startsWith("history:"))count++;
  if(count<=MAX_HISTORY_USERS)return;
  for(const key of memory.keys()){
    if(!key.startsWith("history:"))continue;
    memory.delete(key);
    count--;
    if(count<=MAX_HISTORY_USERS)break;
  }
}

function setPref(userId,key,value){
  const id=String(userId);
  const current=prefs.get(id)||{};
  current[key]=String(value).slice(0,200);
  prefs.set(id,current);
  trimMap(prefs,MAX_HISTORY_USERS);
}

function getPref(userId,key){return prefs.get(String(userId))?.[key];}
function clearUserMemory(userId){memory.delete(historyKey(userId));}

function clearAllCache(){
  memory.clear();
  prefs.clear();
  recentReactions.clear();
  modelCatalog=null;
  modelCatalogLoadedAt=0;
  modelCatalogAttemptedAt=0;
}

const stats={
  started:Date.now(),
  requests:0,
  errors:0,
  searches:0,
  searchFailures:0,
  images:0,
  files:0,
  telegramErrors:0,
  openRouterErrors:0,
  firstTokenMs:[],
  totalMs:[]
};

function pushMetric(list,value){
  if(!Number.isFinite(value))return;
  list.push(Math.max(0,Math.round(value)));
  if(list.length>STATS_SAMPLE_LIMIT)list.shift();
}

function avg(values){
  return values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length):0;
}

function formatUptime(seconds){
  const d=Math.floor(seconds/86400);
  const h=Math.floor((seconds%86400)/3600);
  const m=Math.floor((seconds%3600)/60);
  const s=seconds%60;
  return [d?`${d}d`:"",h?`${h}h`:"",m?`${m}m`:"",`${s}s`].filter(Boolean).join(" ");
}

function statusText(admin=false){
  const uptime=Math.floor((Date.now()-stats.started)/1000);
  const lines=[
    "🤖 *Bot Status*",
    "",
    `Uptime: ${esc(formatUptime(uptime))}`,
    `Requests: ${stats.requests}`,
    `Errors: ${stats.errors}`,
    `Searches: ${stats.searches}`,
    `Images: ${stats.images}`,
    `Files: ${stats.files}`,
    `Avg first token: ${stats.firstTokenMs.length?`${avg(stats.firstTokenMs)} ms`:"—"}`,
    `Avg total: ${stats.totalMs.length?`${avg(stats.totalMs)} ms`:"—"}`
  ];
  if(admin){
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

const RX=["👍","👎","❤️","🔥","😂","😢","😡","🤔","😮","🎉","💯","👀","🧠","🙏","👏","💡","💔","🤝","🚀","✨","😎","😭","🥰","😴","🤯","🧐"];

const RX_PATTERNS={
  love:/\b(love|adorable|beautiful|cute|sweet)\b|❤️|😍|🥰|عاشق|عشق|قشنگ|ناز|دوست دارم/i,
  praise:/\b(good job|well done|nice job|great job|awesome|amazing|excellent|perfect|thank you|thanks)\b|ممنون|مرسی|دمت گرم|عالی|فوق.?العاده/i,
  hype:/\b(excited|can't wait|lets go|let's go|insane|huge)\b|🔥|بزن بریم|هیجان/i,
  sad:/\b(sad|depressed|crying|heartbroken|lost|miss|upset|disappointed)\b|😭|😢|غمگین|ناراحتم|گریه|دلتنگ|ناامید/i,
  angry:/\b(angry|furious|pissed|hate|wtf|bullshit)\b|😡|🤬|عصبانی|اعصابم|لعنت|مزخرف|افتضاح/i,
  funny:/\b(lol|lmao|rofl|haha+|hehe+|funny|joke)\b|😂|🤣|خنده|جوک|باحال/i,
  surprise:/\b(no way|really\?|seriously\?|unbelievable|shocking)\b|🤯|😮|😲|جدی؟|واقعا؟|چی؟|باورم نمیشه/i,
  help:/\b(help|can you|could you|please|how do i|how can i|show me|fix this|teach me)\b|کمک|میشه|میتونی|لطفا|چطور|چجوری|درستش کن/i,
  code:/\b(code|coding|program|programming|developer|debug|bug|error|exception|javascript|typescript|python|java|react|node|html|css|api|sql|github|git|docker|kubernetes|cloudflare|render|webhook)\b|کد|برنامه.?نویسی|باگ|خطا|پایتون|جاوااسکریپت/i,
  science:/\b(physics|chemistry|biology|quantum|science|math|mathematics|space|black hole|genetics)\b|فیزیک|شیمی|زیست|علم|کوانتوم|ریاضی|فضا/i,
  money:/\b(money|price|cost|budget|stock|crypto|bitcoin|ethereum|dollar|euro|forex|invest|business|salary|profit)\b|قیمت|پول|سهام|کریپتو|بیت.?کوین|دلار|یورو|سرمایه|کسب.?و.?کار|حقوق/i,
  news:/\b(latest|breaking|news|today|recent|current|what happened|update|election|president|war)\b|اخبار|امروز|جدیدترین|آخرین|جنگ|انتخابات|خبر جدید/i,
  travel:/\b(travel|trip|flight|hotel|vacation|tourist|tourism|visa|airport|passport)\b|سفر|پرواز|هتل|تعطیلات|ویزا|فرودگاه|پاسپورت/i,
  food:/\b(food|cook|cooking|recipe|restaurant|dinner|lunch|breakfast|pizza|burger|coffee|tea)\b|غذا|آشپزی|دستور.?غذا|رستوران|پیتزا|برگر|قهوه|چای/i,
  relationship:/\b(relationship|girlfriend|boyfriend|wife|husband|crush|date|love|breakup|friendship)\b|رابطه|دوست.?دختر|دوست.?پسر|همسر|عشق|جدایی|کراش|دوستی/i
};

function chooseReaction(text,image=false,userId=""){
  const s=String(text||"").trim();
  if(image&&!s)return "👀";
  const score=new Map(RX.map(emoji=>[emoji,0]));
  const add=(emoji,points)=>score.set(emoji,(score.get(emoji)||0)+points);

  if(/😭|😢|sad|depressed|غمگین|ناراحت|دلتنگ|ناامید/i.test(s)){
    add("😢",30);add("😭",10);add("💔",8);
  }
  if(/😡|🤬|angry|furious|عصبانی|مزخرف|افتضاح/i.test(s)){
    add("😡",30);add("👎",7);
  }
  if(/😂|🤣|haha+|lol|lmao/i.test(s))add("😂",30);
  if(/❤️|😍|🥰|love|عشق|دوست دارم/i.test(s))add("❤️",28);
  if(/🔥|excited|let's go|lets go|بزن بریم/i.test(s))add("🔥",25);
  if(/🤯|😮|😲|no way|جدی؟|واقعا؟/i.test(s)){add("😮",26);add("🤯",8);}
  if(RX_PATTERNS.praise.test(s)){add("💯",7);add("👏",5);}
  if(RX_PATTERNS.help.test(s)){add("🙏",5);add("🤔",4);}
  if(RX_PATTERNS.code.test(s)){add("💡",6);add("🧠",4);}
  if(RX_PATTERNS.science.test(s)){add("🧠",7);add("💡",4);}
  if(RX_PATTERNS.money.test(s)){add("🧐",7);add("💯",3);}
  if(RX_PATTERNS.news.test(s)){add("🧐",7);add("👀",3);}
  if(RX_PATTERNS.travel.test(s)){add("✨",6);add("👀",3);}
  if(RX_PATTERNS.food.test(s)){add("❤️",5);add("✨",2);}
  if(RX_PATTERNS.relationship.test(s)){add("❤️",7);add("💔",4);}
  if(/[?؟]/.test(s))add("🤔",5);
  if(/[!！]{2,}/.test(s))add("🔥",4);
  if(image)add("👀",8);

  let candidates=[...score.entries()].sort((a,b)=>b[1]-a[1]);
  if(!candidates.length||candidates[0][1]<=0)candidates=[["👍",1]];

  const last=recentReactions.get(String(userId))?.emoji;
  if(last&&candidates.length>1&&candidates[0][0]===last)candidates=candidates.slice(1);

  const best=candidates[0]?.[0]||"👍";
  if(userId)recentReactions.set(String(userId),{emoji:best,expires:Date.now()+REACTION_MEMORY_TTL_MS});
  return best;
}

async function tg(method,body,{retries=1,timeoutMs=REQUEST_TIMEOUT_MS}={}){
  if(!BOT_TOKEN)return{ok:false,description:"BOT_TOKEN is missing"};

  for(let attempt=0;attempt<=retries;attempt++){
    try{
      const response=await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(body??{}),
        signal:AbortSignal.timeout(timeoutMs)
      });

      const raw=await response.text();
      let data;
      try{data=raw?JSON.parse(raw):{ok:response.ok};}
      catch{data={ok:false,description:raw||response.statusText};}

      if(response.ok&&data?.ok)return data;

      stats.telegramErrors++;

      const retryAfter=Number(data?.parameters?.retry_after||0);
      if(response.status===429&&attempt<retries){
        await sleep(Math.min(Math.max(retryAfter*1000,250),10000));
        continue;
      }

      return data;
    }catch(error){
      stats.telegramErrors++;
      if(attempt<retries){
        await sleep(250*(attempt+1));
        continue;
      }
      return{ok:false,description:error instanceof Error?error.message:String(error)};
    }
  }

  return{ok:false,description:"Telegram request failed"};
}

async function sendMessage(chatId,text,replyTo,options={}){
  const clean=String(text??"");
  if(!clean)return{ok:false,description:"Empty message"};

  const base={
    chat_id:chatId,
    text:clean,
    ...(replyTo?{reply_parameters:{message_id:replyTo}}:{})
  };

  if(options.markdown!==false){
    const richText=await tg("sendMessage",{...base,parse_mode:"MarkdownV2"});
    if(richText?.ok)return richText;
  }

  return tg("sendMessage",base);
}

async function sendPlain(chatId,text,replyTo){
  const clean=String(text??"");
  if(!clean)return{ok:false,description:"Empty message"};
  return tg("sendMessage",{
    chat_id:chatId,
    text:clean,
    ...(replyTo?{reply_parameters:{message_id:replyTo}}:{})
  });
}

async function editMessagePlain(chatId,messageId,text){
  const clean=String(text??"");
  if(!clean)return{ok:false,description:"Empty message"};
  return tg("editMessageText",{
    chat_id:chatId,
    message_id:messageId,
    text:clean
  });
}

async function editMessageRich(chatId,messageId,text){
  const clean=String(text??"");
  if(!clean)return{ok:false,description:"Empty message"};

  const rich=await tg("editMessageText",{
    chat_id:chatId,
    message_id:messageId,
    rich_message:{
      markdown:clean,
      is_rtl:detectRtl(clean)
    }
  });

  if(rich?.ok)return rich;

  if(clean.length<=TG_LIMIT){
    return tg("editMessageText",{
      chat_id:chatId,
      message_id:messageId,
      text:clean,
      parse_mode:"MarkdownV2"
    });
  }

  return rich;
}

async function sendRichMessage(chatId,text,replyTo){
  const clean=String(text??"");
  if(!clean)return{ok:false,description:"Empty rich message"};

  const rich=await tg("sendRichMessage",{
    chat_id:chatId,
    rich_message:{
      markdown:clean,
      is_rtl:detectRtl(clean)
    },
    ...(replyTo?{reply_parameters:{message_id:replyTo}}:{})
  });

  if(rich?.ok)return rich;

  if(clean.length>TG_LIMIT){
    return{ok:false,description:"Rich message unavailable for oversized chunk."};
  }

  return sendMessage(chatId,clean,replyTo,{markdown:true});
}

async function sendRichMessageDraft(chatId,draftId,text){
  const clean=String(text??"").slice(0,RICH_LIMIT);

  return tg("sendRichMessageDraft",{
    chat_id:chatId,
    draft_id:draftId,
    rich_message:{
      markdown:clean,
      is_rtl:detectRtl(clean)
    }
  },{retries:0});
}

async function sendTextMessageDraft(chatId,draftId,text){
  const clean=String(text??"").slice(0,TG_LIMIT);

  return tg("sendMessageDraft",{
    chat_id:chatId,
    draft_id:draftId,
    text:clean,
    parse_mode:"MarkdownV2"
  },{retries:0});
}

async function typing(chatId){
  return tg("sendChatAction",{
    chat_id:chatId,
    action:"typing"
  },{retries:0});
}

async function reactMessage(chatId,messageId,emoji){
  if(!RX.includes(emoji))return;

  const result=await tg("setMessageReaction",{
    chat_id:chatId,
    message_id:messageId,
    reaction:[{type:"emoji",emoji}],
    is_big:false
  },{retries:0});

  if(!result.ok){
    console.warn(`Reaction failed: ${sanitizeLog(result.description)}`);
  }
}

async function getMe(){
  const result=await tg("getMe",{});
  if(result.ok){
    botInfo=result.result;
    botId=result.result.id;
  }
  return result;
}

const IMAGE_MIMES=new Set([
  "image/jpeg","image/png","image/webp","image/gif"
]);

const FILE_MIME_BY_EXT={
  txt:"text/plain",
  md:"text/markdown",
  markdown:"text/markdown",
  csv:"text/csv",
  json:"application/json",
  js:"text/javascript",
  mjs:"text/javascript",
  cjs:"text/javascript",
  ts:"text/typescript",
  jsx:"text/jsx",
  tsx:"text/tsx",
  py:"text/x-python",
  java:"text/x-java-source",
  c:"text/x-c",
  h:"text/x-c",
  cpp:"text/x-c++src",
  hpp:"text/x-c++src",
  cs:"text/plain",
  go:"text/plain",
  rs:"text/plain",
  php:"text/plain",
  rb:"text/plain",
  sh:"text/x-shellscript",
  bash:"text/x-shellscript",
  html:"text/html",
  htm:"text/html",
  css:"text/css",
  xml:"application/xml",
  yaml:"application/yaml",
  yml:"application/yaml",
  log:"text/plain",
  rtf:"application/rtf",
  pdf:"application/pdf",
  doc:"application/msword",
  docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:"application/vnd.ms-excel",
  xlsx:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt:"application/vnd.ms-powerpoint",
  pptx:"application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt:"application/vnd.oasis.opendocument.text",
  ods:"application/vnd.oasis.opendocument.spreadsheet",
  odp:"application/vnd.oasis.opendocument.presentation",
  zip:"application/zip"
};

const TEXT_MIMES=new Set([
  "text/plain","text/markdown","text/csv","text/javascript",
  "text/typescript","text/jsx","text/tsx","text/x-python",
  "text/x-java-source","text/x-c","text/x-c++src",
  "text/x-shellscript","text/html","text/css",
  "application/json","application/xml","application/yaml",
  "application/rtf"
]);

function extensionOf(value){
  const clean=String(value||"").toLowerCase().split(/[?#]/)[0];
  const index=clean.lastIndexOf(".");
  return index>=0?clean.slice(index+1):"";
}

function mimeFromExtension(value){
  return FILE_MIME_BY_EXT[extensionOf(value)]||"";
}

function normalizeMime(value){
  return String(value||"").split(";",1)[0].trim().toLowerCase();
}

function imageMagicMatches(buffer,mime){
  const b=Buffer.from(buffer);
  if(!b.length)return false;

  if(mime==="image/jpeg"){
    return b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff;
  }

  if(mime==="image/png"){
    return b.length>=8&&b.subarray(0,8).equals(Buffer.from([
      137,80,78,71,13,10,26,10
    ]));
  }

  if(mime==="image/gif"){
    return b.length>=6&&["GIF87a","GIF89a"].includes(
      b.subarray(0,6).toString("ascii")
    );
  }

  if(mime==="image/webp"){
    return b.length>=12&&
      b.subarray(0,4).toString("ascii")==="RIFF"&&
      b.subarray(8,12).toString("ascii")==="WEBP";
  }

  return false;
}

function detectImageMime(buffer,path="",httpMime=""){
  const candidate=normalizeMime(httpMime);
  const extMime=mimeFromExtension(path);

  if(IMAGE_MIMES.has(candidate)&&imageMagicMatches(buffer,candidate))return candidate;
  if(IMAGE_MIMES.has(extMime)&&imageMagicMatches(buffer,extMime))return extMime;

  return "";
}

function detectFileMime(fileName,declaredMime,httpMime,buffer){
  const declared=normalizeMime(declaredMime);
  const http=normalizeMime(httpMime);
  const ext=mimeFromExtension(fileName);

  const candidates=[declared,http,ext].filter(Boolean);

  for(const mime of candidates){
    if(mime==="application/octet-stream")continue;

    if(IMAGE_MIMES.has(mime)){
      if(imageMagicMatches(buffer,mime))return mime;
      continue;
    }

    return mime;
  }

  return "";
}

async function telegramFile(fileId){
  const meta=await tg("getFile",{file_id:fileId});

  if(!meta.ok){
    throw new Error("Telegram could not resolve the file.");
  }

  const path=String(meta.result?.file_path||"");
  const fileSize=Number(meta.result?.file_size||0);

  if(!path)throw new Error("Telegram returned no file path.");

  if(fileSize&&fileSize>MAX_DOWNLOAD_BYTES){
    throw new Error(`File is too large to process here (max ${Math.floor(MAX_DOWNLOAD_BYTES/(1024*1024))} MB).`);
  }

  const response=await fetch(
    `${TG_API}/file/bot${BOT_TOKEN}/${path}`,
    {signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)}
  );

  if(!response.ok)throw new Error(`File download failed (${response.status}).`);

  const httpMime=normalizeMime(response.headers.get("content-type"));
  const contentLength=Number(response.headers.get("content-length")||0);

  if(contentLength>MAX_DOWNLOAD_BYTES){
    throw new Error(`File is too large to process here (max ${Math.floor(MAX_DOWNLOAD_BYTES/(1024*1024))} MB).`);
  }

  const arrayBuffer=await response.arrayBuffer();

  if(arrayBuffer.byteLength>MAX_DOWNLOAD_BYTES){
    throw new Error(`File is too large to process here (max ${Math.floor(MAX_DOWNLOAD_BYTES/(1024*1024))} MB).`);
  }

  const buffer=Buffer.from(arrayBuffer);

  return{
    buffer,
    path,
    httpMime,
    fileSize:buffer.length,
    base64:buffer.toString("base64")
  };
}

function decodeTextFile(buffer,fileName,mime=""){
  const normalized=normalizeMime(mime);
  const ext=extensionOf(fileName);

  const textLike=
    TEXT_MIMES.has(normalized)||
    [
      "txt","md","markdown","csv","json","js","mjs","cjs","ts",
      "jsx","tsx","py","java","c","h","cpp","hpp","cs","go","rs",
      "php","rb","sh","bash","html","htm","css","xml","yaml","yml","log"
    ].includes(ext);

  if(!textLike)return null;

  return Buffer.from(buffer)
    .toString("utf8")
    .replace(/^\uFEFF/,"")
    .slice(0,MAX_FILE_TEXT_CHARS);
}

function filePartFromDownload(file,fileName,declaredMime){
  const mime=detectFileMime(
    fileName,
    declaredMime,
    file.httpMime,
    file.buffer
  );

  if(!mime||mime==="application/octet-stream")return null;
  if(file.buffer.length>MAX_OR_FILE_BYTES)return null;

  return{
    filename:String(fileName||"file").slice(0,255),
    file_data:`data:${mime};base64,${file.base64}`,
    mime
  };
}

const SEARCH_TOOL=[
  {
    type:"function",
    function:{
      name:"web_search",
      description:"Search the web for current, recent, live, or externally verifiable information. Use it when facts may have changed or need verification.",
      parameters:{
        type:"object",
        properties:{
          query:{
            type:"string",
            minLength:1,
            maxLength:500
          }
        },
        required:["query"],
        additionalProperties:false
      }
    }
  }
];

async function searchWeb(query){
  if(!LANGSEARCH_KEY)throw new Error("Web search is not configured.");

  const cleanQuery=String(query||"").trim().slice(0,500);
  if(!cleanQuery)throw new Error("Search query is empty.");

  stats.searches++;

  const response=await fetch(
    LANGSEARCH_API,
    {
      method:"POST",
      headers:{
        "content-type":"application/json",
        authorization:`Bearer ${LANGSEARCH_KEY}`
      },
      body:JSON.stringify({
        query:cleanQuery,
        freshness:"noLimit",
        summary:true,
        count:5
      }),
      signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  );

  if(!response.ok){
    stats.searchFailures++;
    throw new Error(`Search service returned ${response.status}.`);
  }

  let data;

  try{
    data=await response.json();
  }catch{
    stats.searchFailures++;
    throw new Error("Search service returned invalid JSON.");
  }

  const results=
    Array.isArray(data?.data?.webPages?.value)
      ?data.data.webPages.value
      :[];

  if(!results.length)return"No useful search results were returned.";

  return results
    .slice(0,5)
    .map((item,index)=>{
      const name=String(item?.name||"Untitled").slice(0,180);
      const url=String(item?.url||"").slice(0,500);
      const summary=String(item?.summary||item?.snippet||"").slice(0,700);

      return[
        `[${index+1}] ${name}`,
        `URL: ${url}`,
        summary
      ].join("\n");
    })
    .join("\n\n");
}

async function fetchModelCatalog(force=false){
  const now=Date.now();

  if(
    !force&&
    modelCatalog&&
    now-modelCatalogLoadedAt<10*60*1000
  ){
    return modelCatalog;
  }

  if(
    !force&&
    modelCatalogAttemptedAt&&
    now-modelCatalogAttemptedAt<60*1000
  ){
    return modelCatalog;
  }

  if(!OR_KEY)return null;

  modelCatalogAttemptedAt=now;

  try{
    const response=await fetch(
      OR_MODELS_API,
      {
        headers:{authorization:`Bearer ${OR_KEY}`},
        signal:AbortSignal.timeout(15000)
      }
    );

    if(!response.ok)return null;

    const data=await response.json();

    if(!Array.isArray(data?.data))return null;

    modelCatalog=new Map(
      data.data.map(item=>[
        String(item.id),
        item
      ])
    );

    modelCatalogLoadedAt=now;
    modelCatalogAttemptedAt=now;

    return modelCatalog;
  }catch{
    return null;
  }
}

async function getModelInfo(model){
  const catalog=await fetchModelCatalog(false);
  return catalog?.get(model)||null;
}

async function ensureImageModel(model){
  if(model==="openrouter/free")return true;

  const info=await getModelInfo(model);

  const modalities=
    info?.architecture?.input_modalities;

  if(!Array.isArray(modalities)){
    throw new Error(
      "Vision model capability could not be verified. Set OPENROUTER_VISION_MODEL to a model with image input support."
    );
  }

  if(!modalities.includes("image")){
    throw new Error(
      `Configured vision model does not accept image input: ${model}`
    );
  }

  return true;
}

function chooseModel({image,file,mode}){
  if(image)return VISION_MODEL;
  if(file)return FILE_MODEL;
  if(mode==="fast")return FAST_MODEL;
  if(mode==="deep")return DEEP_MODEL;
  return TEXT_MODEL;
}

async function buildOpenRouterBody(messages,model,mode,tools){
  const body={
    model,
    messages,
    stream:true
  };

  let info=null;

  if(mode==="deep"||tools?.length){
    info=await getModelInfo(model);
  }

  const supported=new Set(
    Array.isArray(info?.supported_parameters)
      ?info.supported_parameters
      :[]
  );

  if(tools?.length){
    const toolSupported=
      model==="openrouter/free"||
      supported.has("tools");

    if(toolSupported){
      body.tools=tools;
      body.tool_choice="auto";
    }
  }

  if(
    mode==="deep"&&
    supported.has("reasoning")
  ){
    const efforts=info?.reasoning?.supported_efforts;

    if(Array.isArray(efforts)&&efforts.length){
      const desired=[
        "high","max","xhigh","medium"
      ].find(effort=>efforts.includes(effort));

      if(desired){
        body.reasoning={
          effort:desired,
          exclude:true
        };
      }else{
        body.reasoning={
          effort:efforts[0],
          exclude:true
        };
      }
    }else{
      body.reasoning={
        effort:"high",
        exclude:true
      };
    }
  }

  return body;
}

async function orRequest(messages,model,mode,tools=null){
  if(!OR_KEY){
    throw new Error("OPENROUTER_API_KEY is missing.");
  }

  const body=await buildOpenRouterBody(
    messages,
    model,
    mode,
    tools
  );

  let response;

  try{
    response=await fetch(
      OR_API,
      {
        method:"POST",
        headers:{
          authorization:`Bearer ${OR_KEY}`,
          "content-type":"application/json",
          ...(process.env.OPENROUTER_HTTP_REFERER
            ?{"HTTP-Referer":process.env.OPENROUTER_HTTP_REFERER}
            :{}),
          ...(process.env.OPENROUTER_X_TITLE
            ?{"X-Title":process.env.OPENROUTER_X_TITLE}
            :{})
        },
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    );
  }catch(error){
    stats.openRouterErrors++;

    throw new Error(
      `OpenRouter request failed: ${
        error instanceof Error?error.message:"network error"
      }`
    );
  }

  if(!response.ok){
    stats.openRouterErrors++;

    const raw=await response.text().catch(()=>"");
    let detail="";

    try{
      const parsed=raw?JSON.parse(raw):null;

      detail=
        parsed?.error?.message||
        parsed?.message||
        "";
    }catch{
      detail=raw;
    }

    const suffix=detail
      ?`: ${sanitizeLog(detail).slice(0,300)}`
      :"";

    throw new OpenRouterError(
      response.status,
      `OpenRouter returned ${response.status}${suffix}`
    );
  }

  if(!response.body){
    throw new OpenRouterError(
      502,
      "OpenRouter returned an empty stream."
    );
  }

  return response;
}

class OpenRouterError extends Error{
  constructor(status,message){
    super(message);
    this.name="OpenRouterError";
    this.status=status;
  }
}

function cleanSystem(userId,mode){
  const extra=[];

  if(mode==="fast"){
    extra.push(
      "Be concise and prioritize speed. Do not search the web unless the system permits it."
    );
  }

  if(mode==="deep"){
    extra.push(
      "Be thorough. Verify time-sensitive claims with web search when appropriate."
    );
  }

  if(
    LANGSEARCH_KEY&&
    mode!=="fast"
  ){
    extra.push(
      "Use the web_search tool whenever information is current, recent, live, unstable, niche, or externally verifiable. Prefer searching over saying you do not know when external verification could answer the question. Do not search unnecessarily."
    );
  }

  extra.push(
    "Never expose internal tool calls, hidden reasoning, API keys, secrets, or implementation details."
  );

  extra.push(
    "Return a normal user-facing answer. Do not use hidden XML-style reaction tags or metadata markers."
  );

  extra.push(
    "Use clear Telegram Rich Text / Markdown formatting in the final answer when appropriate: short bold headings, readable paragraphs, bullets, numbered steps, inline code, and fenced code blocks."
  );

  const prefStyle=getPref(userId,"style");
  const prefLang=getPref(userId,"language");

  if(prefStyle){
    extra.push(`Preferred style: ${prefStyle}.`);
  }

  if(prefLang){
    extra.push(`Preferred language: ${prefLang}.`);
  }

  return SYSTEM_PROMPT+
    (
      extra.length
        ?`\n\n${extra.join("\n")}`
        :""
    );
}

async function buildMessages({
  userId,
  prompt,
  image,
  file,
  fileText,
  mode
}){
  const messages=[
    {
      role:"system",
      content:cleanSystem(userId,mode)
    }
  ];

  if(!image&&!file){
    messages.push(
      ...getHistory(userId).slice(
        -(HISTORY_PAIRS*2)
      )
    );
  }

  if(image){
    messages.push({
      role:"user",
      content:[
        {
          type:"text",
          text:prompt||"Describe this image in detail."
        },
        {
          type:"image_url",
          image_url:{
            url:`data:${image.mime};base64,${image.base64}`
          }
        }
      ]
    });

    return messages;
  }

  if(file?.part){
    messages.push({
      role:"user",
      content:[
        {
          type:"text",
          text:prompt||`Analyze the attached file: ${file.name}`
        },
        {
          type:"file",
          file:{
            filename:file.part.filename,
            file_data:file.part.file_data
          }
        }
      ]
    });

    return messages;
  }

  const finalPrompt=fileText
    ?[
        prompt||"Analyze this file.",
        `File name: ${file?.name||"unknown"}`,
        "File contents:",
        fileText
      ].join("\n\n")
    :prompt;

  messages.push({
    role:"user",
    content:String(finalPrompt||"").slice(
      0,
      MAX_USER_PROMPT_CHARS+
      MAX_FILE_TEXT_CHARS
    )
  });

  return messages;
}

async function streamOpenRouter(response,onPiece,onToolCalls){
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let pending="";
  const toolCalls=[];

  while(true){
    const{value,done}=await reader.read();
    if(done)break;

    pending+=decoder.decode(
      value,
      {stream:true}
    );

    const lines=pending.split(/\r?\n/);
    pending=lines.pop()||"";

    for(const rawLine of lines){
      processSseLine(
        rawLine,
        onPiece,
        toolCalls
      );
    }
  }

  pending+=decoder.decode();

  if(pending){
    for(const rawLine of pending.split(/\r?\n/)){
      processSseLine(
        rawLine,
        onPiece,
        toolCalls
      );
    }
  }

  if(typeof onToolCalls==="function"){
    onToolCalls(
      toolCalls.filter(validToolCall)
    );
  }
}

function processSseLine(rawLine,onPiece,toolCalls){
  const line=rawLine.trim();

  if(!line.startsWith("data:"))return;

  const payload=line.slice(5).trim();

  if(!payload||payload==="[DONE]")return;

  let chunk;

  try{
    chunk=JSON.parse(payload);
  }catch{
    return;
  }

  const delta=chunk?.choices?.[0]?.delta;

  if(Array.isArray(delta?.tool_calls)){
    mergeTools(
      toolCalls,
      delta.tool_calls
    );
  }

  const piece=
    typeof delta?.content==="string"
      ?delta.content
      :"";

  if(piece&&typeof onPiece==="function"){
    onPiece(piece);
  }
}

function mergeTools(acc,deltas){
  for(const delta of deltas){
    const index=
      Number.isInteger(delta?.index)
        ?delta.index
        :0;

    if(!acc[index]){
      acc[index]={
        id:"",
        type:"function",
        function:{
          name:"",
          arguments:""
        }
      };
    }

    if(delta?.id){
      acc[index].id+=String(delta.id);
    }

    if(delta?.type){
      acc[index].type=delta.type;
    }

    if(delta?.function?.name){
      acc[index].function.name+=String(
        delta.function.name
      );
    }

    if(delta?.function?.arguments){
      acc[index].function.arguments+=String(
        delta.function.arguments
      );
    }
  }
}

function validToolCall(call){
  return Boolean(
    call?.id&&
    call?.function?.name
  );
}

async function executeToolCalls(toolCalls,searchState){
  const assistantToolCalls=[];
  const toolMessages=[];

  for(const call of toolCalls){
    if(call.function?.name!=="web_search")continue;

    let args;

    try{
      args=JSON.parse(
        call.function.arguments||"{}"
      );
    }catch{
      args={};
    }

    const query=String(args?.query||"").trim();

    if(
      !query||
      searchState.count>=MAX_SEARCHES
    ){
      continue;
    }

    searchState.count++;

    const result=await searchWeb(query);

    assistantToolCalls.push({
      id:call.id,
      type:"function",
      function:{
        name:"web_search",
        arguments:JSON.stringify({query})
      }
    });

    toolMessages.push({
      role:"tool",
      tool_call_id:call.id,
      content:String(result||"").slice(
        0,
        6000
      )
    });
  }

  return{
    assistantToolCalls,
    toolMessages
  };
}

function parseCommand(text){
  const raw=String(text||"").trim();

  if(!raw.startsWith("/"))return null;

  const[
    first,
    ...rest
  ]=raw.split(/\s+/);

  const[
    commandName
  ]=first.split("@");

  return{
    command:commandName.toLowerCase(),
    arg:rest.join(" ").trim()
  };
}

async function command(
  chatId,
  userId,
  text,
  messageId
){
  const parsed=parseCommand(text);

  if(!parsed)return false;

  switch(parsed.command){
    case"/start":
      await sendRichMessage(
        chatId,
        [
          "🤖 *Welcome.*",
          "",
          "Send me a message to chat. In groups, mention me, reply to me, or use the trigger command.",
          "",
          "Use /help to see everything I support."
        ].join("\n"),
        messageId
      );
      return true;

    case"/help":
      await sendRichMessage(
        chatId,
        helpText(),
        messageId
      );
      return true;

    case"/fast":
      setPref(
        userId,
        "mode",
        "fast"
      );

      await sendRichMessage(
        chatId,
        "⚡ *Fast mode enabled.*",
        messageId
      );
      return true;

    case"/normal":
      setPref(
        userId,
        "mode",
        "normal"
      );

      await sendRichMessage(
        chatId,
        "🙂 *Normal mode enabled.*",
        messageId
      );
      return true;

    case"/deep":
      setPref(
        userId,
        "mode",
        "deep"
      );

      await sendRichMessage(
        chatId,
        "🧠 *Deep mode enabled.*",
        messageId
      );
      return true;

    case"/style":
      if(!parsed.arg){
        await sendRichMessage(
          chatId,
          "Usage: `/style concise`",
          messageId
        );
      }else{
        setPref(
          userId,
          "style",
          parsed.arg
        );

        await sendRichMessage(
          chatId,
          `✍️ Style set to: *${esc(parsed.arg)}*`,
          messageId
        );
      }

      return true;

    case"/language":
      if(!parsed.arg){
        await sendRichMessage(
          chatId,
          "Usage: `/language English`",
          messageId
        );
      }else{
        setPref(
          userId,
          "language",
          parsed.arg
        );

        await sendRichMessage(
          chatId,
          `🌐 Language set to: *${esc(parsed.arg)}*`,
          messageId
        );
      }

      return true;

    case"/clear":
    case"/clearmemory":
      clearUserMemory(userId);

      await sendRichMessage(
        chatId,
        "🧹 *Conversation memory cleared.*",
        messageId
      );
      return true;

    case"/status":
      await sendRichMessage(
        chatId,
        statusText(false),
        messageId
      );
      return true;

    case"/stats":
      await sendRichMessage(
        chatId,
        statusText(false),
        messageId
      );
      return true;

    case"/models":
      await sendRichMessage(
        chatId,
        [
          "🤖 *Active models*",
          "",
          `Normal: \`${escCode(TEXT_MODEL)}\``,
          `Fast: \`${escCode(FAST_MODEL)}\``,
          `Deep: \`${escCode(DEEP_MODEL)}\``,
          `Vision: \`${escCode(VISION_MODEL)}\``,
          `Files: \`${escCode(FILE_MODEL)}\``
        ].join("\n"),
        messageId
      );
      return true;

    default:
      return false;
  }
}

function helpText(){
  return[
    "🤖 *How to use the bot*",
    "",
    "💬 *Chat*",
    "• In a private chat, send a normal message.",
    "• In a group, mention me, reply to one of my messages, or use the trigger command.",
    `• Trigger command: \`${esc(TRIGGER||"!ai")}\` your message`,
    "",
    "⚡ *Modes*",
    "• `/fast` — prioritize speed and concise answers.",
    "• `/normal` — balanced default behavior.",
    "• `/deep` — more thorough reasoning and web research when useful.",
    "",
    "🧠 *Memory*",
    `• The bot keeps the most recent ${HISTORY_PAIRS} conversation pair${HISTORY_PAIRS===1?"":"s"} in memory per user.`,
    "• `/clear` or `/clearmemory` clears your conversation history.",
    "• Memory is local to the running service and resets when it restarts.",
    "",
    "🌐 *Web search*",
    "• The bot can automatically search when information needs current, recent, live, niche, or external verification.",
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
    "• `/help` — show this guide again."
  ].join("\n");
}

const ADMIN_IDS=new Set(
  String(process.env.ADMIN_IDS||"")
    .split(",")
    .map(value=>value.trim())
    .filter(Boolean)
);

async function adminCommand(
  chatId,
  userId,
  text,
  messageId
){
  if(!ADMIN_IDS.has(String(userId)))return false;

  const parsed=parseCommand(text);
  if(!parsed)return false;

  switch(parsed.command){
    case"/admin":
      await sendRichMessage(
        chatId,
        "🔐 *Admin access active.*",
        messageId
      );
      return true;

    case"/adminstats":
      await sendRichMessage(
        chatId,
        statusText(true),
        messageId
      );
      return true;

    case"/clearall":
      clearAllCache();

      await sendRichMessage(
        chatId,
        "🧹 *All local cache and memory cleared.*",
        messageId
      );
      return true;

    case"/reloadmodels":
      await fetchModelCatalog(true);

      await sendRichMessage(
        chatId,
        "🔄 *Model catalog refreshed.*",
        messageId
      );
      return true;

    default:
      return false;
  }
}

async function generate({
  chatId,
  userId,
  prompt,
  image,
  file,
  fileText,
  mode,
  replyTo,
  isPrivate
}){
  const started=Date.now();
  stats.requests++;

  let full="";
  let firstTokenRecorded=false;
  let finalModel=null;
  let streamMessageId=null;
  let lastEdit=0;
  const draftIdValue=randomDraftId();
  let groupEditChain=Promise.resolve();
  let draftChain=Promise.resolve();
  let typingTimer=null;
  let draftFallbackMessageId=null;
  let useRichDraft=isPrivate;

  try{
    finalModel=chooseModel({
      image:Boolean(image),
      file:Boolean(file),
      mode
    });

    if(image){
      await ensureImageModel(finalModel);
    }

    console.log(
      `[request] model=${sanitizeLog(finalModel)} mode=${mode} image=${Boolean(image)} file=${Boolean(file)}`
    );

    const messages=await buildMessages({
      userId,
      prompt,
      image,
      file,
      fileText,
      mode
    });

    if(!isPrivate){
      const placeholder=await sendRichMessage(
        chatId,
        "🧠 *Reasoning…*",
        replyTo
      );

      if(
        !placeholder?.ok||
        !placeholder?.result?.message_id
      ){
        throw new Error(
          "Could not create the Telegram streaming message."
        );
      }

      streamMessageId=placeholder.result.message_id;
    }else{
      draftChain=draftChain.then(
        async()=>{
          const result=await sendRichMessageDraft(
            chatId,
            draftIdValue,
            "🧠 *Reasoning…*"
          );

          if(result.ok)return;

          const plain=await sendTextMessageDraft(
            chatId,
            draftIdValue,
            "🧠 *Reasoning…*"
          );

          if(plain.ok){
            useRichDraft=false;
            return;
          }

          useRichDraft=false;

          const fallback=await sendRichMessage(
            chatId,
            "🧠 *Reasoning…*",
            replyTo
          );

          if(fallback?.ok){
            draftFallbackMessageId=
              fallback.result?.message_id||null;
          }
        }
      );
    }

    typingTimer=setInterval(
      ()=>typing(chatId).catch(()=>{}),
      TYPING_MS
    );

    typingTimer.unref?.();

    const searchState={count:0};

    for(
      let round=0;
      round<MAX_TOOL_ROUNDS;
      round++
    ){
      let roundText="";
      const toolCalls=[];

      const allowTools=Boolean(
        LANGSEARCH_KEY&&
        mode!=="fast"&&
        searchState.count<MAX_SEARCHES
      );

      const response=await orRequest(
        messages,
        finalModel,
        mode,
        allowTools?SEARCH_TOOL:null
      );

      let statusLast=0;

      await streamOpenRouter(
        response,
        piece=>{
          if(!firstTokenRecorded){
            firstTokenRecorded=true;
            pushMetric(
              stats.firstTokenMs,
              Date.now()-started
            );
          }

          roundText+=piece;
          full+=piece;

          const now=Date.now();

          if(
            isPrivate&&
            now-statusLast>=DRAFT_UPDATE_MS&&
            full.trim()
          ){
            statusLast=now;

            const preview=full.slice(
              0,
              RICH_LIMIT
            );

            draftChain=draftChain
              .then(async()=>{
                if(useRichDraft){
                  const richResult=
                    await sendRichMessageDraft(
                      chatId,
                      draftIdValue,
                      preview
                    );

                  if(!richResult.ok){
                    useRichDraft=false;

                    const plainResult=
                      await sendTextMessageDraft(
                        chatId,
                        draftIdValue,
                        preview.slice(0,TG_LIMIT)
                      );

                    if(
                      !plainResult.ok&&
                      !draftFallbackMessageId
                    ){
                      const fallback=
                        await sendRichMessage(
                          chatId,
                          "🧠 *Reasoning…*",
                          replyTo
                        );

                      if(fallback?.ok){
                        draftFallbackMessageId=
                          fallback.result
                            ?.message_id||null;
                      }
                    }
                  }
                }else if(draftFallbackMessageId){
                  const rich=
                    await editMessageRich(
                      chatId,
                      draftFallbackMessageId,
                      preview
                    );

                  if(!rich.ok){
                    const plain=
                      await editMessagePlain(
                        chatId,
                        draftFallbackMessageId,
                        preview.slice(0,TG_LIMIT)
                      );

                    if(!plain.ok){
                      draftFallbackMessageId=null;
                    }
                  }
                }else{
                  const plain=
                    await sendTextMessageDraft(
                      chatId,
                      draftIdValue,
                      preview.slice(0,TG_LIMIT)
                    );

                  if(!plain.ok){
                    const fallback=
                      await sendRichMessage(
                        chatId,
                        "🧠 *Reasoning…*",
                        replyTo
                      );

                    if(fallback?.ok){
                      draftFallbackMessageId=
                        fallback.result
                          ?.message_id||null;
                    }
                  }
                }
              })
              .catch(()=>{});
          }else if(
            !isPrivate&&
            streamMessageId&&
            now-lastEdit>=STREAM_EDIT_MS
          ){
            lastEdit=now;

            const preview=full.slice(
              0,
              RICH_LIMIT
            );

            groupEditChain=groupEditChain
              .then(async()=>{
                const rich=
                  await editMessageRich(
                    chatId,
                    streamMessageId,
                    preview
                  );

                if(!rich.ok){
                  await editMessagePlain(
                    chatId,
                    streamMessageId,
                    preview.slice(0,TG_LIMIT)
                  );
                }
              })
              .catch(()=>{});
          }
        },
        calls=>{
          toolCalls.push(...calls);
        }
      );

      if(!toolCalls.length){
        break;
      }

      const hasSearch=toolCalls.some(
        call=>call?.function?.name==="web_search"
      );

      if(hasSearch){
        if(isPrivate){
          draftChain=draftChain.then(
            ()=>sendRichMessageDraft(
              chatId,
              draftIdValue,
              "🔎 *Searching the web…*"
            ).catch(()=>{})
          );
        }else if(streamMessageId){
          groupEditChain=groupEditChain.then(
            ()=>editMessageRich(
              chatId,
              streamMessageId,
              "🔎 *Searching the web…*"
            ).catch(()=>{})
          );
        }
      }

      let toolResult;

      try{
        toolResult=await executeToolCalls(
          toolCalls,
          searchState
        );
      }catch(error){
        stats.searchFailures++;
        console.warn(
          `[search] ${sanitizeLog(
            error instanceof Error
              ?error.message
              :error
          )}`
        );

        toolResult={
          assistantToolCalls:[],
          toolMessages:[]
        };
      }

      if(
        !toolResult.assistantToolCalls.length||
        !toolResult.toolMessages.length
      ){
        break;
      }

      if(isPrivate){
        draftChain=draftChain.then(
          ()=>sendRichMessageDraft(
            chatId,
            draftIdValue,
            "🧠 *Reasoning from the search results…*"
          ).catch(()=>{})
        );
      }else if(streamMessageId){
        groupEditChain=groupEditChain.then(
          ()=>editMessageRich(
            chatId,
            streamMessageId,
            "🧠 *Reasoning from the search results…*"
          ).catch(()=>{})
        );
      }

      messages.push({
        role:"assistant",
        content:roundText||"",
        tool_calls:toolResult.assistantToolCalls
      });

      messages.push(
        ...toolResult.toolMessages
      );
    }

    if(isPrivate){
      draftChain=draftChain.then(
        ()=>sendRichMessageDraft(
          chatId,
          draftIdValue,
          "✍️ *Preparing the final answer…*"
        ).catch(()=>{})
      );
    }else if(streamMessageId){
      groupEditChain=groupEditChain.then(
        ()=>editMessageRich(
          chatId,
          streamMessageId,
          "✍️ *Preparing the final answer…*"
        ).catch(()=>{})
      );
    }

    const finalAnswer=full.trim();

    if(!finalAnswer){
      throw new Error(
        "The AI returned an empty response."
      );
    }

    await groupEditChain;

    await draftChain;

    if(isPrivate){
      if(useRichDraft){
        const finalResult=
          await sendRichMessageDraft(
            chatId,
            draftIdValue,
            finalAnswer
          );

        if(!finalResult.ok){
          useRichDraft=false;
        }
      }

      if(
        !useRichDraft&&
        draftFallbackMessageId
      ){
        const result=await editMessageRich(
          chatId,
          draftFallbackMessageId,
          finalAnswer
        );

        if(!result.ok){
          await editMessagePlain(
            chatId,
            draftFallbackMessageId,
            finalAnswer.slice(0,TG_LIMIT)
          );
        }
      }

      if(
        !useRichDraft&&
        !draftFallbackMessageId
      ){
        await sendRichMessage(
          chatId,
          finalAnswer,
          replyTo
        );
      }
    }else if(streamMessageId){
      const result=await editMessageRich(
        chatId,
        streamMessageId,
        finalAnswer
      );

      if(!result.ok){
        await editMessagePlain(
          chatId,
          streamMessageId,
          finalAnswer.slice(0,TG_LIMIT)
        );
      }
    }else{
      await sendRichMessage(
        chatId,
        finalAnswer,
        replyTo
      );
    }

    saveHistory(
      userId,
      prompt,
      finalAnswer
    );

    pushMetric(
      stats.totalMs,
      Date.now()-started
    );

    const reaction=chooseReaction(
      prompt,
      Boolean(image),
      userId
    );

    const reactionMessageId=
      streamMessageId||
      draftFallbackMessageId;

    if(reactionMessageId){
      reactMessage(
        chatId,
        reactionMessageId,
        reaction
      ).catch(()=>{});
    }

    return finalAnswer;
  }catch(error){
    stats.errors++;

    console.error(
      `[generate] ${sanitizeLog(
        error instanceof Error
          ?error.message
          :error
      )}`
    );

    const errorText=
      `❌ *Something went wrong.*\n\n${esc(
        error instanceof Error
          ?error.message
          :"Unknown error"
      )}`;

    if(isPrivate){
      if(
        draftFallbackMessageId
      ){
        const result=
          await editMessageRich(
            chatId,
            draftFallbackMessageId,
            errorText
          ).catch(()=>({
            ok:false
          }));

        if(!result.ok){
          await sendRichMessage(
            chatId,
            errorText,
            replyTo
          );
        }
      }else{
        await sendRichMessage(
          chatId,
          errorText,
          replyTo
        );
      }
    }else if(streamMessageId){
      const result=
        await editMessageRich(
          chatId,
          streamMessageId,
          errorText
        ).catch(()=>({
          ok:false
        }));

      if(!result.ok){
        await sendRichMessage(
          chatId,
          errorText,
          replyTo
        );
      }
    }else{
      await sendRichMessage(
        chatId,
        errorText,
        replyTo
      );
    }

    return "";
  }finally{
    if(typingTimer){
      clearInterval(
        typingTimer
      );
    }
  }
}

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,ms));
}

function sanitizeLog(value){
  return String(value??"")
    .replace(/[\r\n]+/g," ")
    .slice(0,1000);
}

function esc(value){
  return String(value??"")
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g,"\\$1");
}

function escCode(value){
  return String(value??"")
    .replace(/([\\`])/g,"\\$1");
}

function detectRtl(value){
  const text=String(value||"");
  const rtl=(text.match(
    /[\u0590-\u08FF]/g
  )||[]).length;
  const ltr=(text.match(
    /[A-Za-z]/g
  )||[]).length;
  return rtl>ltr;
}

function splitRichText(input,limit=RICH_LIMIT){
  const result=[];
  let start=0;

  while(start<input.length){
    const maxEnd=Math.min(
      start+limit,
      input.length
    );

    if(maxEnd===input.length){
      result.push(
        input.slice(start).trim()
      );
      break;
    }

    const window=input.slice(
      start,
      maxEnd
    );

    const newline=window.lastIndexOf("\n\n");
    const newlineSingle=window.lastIndexOf("\n");

    const sentence=Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("؟ "),
      window.lastIndexOf("。")
    );

    const space=window.lastIndexOf(" ");

    let cut;

    if(newline>=Math.floor(limit*0.45)){
      cut=start+newline+2;
    }else if(newlineSingle>=Math.floor(limit*0.5)){
      cut=start+newlineSingle+1;
    }else if(sentence>=Math.floor(limit*0.55)){
      cut=start+sentence+2;
    }else if(space>=Math.floor(limit*0.55)){
      cut=start+space+1;
    }else{
      cut=maxEnd;
    }

    const part=input
      .slice(start,cut)
      .trim();

    if(part)result.push(part);

    start=cut;
  }

  return result;
}

function randomDraftId(){
  return Math.floor(
    Math.random()*2147483647
  );
}

function safeHeaderEqual(a,b){
  const x=Buffer.from(String(a||""));
  const y=Buffer.from(String(b||""));

  if(x.length!==y.length)return false;

  let diff=0;

  for(let i=0;i<x.length;i++){
    diff|=x[i]^y[i];
  }

  return diff===0;
}

function messageUserId(message){
  return(
    message?.from?.id||
    message?.sender_chat?.id||
    message?.chat?.id||
    0
  );
}

function messageChatId(message){
  return message?.chat?.id||0;
}

function extractMessageText(message){
  return(
    message?.text||
    message?.caption||
    ""
  );
}

function detectMode(userId){
  return getPref(userId,"mode")||"normal";
}

function isBotMentioned(text){
  if(!BOT_USERNAME)return false;
  return new RegExp(
    `(^|\\s)@${escapeRegExp(BOT_USERNAME)}\\b`,
    "i"
  ).test(String(text||""));
}

function escapeRegExp(value){
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function shouldHandleMessage(message){
  if(!message)return false;

  const text=extractMessageText(message);

  if(message.chat?.type==="private"){
    return Boolean(
      text||
      message.photo||
      message.document
    );
  }

  if(isBotMentioned(text))return true;

  if(
    message.reply_to_message&&
    botId&&
    message.reply_to_message.from?.id===botId
  ){
    return true;
  }

  if(TRIGGER&&text.trim().startsWith(TRIGGER)){
    return true;
  }

  return false;
}

function stripTrigger(text){
  let value=String(text||"").trim();

  if(BOT_USERNAME){
    value=value.replace(
      new RegExp(
        `^@${escapeRegExp(BOT_USERNAME)}\\b\\s*`,
        "i"
      ),
      ""
    );
  }

  if(TRIGGER){
    value=value.replace(
      new RegExp(
        `^${escapeRegExp(TRIGGER)}\\s*`,
        "i"
      ),
      ""
    );
  }

  if(BOT_USERNAME){
    value=value.replace(
      new RegExp(
        `@${escapeRegExp(BOT_USERNAME)}\\b`,
        "ig"
      ),
      ""
    );
  }

  return value.trim();
}

async function extractAttachment(message){
  if(message?.photo?.length){
    const photo=
      message.photo[
        message.photo.length-1
      ];

    const file=await telegramFile(
      photo.file_id
    );

    const mime=detectImageMime(
      file.buffer,
      file.path,
      file.httpMime
    );

    if(!mime){
      throw new Error(
        "Unsupported or invalid image."
      );
    }

    stats.images++;

    return{
      image:{
        mime,
        base64:file.base64
      },
      file:null,
      fileText:null
    };
  }

  if(message?.document){
    const doc=message.document;

    const file=await telegramFile(
      doc.file_id
    );

    const mime=detectFileMime(
      doc.file_name||"file",
      doc.mime_type,
      file.httpMime,
      file.buffer
    );

    if(!mime){
      throw new Error(
        "Unsupported file type."
      );
    }

    const fileText=
      decodeTextFile(
        file.buffer,
        doc.file_name||"file",
        mime
      );

    stats.files++;

    let part=null;

    if(!fileText){
      part=filePartFromDownload(
        file,
        doc.file_name||"file",
        doc.mime_type
      );
    }

    return{
      image:null,
      file:{
        name:doc.file_name||"file",
        part
      },
      fileText
    };
  }

  return{
    image:null,
    file:null,
    fileText:null
  };
}

function queueForUser(userId,fn){
  const key=String(userId);
  const previous=inFlightQueues.get(key)||Promise.resolve();

  const current=previous
    .catch(()=>{})
    .then(fn);

  inFlightQueues.set(
    key,
    current.finally(()=>{
      if(inFlightQueues.get(key)===current){
        inFlightQueues.delete(key);
      }
    })
  );

  return current;
}

function getUpdateKey(update){
  return String(
    update?.update_id||
    `${Date.now()}:${Math.random()}`
  );
}

async function handleMessage(message){
  if(!message)return;

  const chatId=messageChatId(message);
  const userId=messageUserId(message);
  const messageId=message.message_id;

  if(!chatId||!userId)return;
  if(!shouldHandleMessage(message))return;

  const text=extractMessageText(message);

  if(
    text.startsWith("/")&&
    await adminCommand(
      chatId,
      userId,
      text,
      messageId
    )
  ){
    return;
  }

  if(
    text.startsWith("/")&&
    await command(
      chatId,
      userId,
      text,
      messageId
    )
  ){
    return;
  }

  const prompt=stripTrigger(text);

  if(
    !prompt&&
    !message.photo&&
    !message.document
  ){
    await sendRichMessage(
      chatId,
      "💬 Send me a question or instruction.",
      messageId
    );
    return;
  }

  let attachments;

  try{
    attachments=await extractAttachment(
      message
    );
  }catch(error){
    await sendRichMessage(
      chatId,
      `❌ *Could not process the attachment.*\n\n${esc(
        error instanceof Error
          ?error.message
          :"Unknown error"
      )}`,
      messageId
    );
    return;
  }

  const mode=detectMode(userId);

  const isPrivate=
    message.chat?.type==="private";

  await queueForUser(
    userId,
    ()=>generate({
      chatId,
      userId,
      prompt,
      image:attachments.image,
      file:attachments.file,
      fileText:attachments.fileText,
      mode,
      replyTo:messageId,
      isPrivate
    })
  );
}

async function handleUpdate(update){
  if(!update)return;

  const key=getUpdateKey(update);

  if(seenUpdates.has(key))return;

  seenUpdates.set(
    key,
    Date.now()+SEEN_UPDATE_TTL_SEC*1000
  );

  if(update.message){
    await handleMessage(
      update.message
    );
    return;
  }

  if(update.edited_message){
    return;
  }
}

const app=express();

app.disable("x-powered-by");
app.use(express.json({limit:"2mb"}));

app.get("/",(req,res)=>{
  res.status(200).json({
    ok:true,
    service:"telegram-ai-bot"
  });
});

app.get("/health",(req,res)=>{
  res.status(200).json({
    ok:true,
    uptime:Math.floor(
      (Date.now()-stats.started)/1000
    ),
    requests:stats.requests,
    errors:stats.errors
  });
});

app.post(
  WEBHOOK_PATH,
  async(req,res)=>{
    const secretHeader=
      req.get(
        "X-Telegram-Bot-Api-Secret-Token"
      )||"";

    if(
      WEBHOOK_SECRET&&
      !safeHeaderEqual(
        secretHeader,
        WEBHOOK_SECRET
      )
    ){
      return res.status(403).send("Forbidden");
    }

    res.status(200).send("OK");

    Promise.resolve(
      handleUpdate(req.body)
    ).catch(error=>{
      stats.errors++;
      console.error(
        `[update] ${sanitizeLog(
          error instanceof Error
            ?error.message
            :error
        )}`
      );
    });
  }
);

app.get(
  "/set-webhook",
  async(req,res)=>{
    if(
      GUEST_SECRET&&
      !safeHeaderEqual(
        req.get("X-Guest-Secret")||"",
        GUEST_SECRET
      )
    ){
      return res.status(403).json({
        ok:false,
        error:"Forbidden"
      });
    }

    if(!BOT_TOKEN){
      return res.status(500).json({
        ok:false,
        error:"BOT_TOKEN missing"
      });
    }

    const baseUrl=
      String(
        process.env.PUBLIC_BASE_URL||
        process.env.RENDER_EXTERNAL_URL||
        ""
      ).replace(/\/$/,"");

    if(!baseUrl){
      return res.status(400).json({
        ok:false,
        error:"PUBLIC_BASE_URL or RENDER_EXTERNAL_URL missing"
      });
    }

    const webhookUrl=
      `${baseUrl}${WEBHOOK_PATH}`;

    const result=await tg(
      "setWebhook",
      {
        url:webhookUrl,
        secret_token:WEBHOOK_SECRET||undefined,
        allowed_updates:[
          "message"
        ]
      }
    );

    return res.status(
      result.ok?200:502
    ).json(result);
  }
);

app.get(
  "/delete-webhook",
  async(req,res)=>{
    if(
      GUEST_SECRET&&
      !safeHeaderEqual(
        req.get("X-Guest-Secret")||"",
        GUEST_SECRET
      )
    ){
      return res.status(403).json({
        ok:false,
        error:"Forbidden"
      });
    }

    const result=await tg(
      "deleteWebhook",
      {
        drop_pending_updates:false
      }
    );

    return res.status(
      result.ok?200:502
    ).json(result);
  }
);

app.get(
  "/telegram-info",
  async(req,res)=>{
    if(
      GUEST_SECRET&&
      !safeHeaderEqual(
        req.get("X-Guest-Secret")||"",
        GUEST_SECRET
      )
    ){
      return res.status(403).json({
        ok:false,
        error:"Forbidden"
      });
    }

    const result=await getMe();

    return res.status(
      result.ok?200:502
    ).json(result);
  }
);

const server=app.listen(
  PORT,
  async()=>{
    console.log(
      `Server listening on ${PORT}`
    );

    await getMe().catch(
      ()=>{}
    );

    fetchModelCatalog(
      false
    ).catch(
      ()=>{}
    );
  }
);

server.on(
  "error",
  error=>{
    console.error(
      `HTTP server error: ${sanitizeLog(
        error?.message||
        error
      )}`
    );
  }
);

process.on(
  "unhandledRejection",
  reason=>{
    console.error(
      `[unhandledRejection] ${sanitizeLog(
        reason?.message||
        reason
      )}`
    );
  }
);

process.on(
  "uncaughtException",
  error=>{
    console.error(
      `[uncaughtException] ${sanitizeLog(
        error?.message||
        error
      )}`
    );
  }
);
