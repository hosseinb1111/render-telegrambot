// ============================================================================
// keepalive.js — pings your own /health endpoint on an interval so free-tier
// hosts (Render, Railway, Glitch, etc.) don't spin the instance down after
// a period of inactivity.
//
// Usage: import and call startKeepAlive() once from your main file (index.js),
// AFTER your PUBLIC_URL env var is set to your deployed base URL, e.g.
// https://my-bot.onrender.com
//
//   import { startKeepAlive } from "./keepalive.js";
//   startKeepAlive();
//
// Or just run it as its own tiny process:
//   node keepalive.js
// ============================================================================

const PUBLIC_URL = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const PING_PATH = process.env.KEEPALIVE_PATH || "/health";
const INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 4 * 60 * 1000); // every 4 min

function log(msg) {
  console.log(`[keepalive] ${new Date().toISOString()} ${msg}`);
}

async function ping() {
  if (!PUBLIC_URL) {
    log("PUBLIC_URL is not set — skipping ping (set it to your deployed URL).");
    return;
  }
  const url = `${PUBLIC_URL}${PING_PATH}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    log(`pinged ${url} -> ${res.status}`);
  } catch (err) {
    log(`ping failed: ${err instanceof Error ? err.message : err}`);
  }
}

export function startKeepAlive() {
  log(`starting, interval=${INTERVAL_MS}ms target=${PUBLIC_URL || "(unset)"}${PING_PATH}`);
  ping();
  const timer = setInterval(ping, INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// If this file is executed directly (node keepalive.js) rather than imported,
// start immediately.
if (import.meta.url === `file://${process.argv[1]}`) {
  startKeepAlive();
}
