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

/* ---------- date ranges (South African time) ---------- */
function todayInTZ() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function buildRanges() {
  const t = todayInTZ();
  return {
    today:     { from: t, to: t, label: "today" },
    yesterday: { from: addDays(t, -1), to: addDays(t, -1), label: "yesterday" },
    last7:     { from: addDays(t, -6), to: t, label: "last 7 days" },
    last30:    { from: addDays(t, -29), to: t, label: "last 30 days" },
    month:     { from: t.slice(0, 8) + "01", to: t, label: "this month" }
  };
}

/* ---------- LiveChat (Reports API v3.6) ---------- */
async function liveChat(r) {
  const acc = env("LIVECHAT_ACCOUNT_ID"), tok = env("LIVECHAT_TOKEN");
  if (!acc || !tok) throw new SourceError("LiveChat: keys not set up yet");
  const auth = "Basic " + Buffer.from(acc + ":" + tok).toString("base64");
  const base = "https://api.livechatinc.com/v3.6/reports/chats/";
  const filters = { from: r.from + "T00:00:00" + TZ_OFFSET, to: r.to + "T23:59:59" + TZ_OFFSET };

  const report = (action, extra) => call(base + action, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ distribution: "day", filters: Object.assign({}, filters, extra || {}) })
  }, "LiveChat");
  const sum = (json, key) => Object.values((json && json.records) || {}).reduce((a, d) => a + (Number(d && d[key]) || 0), 0);

  const [all, handled, ratings] = await Promise.all([
    report("total_chats"),
    report("total_chats", { agents: { exists: true } }), // chats an agent took part in
    report("ratings")
  ]);
  // LiveChat ratings are thumbs up / down. Converted to a 0-5 score: (good / rated) x 5
  const good = sum(ratings, "good"), bad = sum(ratings, "bad");
  return {
    received: sum(all, "total"),
    handled: sum(handled, "total"),
    csat: (good + bad) > 0 ? Math.round(good / (good + bad) * 500) / 100 : null
  };
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
async function euphoria(r) {
  // Euphoria's call-list API returns caller phone numbers, so it is NOT used here.
  // Waiting on Euphoria to confirm an API call that returns totals only
  // (calls received / answered / abandoned and agents logged on).
  throw new SourceError("Euphoria: waiting on a totals-only API call from Euphoria");
}

/* ---------- run ---------- */
async function attempt(fn, keys) {
  try { return { data: await fn(), err: null }; }
  catch (e) {
    const blank = Object.fromEntries(keys.map(k => [k, null]));
    return { data: blank, err: e instanceof SourceError ? e.message : "Unexpected error while pulling data" };
  }
}

(async () => {
  const ranges = buildRanges();
  const asOf = new Date().toISOString();

  const zoho = await attempt(zohoSnapshot, ["open", "config", "thirdparty"]);
  const zohoPending = "Zoho: unassigned, handled and response/resolution times are the next step to add";

  const out = { generated_at: asOf, ranges: {} };
  for (const [key, r] of Object.entries(ranges)) {
    const [chat, eu] = await Promise.all([
      attempt(() => liveChat(r), ["received", "handled", "csat"]),
      attempt(() => euphoria(r), ["received", "answered", "abandoned", "agents"])
    ]);
    out.ranges[key] = Object.assign({}, r, {
      euphoria: eu.data,
      chat: chat.data,
      zoho: Object.assign({ unassigned: null, handled_total: null, avg_first_response: null, avg_resolution: null }, zoho.data),
      as_of: asOf,
      errors: [eu.err, chat.err, zoho.err, zohoPending].filter(Boolean)
    });
  }

  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.log("data.json written for " + Object.keys(out.ranges).length + " date ranges");
})();
