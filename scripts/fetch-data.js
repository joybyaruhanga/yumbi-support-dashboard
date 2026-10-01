// YUMBI Support Operations dashboard - data pull
// Runs inside GitHub Actions on a schedule. Writes data.json for the page to read.
//
// PRIVACY RULE: this script only ever asks for COUNTS and AVERAGES.
// It never requests ticket, chat or call lists, so no customer or agent
// names, emails, phone numbers or message content are imported or saved.
// Error messages are kept short and never include API responses or keys.

const fs = require("fs");

const TZ = "Africa/Johannesburg";
const TZ_OFFSET = "+02:00";
const env = (k, d = null) => (process.env[k] && process.env[k].trim()) || d;

class SourceError extends Error {}

async function call(url, opts, source) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new SourceError(source + ": could not connect"); }
  if (!res.ok) throw new SourceError(source + ": responded " + res.status);
  return res.json();
}

const num = v => (v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);

/* ---------- dates (South African time) ---------- */
function todayInTZ() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const HISTORY_DAYS = Math.max(1, Math.min(365, Number(env("HISTORY_DAYS", "90")) || 90));

/* ---------- LiveChat (Reports API v3.6), one figure per day ---------- */
// Returns { "YYYY-MM-DD": { total, bot, agent, bot_good, bot_bad, agent_good, agent_bad } }
async function liveChatDaily(from, to, errors) {
  const acc = env("LIVECHAT_ACCOUNT_ID"), tok = env("LIVECHAT_TOKEN");
  if (!acc || !tok) throw new SourceError("LiveChat: keys not set up yet");
  const auth = "Basic " + Buffer.from(acc + ":" + tok).toString("base64");
  const headers = { Authorization: auth, "Content-Type": "application/json" };

  // Which LiveChat agents are bots? Only bot IDs are kept, never names or emails.
  let botIds = (env("LIVECHAT_BOT_IDS", "") || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!botIds.length) {
    try {
      const bots = await call("https://api.livechatinc.com/v3.6/configuration/action/list_bots",
        { method: "POST", headers, body: JSON.stringify({ all: true }) }, "LiveChat bots");
      botIds = (Array.isArray(bots) ? bots : []).map(b => b && b.id).filter(Boolean);
    } catch (e) {
      errors.push("LiveChat: could not look up the chatbot (" + (e.message || "error") + "). Bot figures need the token's 'bots' read access, or a LIVECHAT_BOT_IDS variable.");
    }
    if (!botIds.length && !errors.some(x => x.includes("chatbot"))) errors.push("LiveChat: no chatbot found on the account, so bot figures are blank");
  }

  // Ask LiveChat one report at a time, in 30-day blocks, so a single failure
  // only blanks the figure it affects instead of the whole card.
  const chunks = [];
  for (let start = from; start <= to; start = addDays(start, 30)) {
    const end = addDays(start, 29) < to ? addDays(start, 29) : to;
    chunks.push([start, end]);
  }
  async function report(action, extra, label) {
    const merged = {};
    for (const [s0, e0] of chunks) {
      let res;
      try {
        res = await fetch("https://api.livechatinc.com/v3.6/reports/chats/" + action, {
          method: "POST", headers,
          body: JSON.stringify({ distribution: "day",
            filters: Object.assign({ from: s0 + "T00:00:00" + TZ_OFFSET, to: e0 + "T23:59:59" + TZ_OFFSET }, extra || {}) })
        });
      } catch (e) { errors.push("LiveChat " + label + ": could not connect"); return null; }
      if (!res.ok) {
        // LiveChat's error type and message only (never the request or the token)
        let why = "";
        try { const j = await res.json(); const er = (j && j.error) || {}; why = [er.type, er.message].filter(Boolean).join(" - ").slice(0, 160); } catch (e) {}
        errors.push("LiveChat " + label + ": responded " + res.status + (why ? " (" + why + ")" : ""));
        return null;
      }
      const j = await res.json();
      Object.assign(merged, (j && j.records) || {});
    }
    return merged;
  }

  const hasBot = botIds.length > 0;
  const botFilter = { agents: { values: botIds } };
  const all        = await report("total_chats", null, "total chats");
  const withAgent  = await report("total_chats", { agents: { exists: true } }, "chats with an agent");
  const withBot    = hasBot ? await report("total_chats", botFilter, "bot chats") : null;
  const allRatings = await report("ratings", null, "ratings");
  const botRatings = hasBot ? await report("ratings", botFilter, "bot ratings") : null;

  if (!all && !withAgent && !allRatings) throw new SourceError(errors.pop() || "LiveChat: no data returned");

  const day = (rec, d, key) => rec ? (Number(rec[d] && rec[d][key]) || 0) : null;
  const minus = (x, y) => (x === null ? null : Math.max(0, x - (y || 0)));
  const out = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const bot = day(withBot, d, "total");
    const botGood = day(botRatings, d, "good"), botBad = day(botRatings, d, "bad");
    out[d] = {
      total: day(all, d, "total"),
      bot: bot,
      // a person with no bot involved (chats the bot passed to a person count under bot)
      agent: (hasBot && bot === null) ? null : minus(day(withAgent, d, "total"), bot),
      bot_good: botGood,
      bot_bad: botBad,
      // ratings on chats without the bot = all ratings minus bot-chat ratings
      agent_good: (hasBot && botGood === null) ? null : minus(day(allRatings, d, "good"), botGood),
      agent_bad:  (hasBot && botBad === null)  ? null : minus(day(allRatings, d, "bad"), botBad)
    };
  }
  return out;
}

