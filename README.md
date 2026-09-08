# YUMBI Support Operations dashboard

A live support dashboard for the YUMBI Customer Support team, hosted from a
GitHub repo. Your API tokens are stored as **GitHub Actions secrets** (encrypted),
a **scheduled workflow** pulls the stats server-side, and the page shows the
result. No tokens ever touch the browser.

## How it works

```
API tokens (GitHub Actions secrets)          <- your "section to store tokens"
        |
scheduled workflow (.github/workflows/refresh.yml, runs on GitHub's servers)
        |  runs scripts/fetch-stats.js -> calls Euphoria / Zoho / Intercom
        v
data.json  (aggregate numbers only, committed to the repo)
        |
index.html reads data.json  ->  the dashboard you see
```

The browser only ever downloads `index.html` + `data.json`. Tokens stay in the
secrets store, used only on the runner.

## Files

- `index.html` — the dashboard (reads `data.json`).
- `data.json` — the published figures. Ships with **sample data** so the board
  renders immediately; the workflow overwrites it with real numbers.
- `.github/workflows/refresh.yml` — scheduled job (every 10 min + manual run).
- `scripts/fetch-stats.js` — pulls and aggregates the stats.

## Setup

### 1. Create a **private** repository and push these files.

### 2. Add your tokens as Actions secrets
Repo **Settings > Secrets and variables > Actions > New repository secret**.
This is the secure home for the tokens — encrypted, never in the page:

- `EUPHORIA_API_BASE`, `EUPHORIA_API_TOKEN`
- `ZOHO_DC` (e.g. `com`, `eu`, `in`, `com.au`), `ZOHO_ORG_ID`,
  `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`
- `INTERCOM_TOKEN`

### 3. Wire the real endpoints
`scripts/fetch-stats.js` has the auth, ranges, aggregation and output already
done. Each provider function has a clearly marked `TODO` where its real endpoint
and response fields go (with doc links inline). The Zoho OAuth refresh exchange
is already complete. Until a provider is wired it returns blanks and notes why on
the board — nothing is faked.

### 4. Run it
Actions tab > "Refresh dashboard data" > **Run workflow**. The schedule is set
to **hourly** by default.

> **Free plan note:** a private repo on GitHub Free includes **2,000 Actions
> minutes/month**. Hourly (~730 runs) fits comfortably; a business-hours
> alternative is included (commented) in `refresh.yml`. Public repos get
> unlimited minutes, but a public repo would expose `data.json` and the code —
> so keep the repo **private** and stay on the hourly-ish cadence.

### 5. Publish it — **privately** (GitHub Free)

On GitHub Free, Pages can't be made private (that needs an organization on
GitHub Enterprise Cloud). So keep the repo **private** and put a login in front
using **Cloudflare Pages + Cloudflare Access** — both have a free tier:

1. Sign up at Cloudflare and go to **Workers & Pages > Create > Pages >
   Connect to Git**, and pick this private repo. Build command: *none*;
   output directory: `/`. Deploy — you get a `*.pages.dev` URL.
2. In **Cloudflare Zero Trust > Access > Applications**, add a self-hosted
   application over that URL, with a policy that allows only your YUMBI email
   address(es) (or YUMBI SSO). Save.
3. Now anyone visiting the URL must log in first. The GitHub workflow keeps
   refreshing `data.json`, and each push redeploys the Cloudflare site
   automatically.

(Netlify or Vercel with password/SSO protection achieve the same thing.)

## Privacy / safety notes
- `data.json` contains **aggregate numbers only** — no customer or agent
  personal details, in line with YUMBI's data-handling rules.
- Tokens exist only as Actions secrets. They are never written to `data.json`,
  never committed, and never sent to the browser.
- Custom arbitrary date ranges aren't offered here: a static site has no live
  backend to query, so the workflow pre-computes the preset ranges instead.
