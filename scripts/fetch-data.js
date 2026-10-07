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
// Bot vs agent is split by LiveChat TAG (tag names only, never agent names or
// emails). Set the variable LIVECHAT_AGENT_TAGS to the tag(s) that mark chats a
// person handled. Those count as "Handled by agent"; everything else as "Handled by bot".
// Returns { "YYYY-MM-DD": { total, bot, agent, bot_good, bot_bad, agent_good, agent_bad } }
async function liveChatDaily(from, to, errors) {
  const acc = env("LIVECHAT_ACCOUNT_ID"), tok = env("LIVECHAT_TOKEN");
  if (!acc || !tok) throw new SourceError("LiveChat: keys not set up yet");
  const auth = "Basic " + Buffer.from(acc + ":" + tok).toString("base64");
  const headers = { Authorization: auth, "Content-Type": "application/json" };

  // 30-day blocks, one report at a time, so a single failure only blanks its own figure
  const chunks = [];
  for (let start = from; start <= to; start = addDays(start, 30)) {
    const end = addDays(start, 29) < to ? addDays(start, 29) : to;
    chunks.push([start, end]);
  }
  async function report(action, extra, label, onlyFrom) {
    const merged = {};
    for (const [s0, e0] of chunks) {
      if (onlyFrom && e0 < onlyFrom) continue;
      let res;
      try {
        res = await fetch("https://api.livechatinc.com/v3.6/reports/chats/" + action, {
          method: "POST", headers,
          body: JSON.stringify({ distribution: "day", timezone: TZ,
            filters: Object.assign({ from: s0 + "T00:00:00" + TZ_OFFSET, to: e0 + "T23:59:59" + TZ_OFFSET }, extra || {}) })
        });
      } catch (e) { errors.push("LiveChat " + label + ": could not connect"); return null; }
      if (!res.ok) {
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

  // Helper for setup: print every LiveChat group with its chat count (last 30 days)
  // to the GitHub Actions log, so you can see which group your agents work in.
  try {
    const recent = addDays(to, -29);
    const perDay = await report("groups", null, "group list", recent) || {};
    const counts = {};
    for (const [d, g] of Object.entries(perDay)) if (d >= recent) for (const [id, n] of Object.entries(g || {})) counts[id] = (counts[id] || 0) + (Number(n) || 0);
    let names = {};
    try {
      const res = await fetch("https://api.livechatinc.com/v3.6/configuration/action/list_groups",
        { method: "POST", headers, body: "{}" });
      if (res.ok) for (const g of (await res.json()) || []) names[g.id] = g.name;
    } catch (e) {}
    console.log("LiveChat groups, chats in the last 30 days:");
    for (const [id, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) {
      console.log("  Group " + id + (names[id] ? " (" + names[id] + ")" : "") + ": " + n + " chats");
    }
  } catch (e) {}

  // Same helper for tags: tag names and chat counts only (last 30 days)
  try {
    const res = await fetch("https://api.livechatinc.com/v3.6/reports/tags/chat_usage", {
      method: "POST", headers,
      body: JSON.stringify({ timezone: TZ, filters: { from: addDays(to, -29) + "T00:00:00" + TZ_OFFSET, to: to + "T23:59:59" + TZ_OFFSET } })
    });
    if (res.ok) {
      const j = await res.json();
      console.log("LiveChat tags, chats in the last 30 days:");
      const list = Object.entries((j && j.records) || {}).sort((x, y) => y[1] - x[1]);
      if (!list.length) console.log("  (no tagged chats)");
      for (const [tag, n] of list) console.log("  " + tag + ": " + n + " chats");
    } else console.log("LiveChat tags: could not list (responded " + res.status + ")");
  } catch (e) {}

  const groupIds = (env("LIVECHAT_AGENT_GROUP_IDS", "") || "").split(",").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n));
  const agentTags = (env("LIVECHAT_AGENT_TAGS", "chatbot-transfer") || "").split(",").map(x => x.trim()).filter(Boolean);
  // A chat counts as "handled by agent" if it carries one of the agent tags
  // (or, as a fallback, sits in one of the agent groups)
  const agentFilter = agentTags.length ? { tags: { values: agentTags } }
                    : groupIds.length ? { groups: { values: groupIds } } : null;
  if (!agentFilter) errors.push("LiveChat: bot and agent figures need the LIVECHAT_AGENT_TAGS setting (see the tag list in the GitHub Actions log)");

  const all          = await report("total_chats", null, "total chats");
  const allRatings   = await report("ratings", null, "ratings");
  const agentChats   = agentFilter ? await report("total_chats", agentFilter, "agent chats") : null;
  const agentRatings = agentFilter ? await report("ratings", agentFilter, "agent ratings") : null;

  if (!all && !allRatings) throw new SourceError(errors.pop() || "LiveChat: no data returned");

  const day = (rec, d, key) => rec ? (Number(rec[d] && rec[d][key]) || 0) : null;
  const minus = (x, y) => (x === null || y === null) ? null : Math.max(0, x - y);
  const out = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const agent = day(agentChats, d, "total");
    const aGood = day(agentRatings, d, "good"), aBad = day(agentRatings, d, "bad");
    out[d] = {
      total: day(all, d, "total"),
      agent: agent,
      bot: minus(day(all, d, "total"), agent),
      agent_good: aGood,
      agent_bad: aBad,
      bot_good: minus(day(allRatings, d, "good"), aGood),
      bot_bad: minus(day(allRatings, d, "bad"), aBad),
      all_good: day(allRatings, d, "good"),
      all_bad: day(allRatings, d, "bad")
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
