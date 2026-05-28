# BlueFlag Security — Threat Dashboard

A local Node.js dashboard that scrapes your BlueFlag Security tenant portals daily, surfaces deltas (new/resolved threats), and generates AI-drafted client emails — all from a single browser tab.

![BlueFlag Security](public/logo.svg)

---

## What it does

- **Daily scrape** — runs headlessly via Playwright at a configurable time, hits each tenant portal, and snapshots the current threat posture
- **Delta detection** — compares today's snapshot to yesterday's and highlights what's new, what's resolved, and what's trending
- **Monitor Score** — a calculated priority metric (severity × recency × volume) to cut through noise
- **AI email drafts** — one click generates a client-ready summary email via the Claude API
- **Export** — copy a report to clipboard as Markdown (Notion/GitHub) or Plain Text (Slack/Outlook)
- **Scheduled runs** — cron-based automation, configurable run time

---

## Requirements

- macOS (setup script is macOS-only; the app itself runs anywhere Node ≥ 18 runs)
- A BlueFlag Security account with portal access for each tenant you want to monitor
- An [Anthropic API key](https://console.anthropic.com) for AI email drafts (optional — the rest works without it)

---

## Quick start

```bash
git clone https://github.com/Oldandcranky/blueflag-threat-dashboard.git
cd blueflag-threat-dashboard
./setup.sh
```

`setup.sh` handles everything on first run:

1. Installs Homebrew (if missing)
2. Installs Node.js ≥ 18 via Homebrew (if missing or outdated)
3. Runs `npm install`
4. Downloads the Playwright Chromium browser (~130 MB, one-time)
5. Creates `config.json` from the template
6. Launches the server and opens `http://localhost:3737`

After the first run, start it with:

```bash
node server.js
```

---

## Configuration

Open **Settings** in the app (bottom left) to configure:

| Field | Description |
|---|---|
| Claude API Key | Anthropic key for AI email drafts |
| Intel URL | Optional threat intel feed URL |
| Default Username / Password | Shared portal credentials (overridden per-tenant) |
| Run Time | Daily scrape time, e.g. `07:00` |
| Stale Days | How many days before a snapshot is considered stale |

Per-tenant credentials can be set individually in Settings and override the defaults.

`config.json` is excluded from git and the distribution zip — your credentials stay local.

---

## Project layout

```
├── server.js          # Express server, cron scheduler, Claude API proxy
├── run.js             # Playwright scraper — runs headlessly, writes snapshots
├── public/
│   ├── index.html     # Entire frontend (single-file, vanilla JS/CSS)
│   └── logo.svg       # BlueFlag Security logo
├── config.example.json  # Credentials template — copy to config.json
├── setup.sh           # First-run installer (macOS)
└── make-zip.sh        # Creates a clean distributable zip
```

---

## Distributing to teammates

```bash
./make-zip.sh
```

Creates `blueflag-threat-dashboard.zip` with no credentials, no node_modules, no scraped data. Share it — the recipient unzips and runs `./setup.sh`.

---

## Notes

- **Monitor Score** is a calculated metric local to this tool — it is not a score from the BlueFlag platform itself.
- Scraped data (`snapshots/`, `intel.json`, `notes.json`) stays on your machine and is excluded from git and the zip.
- The scraper uses a headless Chromium browser to log into each portal — keep portal credentials in `config.json` only.
