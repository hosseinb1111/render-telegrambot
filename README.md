# Telegram AI Bot — Render deployment

## What changed from your original file

The bot logic itself (OpenRouter streaming, Telegram Rich Messages,
LangSearch tool-calling loop, group/private streaming fallbacks) was
already sound — `sendRichMessage`, `sendRichMessageDraft`, the
`rich_message` param on `editMessageText`, and `<tg-thinking>` are all
real, current Telegram Bot API 10.1–10.3 methods, and
`minimax/minimax-m2.7:free` is a valid OpenRouter model ID. I didn't
touch that part.

I did add three things that were missing and matter once this is
running on a public URL instead of on your own machine:

1. **Webhook authentication.** `/webhook` had no way to check that a
   request actually came from Telegram. Anyone who found the URL
   could POST a fake `Update` and make the bot burn your OpenRouter
   (and LangSearch) credits, or edit/delete messages in chats you
   control. Telegram supports a `secret_token` on `setWebhook` for
   exactly this — the code now checks it via the
   `X-Telegram-Bot-Api-Secret-Token` header. Controlled by the new
   `WEBHOOK_SECRET` env var.
2. **`/guest` endpoint was wide open.** It triggers a billed
   OpenRouter call for anyone who POSTs to it, with zero auth. It's
   now disabled by default and only responds if you set
   `GUEST_API_SECRET` and the caller sends a matching
   `X-Guest-Secret` header.
3. **Small robustness fixes:** a body-size limit on
   `express.json()`, and a guard in `handleGuestMode` so a guest
   message missing `chat_id` fails fast with a log line instead of
   silently trying to message `undefined`.

Everything else is your original code, byte-for-byte.

## 1. Get your bot token

1. Open Telegram, message **@BotFather**, send `/newbot` (or reuse an
   existing bot) and copy the token it gives you.

## 2. Get an OpenRouter API key

1. Sign up at https://openrouter.ai → **Keys** → create a key.
2. `minimax/minimax-m2.7:free` (the default model) is free but rate
   limited; keep the key even if you don't expect to be billed.

## 3. (Optional) Get a LangSearch key

Only needed if you want the bot's `web_search` tool to actually work.
Sign up at https://langsearch.com and grab an API key. Without it,
the bot still runs — it just tells the model web search failed
whenever it tries to use it.

## 4. Push the code to GitHub

Render deploys from a git repo.

```bash
cd telegram-ai-bot
git init
git add .
git commit -m "Telegram AI bot"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

(Add a `.gitignore` with `node_modules` and `.env` if you don't
already have one.)

## 5. Create the Render web service

1. In the Render dashboard: **New → Web Service**.
2. Connect the GitHub repo you just pushed.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start (see the caveat below).
4. Under **Environment**, add the variables from `.env.example`:
   at minimum `BOT_TOKEN`, `OPENROUTER_API_KEY`, and a `WEBHOOK_SECRET`
   you make up yourself (any long random string works — e.g. generate
   one with `openssl rand -hex 24`).
5. Click **Create Web Service** and wait for the first deploy to go
   live. Note the URL Render gives you, e.g.
   `https://your-app.onrender.com`.

## 6. Point Telegram at your Render URL

Telegram needs to know where to send updates, and it needs the same
secret you set in `WEBHOOK_SECRET` so your server can verify requests.
Run this once (replace the placeholders):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
        "url": "https://your-app.onrender.com/webhook",
        "secret_token": "<WEBHOOK_SECRET>"
      }'
```

You should get back `{"ok":true,"result":true,...}`. Verify it any
time with:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## 7. Test it

- Message your bot privately — it should reply.
- Send `/start` and `/help`.
- Add it to a group, then either @mention it, use your
  `TRIGGER_COMMAND` (default `!ai`), or reply to one of its messages.
- Send a photo with a caption to test vision (only works if your
  chosen OpenRouter model supports images).

## Things worth knowing before you rely on this

- **Free Render instances spin down after ~15 minutes idle** and take
  30–60s to wake back up. Telegram will retry a failed webhook
  delivery, but the first message after idle time may feel slow or
  briefly fail. If that matters, move to a paid instance type or add
  an external uptime pinger.
- **Chat history and dedup state live in memory** (`SimpleKV`), so
  every deploy or restart wipes them. That's fine for a single small
  bot; if you want history to survive restarts, swap `SimpleKV` for a
  Redis-backed store (e.g. `ioredis` against a Render Redis instance
  or Upstash) — the `.get()`/`.put()` interface is already isolated
  in one class, so it's a small change.
- **Free OpenRouter models are rate-limited** and occasionally
  overloaded; if replies start failing, check the Render logs first
  (`console.error` lines print the OpenRouter status/body).
- **Only set `GUEST_API_SECRET` if you actually built a separate
  frontend that posts to `/guest`.** Leave it unset otherwise so the
  endpoint stays disabled.