/* ---------- Zoho Desk (current backlog snapshot) ---------- */
async function zohoSnapshot() {
  const id = env("ZOHO_CLIENT_ID"), secret = env("ZOHO_CLIENT_SECRET"),
        refresh = env("ZOHO_REFRESH_TOKEN"), org = env("ZOHO_ORG_ID");
  if (!id || !secret || !refresh || !org) throw new SourceError("Zoho: keys not set up yet");
  const dc = env("ZOHO_DC", "com"); // the end of your Zoho address, e.g. com or eu

  const login = await call("https://accounts.zoho." + dc + "/oauth/v2/token?" + new URLSearchParams({
    refresh_token: refresh, client_id: id, client_secret: secret, grant_type: "refresh_token"
  }), { method: "POST" }, "Zoho login");
  if (!login.access_token) throw new SourceError("Zoho login: no access granted - check the refresh token and ZOHO_DC");

  const params = new URLSearchParams({ field: "statusType,status" });
  if (env("ZOHO_DEPARTMENT_ID")) params.set("departmentId", env("ZOHO_DEPARTMENT_ID"));
  const counts = await call("https://desk.zoho." + dc + "/api/v1/ticketsCountByFieldValues?" + params, {
    headers: { Authorization: "Zoho-oauthtoken " + login.access_token, orgId: org }
  }, "Zoho");

  const countOf = (field, name) => {
    const list = Array.isArray(counts[field]) ? counts[field] : [];
    const hit = list.find(x => String(x.value || "").toLowerCase() === name.toLowerCase());
    return hit ? num(hit.count) : 0;
  };
  return {
    open: countOf("statusType", "Open"),
    config: countOf("status", env("ZOHO_STATUS_CONFIG", "Waiting on Config")),
    thirdparty: countOf("status", env("ZOHO_STATUS_THIRDPARTY", "Waiting on Third Party"))
  };
}

/* ---------- Euphoria ---------- */
// Euphoria's call-list API returns caller phone numbers, so it is NOT used here.
// Waiting on Euphoria to confirm an API call that returns totals only.
const EUPHORIA_NOTE = "Euphoria: waiting on a totals-only API call from Euphoria";

/* ---------- run ---------- */
const safe = e => (e instanceof SourceError ? e.message : "Unexpected error while pulling data");

(async () => {
  const to = todayInTZ(), from = addDays(to, -(HISTORY_DAYS - 1));
  const out = {
    generated_at: new Date().toISOString(),
    history: { from, to },
    daily: {},
    zoho: {},
    errors: { euphoria: [EUPHORIA_NOTE], chat: [], zoho: [] }
  };

  try {
    const chat = await liveChatDaily(from, to, out.errors.chat);
    for (const [d, c] of Object.entries(chat)) out.daily[d] = { chat: c };
  } catch (e) { out.errors.chat.push(safe(e)); }

  try { out.zoho = await zohoSnapshot(); }
  catch (e) { out.errors.zoho.push(safe(e)); }
  out.errors.zoho.push("Zoho: unassigned, handled and response/resolution times are the next step to add");

  fs.writeFileSync("data.json", JSON.stringify(out));
  console.log("data.json written: " + Object.keys(out.daily).length + " days of chat figures");
})();
