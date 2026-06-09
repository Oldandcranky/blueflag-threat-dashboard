#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const REPORTS_DIR   = path.join(__dirname, 'reports');
const DEBUG_DIR     = path.join(__dirname, 'debug');
const CONFIG_FILE   = path.join(__dirname, 'config.json');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const siteFilter = args.find(a => a.startsWith('--site='))?.split('=')[1];
const forceAll   = args.includes('--refresh');
const debugMode  = args.includes('--debug');

// node run.js --encode "mypassword"  →  prints base64, then exits
if (args.includes('--encode')) {
  const val = args[args.indexOf('--encode') + 1];
  if (!val) { console.error('Usage: node run.js --encode "value"'); process.exit(1); }
  console.log(Buffer.from(val).toString('base64'));
  process.exit(0);
}

// ── Config ────────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

function getCreds(tenant) {
  const u = tenant.username ?? config.defaultUsername;
  const p = tenant.password ?? config.defaultPassword;
  return {
    username: Buffer.from(u, 'base64').toString(),
    password: Buffer.from(p, 'base64').toString(),
  };
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
function loadSnapshot(id) {
  const file = path.join(SNAPSHOTS_DIR, `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function saveSnapshot(id, data) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  // Always overwrite the latest snapshot (used by the dashboard)
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  // Also save a dated copy so we keep the full history of every run
  const date    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const histDir = path.join(SNAPSHOTS_DIR, 'history', id);
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, `${date}.json`), JSON.stringify(data, null, 2));
}

// ── Parse ─────────────────────────────────────────────────────────────────────
// NOTE: If parsing looks wrong, run with --debug and inspect debug/{id}.txt
// to see the raw innerText and tune regexes below.

function parseBehaviors(text) {
  const behaviors = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\d+) detections? found across (\d+) days?/i.exec(lines[i]);
    if (!m) continue;

    const slice = lines.slice(i + 1, i + 8);
    const flat  = slice.join(' ');

    const dateM  = /(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(flat);
    const reposM = /(\d+) unique repositor/i.exec(flat);
    // Username: short alphanumeric token, not a date, not "repository", not UI labels
    const user = slice.find(l =>
      l.length > 1 && l.length < 60 &&
      /^[\w\-\.@]+$/.test(l) &&
      !/\d{4}-\d{2}-\d{2}/.test(l) &&
      !/repositor|sort by|beta|detection/i.test(l)
    ) ?? null;

    behaviors.push({
      detections: parseInt(m[1]),
      days:       parseInt(m[2]),
      dateStart:  dateM?.[1]  ?? null,
      dateEnd:    dateM?.[2]  ?? null,
      user,
      repos:      reposM ? parseInt(reposM[1]) : null,
    });
  }
  return behaviors;
}

function parseRisk(text) {
  const risk = {};
  for (const section of ['Identities Risk', 'Assets Risk', 'Teams Risk']) {
    const idx = text.indexOf(section);
    if (idx === -1) { risk[section] = null; continue; }

    const chunk = text.slice(idx, idx + 500);
    const counts = {};
    for (const level of ['Critical', 'High', 'Medium', 'Low', 'None']) {
      const mm = new RegExp(`${level}[\\s\\n]+(\\d+)`).exec(chunk);
      counts[level.toLowerCase()] = mm ? parseInt(mm[1]) : 0;
    }
    const totalM = /Total[\s\n]+(\d+)/.exec(chunk);
    counts.total = totalM ? parseInt(totalM[1]) : null;
    risk[section] = counts;
  }
  return risk;
}

function parseDashboard(text) {
  return {
    behaviors: parseBehaviors(text),
    risk:      parseRisk(text),
    scrapedAt: new Date().toISOString(),
  };
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrape(tenant) {
  const { username, password } = getCreds(tenant);
  const browser = await chromium.launch({
    headless: !debugMode,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',   // required in Docker — /dev/shm is limited
      '--disable-gpu',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0)/1000).toFixed(1)}s`;

  // Spoof a real Chrome UA — CloudFront blocks Playwright's default HeadlessChrome string
  await page.context().setExtraHTTPHeaders({});
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    console.log(`  → [${elapsed()}] Navigating to ${tenant.url}`);
    await page.goto(tenant.url, { waitUntil: 'networkidle', timeout: 45000 });
    console.log(`  → [${elapsed()}] Landed on: ${page.url()}`);
    console.log(`  → [${elapsed()}] Page title: "${await page.title()}"`);

    // Keycloak login — try multiple selector variants
    const userSel = '#username, input[name="username"], input[autocomplete="username"]';
    const passSel = '#password, input[name="password"], input[type="password"]';
    console.log(`  → [${elapsed()}] Waiting for login form...`);
    await page.waitForSelector(userSel, { timeout: 20000 });

    const foundUser = await page.$('#username') ? '#username'
                    : await page.$('input[name="username"]') ? 'input[name="username"]'
                    : 'input[autocomplete="username"]';
    console.log(`  → [${elapsed()}] Login form ready (matched: ${foundUser})`);

    await page.fill(userSel, username);
    await page.fill(passSel, password);
    console.log(`  → [${elapsed()}] Credentials filled, submitting...`);
    await page.click('input[type="submit"], button[type="submit"]');

    // Wait for redirect back to tenant domain
    const host = new URL(tenant.url).hostname;
    console.log(`  → [${elapsed()}] Waiting for redirect to ${host}...`);
    await page.waitForURL(url => new URL(url).hostname === host, { timeout: 25000 });
    console.log(`  → [${elapsed()}] Redirected to: ${page.url()}`);
    await page.waitForLoadState('networkidle', { timeout: 45000 });
    console.log(`  → [${elapsed()}] Page idle. Cookies: ${(await page.context().cookies()).length}`);

    // Ensure we're on Health Overview (root path)
    const currentPath = new URL(page.url()).pathname;
    if (currentPath !== '/' && !currentPath.startsWith('/health')) {
      const targetUrl = tenant.url.replace(/\/$/, '') + '/';
      console.log(`  → [${elapsed()}] Navigating to Health Overview: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 });
      console.log(`  → [${elapsed()}] Now at: ${page.url()}`);
    }

    console.log(`  → [${elapsed()}] Waiting for "Top Risky Behaviors" to appear...`);
    await page.waitForSelector('text=Top Risky Behaviors', { timeout: 30000 });
    console.log(`  → [${elapsed()}] Dashboard content visible`);

    // Extract text from main content area
    const text = await page.evaluate(() => {
      const el = document.querySelector('main') ??
                 document.querySelector('[class*="dashboard"]') ??
                 document.querySelector('[class*="overview"]') ??
                 document.querySelector('#root') ??
                 document.body;
      return el.innerText;
    });

    console.log(`  → [${elapsed()}] Extracted ${text.length} chars from page`);
    const preview = text.slice(0, 120).replace(/\n/g, ' ').trim();
    console.log(`  → [${elapsed()}] Preview: "${preview}..."`);

    if (debugMode) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${tenant.id}.txt`), text);
      console.log(`  → [${elapsed()}] Full text saved: debug/${tenant.id}.txt`);
    }

    const result = parseDashboard(text);
    console.log(`  → [${elapsed()}] Parsed: ${result.behaviors.length} behaviors, risk sections: ${Object.values(result.risk).filter(Boolean).length}/3`);

    // Scrape Policy Builder for actor-level intelligence
    result.policies = await scrapePolicies(page, tenant, elapsed);

    // Collect actor names from behaviors + policies for identity lookup
    const actorNames = [...new Set([
      ...(result.behaviors||[]).map(b=>b.user).filter(Boolean),
      ...(result.policies||[]).flatMap(p=>(p.actors||[]).map(a=>a.user)).filter(Boolean),
    ])].slice(0, 5);

    if (actorNames.length) {
      result.identities = await scrapeIdentities(page, tenant, actorNames, elapsed);
    }

    // Scrape AI Agents tab
    result.aiAgents = await scrapeAiAgents(page, tenant, elapsed);

    return result;

  } catch (err) {
    console.log(`  → [${elapsed()}] ERROR: ${err.message.split('\n')[0]}`);
    console.log(`  → [${elapsed()}] Current URL at failure: ${page.url()}`);
    // Screenshot on failure
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const shot = path.join(DEBUG_DIR, `${tenant.id}-error.png`);
      await page.screenshot({ path: shot, fullPage: false });
      console.log(`  → [${elapsed()}] Screenshot saved: debug/${tenant.id}-error.png`);
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}


// ── Policy Builder Scraper ────────────────────────────────────────────────────
// Navigates to /policies, filters Risky Behavior, clicks each critical/high
// policy with detections, and extracts the evidence table per actor.
async function scrapePolicies(page, tenant, elapsed) {
  const url = tenant.url.replace(/\/$/, '') + '/policies';
  try {
    console.log(`  → [${elapsed()}] [policies] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    console.log(`  → [${elapsed()}] [policies] Title: "${await page.title()}"`);

    // Click Risky Behavior tab — use page.evaluate to bypass Playwright visibility checks
    const tabClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], span, div'));
      const rb  = all.find(el => el.textContent?.trim().startsWith('Risky Behavior'));
      if (rb) { rb.click(); return true; }
      return false;
    });
    if (tabClicked) {
      console.log(`  → [${elapsed()}] [policies] Clicked Risky Behavior tab — waiting for content`);
    } else {
      console.log(`  → [${elapsed()}] [policies] Risky Behavior tab not found — proceeding with all policies`);
    }

    // Wait for page text to grow substantially — rows are lazy-rendered
    // The nav+header alone is ~2000 chars; full row list should be 5000+
    try {
      await page.waitForFunction(() => document.body.innerText.length > 4500, { timeout: 15000 });
      console.log(`  → [${elapsed()}] [policies] Page content loaded (text > 4500 chars)`);
    } catch(e) {
      console.log(`  → [${elapsed()}] [policies] Content growth timeout — trying scroll to trigger lazy render`);
      // Scroll down to force virtual list / lazy rows to render
      await page.evaluate(() => {
        window.scrollTo(0, 600);
        // Also try scrolling the main content container if it exists
        const main = document.querySelector('main, [class*="content"], [class*="main"], [class*="scroll"]');
        if (main) main.scrollTop = 600;
      });
      await page.waitForTimeout(3000);
      console.log(`  → [${elapsed()}] [policies] After scroll: text length = ${await page.evaluate(() => document.body.innerText.length)}`);
    }

    // Always take a screenshot to the debug folder — critical for diagnosing render issues
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const policyShot = path.join(DEBUG_DIR, `${tenant.id}-policies.png`);
    await page.screenshot({ path: policyShot, fullPage: false });
    console.log(`  → [${elapsed()}] [policies] Screenshot: debug/${tenant.id}-policies.png`);

    // Dump raw page text
    const pageText = await page.evaluate(() => document.body.innerText);
    if (debugMode) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${tenant.id}-policies.txt`), pageText);
      console.log(`  → [${elapsed()}] [policies] Raw text saved: debug/${tenant.id}-policies.txt`);
    }
    console.log(`  → [${elapsed()}] [policies] Page text length: ${pageText.length} chars`);

    // Log all anchor hrefs for diagnosis
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => ({ text: a.innerText.trim().slice(0,60), href: a.href }))
        .filter(l => l.text && l.href)
        .slice(0, 20)
    );
    console.log(`  → [${elapsed()}] [policies] All links on page (first 20):`);
    allLinks.forEach(l => console.log(`  → [${elapsed()}] [policies]   ${l.href} | "${l.text}"`));

    // Also try DOM extraction — look for any anchor elements with sibling detection counts
    const policyLinks = await page.evaluate(() => {
      const results = [];
      // Try table rows first
      const rows = Array.from(document.querySelectorAll('tr'));
      for (const row of rows) {
        const link = row.querySelector('a');
        if (!link) continue;
        const rowText = row.innerText || '';
        if (!rowText.trim()) continue;

        // Detection count: look for a cell that is purely numeric and > 0
        const cells = Array.from(row.querySelectorAll('td'));
        let count = 0;
        for (const cell of cells) {
          const n = parseInt(cell.innerText.trim());
          if (!isNaN(n) && n > 0 && n < 100000) { count = n; break; }
        }
        // Fallback: first standalone number in row text
        if (!count) {
          const nums = rowText.match(/(\d+)/g) || [];
          count = nums.map(Number).find(n => n > 0 && n < 100000) || 0;
        }
        if (!count) continue;

        // Severity: check for any element with color/class indicating crit or high
        // BlueFlag uses shield icons — look for any child element with relevant class or aria
        const rowHtml = row.innerHTML.toLowerCase();
        const isCrit = rowHtml.includes('"critical"') || rowHtml.includes("'critical'")
                    || rowHtml.includes('critical"') || rowHtml.includes('severity-critical')
                    || rowHtml.includes('risk-critical') || rowHtml.includes('color-critical')
                    || rowHtml.includes('text-red') || rowHtml.includes('badge-critical')
                    || rowHtml.match(/aria[^>]*critical/);
        const isHigh = rowHtml.includes('"high"') || rowHtml.includes("'high'")
                    || rowHtml.includes('high"') || rowHtml.includes('severity-high')
                    || rowHtml.includes('risk-high') || rowHtml.includes('color-high')
                    || rowHtml.includes('text-orange') || rowHtml.includes('badge-high')
                    || rowHtml.match(/aria[^>]*high/);

        // If severity detection fails, accept all policies with detections (user can filter later)
        results.push({
          name:       link.innerText.trim(),
          href:       link.href,
          detections: count,
          severity:   isCrit ? 'critical' : isHigh ? 'high' : 'medium',
        });
      }

      // Deduplicate by name
      const seen = new Set();
      return results.filter(r => r.name && r.href && !seen.has(r.name) && seen.add(r.name));
    });

    // Log a sample of what we found for debugging
    console.log(`  → [${elapsed()}] [policies] DOM found ${policyLinks.length} policies with detections`);
    if (policyLinks.length > 0) {
      policyLinks.slice(0,3).forEach(p => console.log(`  → [${elapsed()}] [policies]   • "${p.name}" — ${p.detections} detections [${p.severity}]`));
    } else {
      // Fallback: log a text snippet to help diagnose
      const snippet = pageText.slice(0, 400).replace(/\n/g, ' | ');
      console.log(`  → [${elapsed()}] [policies] No rows found. Page preview: "${snippet}"`);
    }

    console.log(`  → [${elapsed()}] [policies] Found ${policyLinks.length} critical/high policies with detections`);

    const policies = [];
    for (const pl of policyLinks.slice(0, 12)) {
      console.log(`  → [${elapsed()}] [policies] Extracting: ${pl.name} (${pl.detections} detections, ${pl.severity})`);
      try {
        await page.goto(pl.href, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        await page.waitForSelector('table', { timeout: 8000 }).catch(() => {});

        const tableData = await page.evaluate(() => {
          const table = document.querySelector('table');
          if (!table) return null;
          const headers = Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim().toUpperCase());
          if (!headers.length) return null;
          const rows = Array.from(table.querySelectorAll('tbody tr')).map(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
            const obj = {};
            headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
            return obj;
          }).filter(r => Object.values(r).some(v => v));
          return { headers, rows };
        });

        const actors = (tableData?.rows || []).map(row => {
          const actor = {
            user:         row['USER LOGIN']    || row['USER']     || row['IDENTITY'] || '',
            identityType: row['IDENTITY TYPE'] || 'user',
            date:         row['DATE OF DETECTION'] || row['DATE'] || '',
          };
          // Clone spike columns
          const spike = row['PERCENTAGE SPIKE IN NEW REPO CLONED'];
          if (spike !== undefined) {
            actor.spikePercent  = parseInt(spike) || 0;
            actor.baselineCount = parseInt(row['BASELINE COUNT OF REPOS CLONED']) || 0;
            actor.newCount      = parseInt(row['NEW REPOS CLONES COUNT'])          || 0;
          }
          if (row['REPOSITORY']) actor.repository = row['REPOSITORY'];
          if (row['PR NUMBER'])  actor.prNumber   = row['PR NUMBER'];
          // Store raw for debugging
          actor.raw = row;
          return actor;
        }).filter(a => a.user);

        console.log(`  → [${elapsed()}] [policies] ${pl.name}: ${actors.length} actor(s) — ${actors.map(a=>a.user).join(', ') || 'none'}`);
        policies.push({ name: pl.name, severity: pl.severity, detections: pl.detections, actors });

      } catch(e) {
        console.log(`  → [${elapsed()}] [policies] Error on "${pl.name}": ${e.message.split('\n')[0]}`);
        policies.push({ name: pl.name, severity: pl.severity, detections: pl.detections, actors: [], error: e.message.split('\n')[0] });
      }
    }

    console.log(`  → [${elapsed()}] [policies] Done — ${policies.length} policies scraped`);
    return policies;

  } catch(e) {
    console.log(`  → [${elapsed()}] [policies] Scraping failed: ${e.message.split('\n')[0]}`);
    return [];
  }
}



// ── Intel fetch (Gary's daily HackMD via #daily-bfs-news URL pattern) ─────────
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function absolutizeUrl(url, base) {
  if (!url) return '';
  try { return new URL(url, base).toString(); } catch { return url; }
}

function extractFirstUrl(text, base) {
  const src = String(text || '');
  const md = src.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i);
  if (md) return absolutizeUrl(md[1], base);
  const html = src.match(/href=["']([^"']+)["']/i);
  if (html) return absolutizeUrl(html[1], base);
  const raw = src.match(/https?:\/\/[^\s)\]"'<>]+/i);
  if (raw) return absolutizeUrl(raw[0], base);
  return '';
}

function cleanMarkdownTitle(title) {
  return decodeHtmlEntities(String(title || ''))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/#+\s*/g, '')
    .trim();
}

async function fetchIntel(config) {
  const dataDir = fs.existsSync(path.join(__dirname, 'data'))
    ? path.join(__dirname, 'data') : __dirname;
  const intelPath = path.join(dataDir, 'intel.json');

  // Use manually-set URL from config if provided
  let hackmdUrl = config.intelUrl || null;

  // Otherwise try to find today's note by fetching Gary's known profile
  if (!hackmdUrl) {
    try {
      const today = new Date().toISOString().slice(0,10);
      const profileResp = await fetch('https://hackmd.io/@RXMnYn6_RsWDZqGLAVHs5A', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
      });
      const html = await profileResp.text();
      const datePattern = today.replace(/-/g, '-');
      const linkMatch = html.match(new RegExp(`href="/@RXMnYn6_RsWDZqGLAVHs5A/([^"]+)"[^>]*>[^<]*${datePattern}|${datePattern}[^<]*<[^>]*href="/@RXMnYn6_RsWDZqGLAVHs5A/([^"]+)"`));
      if (linkMatch) {
        const noteId = linkMatch[1] || linkMatch[2];
        hackmdUrl = `https://hackmd.io/@RXMnYn6_RsWDZqGLAVHs5A/${noteId}`;
        console.log(`  [intel] Found today's note: ${hackmdUrl}`);
      }
    } catch(e) {
      console.log(`  [intel] Profile fetch failed: ${e.message.split('\n')[0]}`);
    }
  }

  if (!hackmdUrl) {
    console.log(`  [intel] No intel URL found — skipping`);
    return;
  }

  try {
    console.log(`  [intel] Fetching: ${hackmdUrl}`);

    // Prefer HackMD's markdown download endpoint because it preserves article links.
    let text = '';
    let usedDownload = false;
    try {
      const dl = await fetch(hackmdUrl.replace(/\/$/, '') + '/download', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      if (dl.ok) {
        text = await dl.text();
        usedDownload = true;
        console.log(`  [intel] Parsed markdown download with links`);
      }
    } catch {}

    // Fallback to rendered HTML, but preserve hrefs by converting anchors to "text (url)" before stripping tags.
    if (!text) {
      const r = await fetch(hackmdUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      const html = await r.text();
      const withLinks = html.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
        const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
        return `${cleanLabel} (${absolutizeUrl(href, hackmdUrl)})`;
      });
      const mdMatch = withLinks.match(/<div[^>]*id="doc"[^>]*>([\s\S]*?)<\/div>/);
      text = mdMatch ? mdMatch[1].replace(/<[^>]+>/g,'') : withLinks.replace(/<[^>]+>/g,'');
      text = decodeHtmlEntities(text);
      console.log(`  [intel] Parsed rendered HTML fallback`);
    }

    text = decodeHtmlEntities(text);

    // Parse stories by score. Preserve a URL for every story, falling back to the HackMD note URL.
    const stories = [];
    const urgentMatches = text.matchAll(/###\s*\d+\.\s*(.+?)\n([\s\S]*?)(?=###|##\s+[🔵📋💡🏢]|$)/g);
    for (const m of urgentMatches) {
      const rawTitle = m[1].trim();
      const body  = m[2].trim();
      const why   = body.match(/\*Why it matters[^:]*:\*([^\n]+)/)?.[1]?.trim()
                 || body.match(/Why it matters[^:]*:\s*([^\n]+)/i)?.[1]?.trim()
                 || '';
      const score = text.includes('URGENT') && text.indexOf(rawTitle) < text.indexOf('TOP STORIES') ? 5
                  : text.includes('TOP STORIES') && text.indexOf(rawTitle) < text.indexOf('BACKGROUND') ? 4 : 3;
      const title = cleanMarkdownTitle(rawTitle);
      const url = extractFirstUrl(rawTitle + '\n' + body, hackmdUrl) || hackmdUrl;
      if (title && title.length > 5) stories.push({ title, why: cleanMarkdownTitle(why), score, url, hackmdUrl });
    }

    const intel = { fetchedAt: new Date().toISOString(), url: hackmdUrl, stories };
    fs.writeFileSync(intelPath, JSON.stringify(intel, null, 2));
    console.log(`  [intel] Saved ${stories.length} stories to intel.json`);
    const linked = stories.filter(s => s.url && s.url !== hackmdUrl).length;
    console.log(`  [intel] Story links captured: ${linked}/${stories.length}`);
  } catch(e) {
    console.log(`  [intel] Fetch failed: ${e.message.split('\n')[0]}`);
  }
}


// ── Identity Scraper (API-backed) ────────────────────────────────────────────
// Uses the same internal API calls the BlueFlag UI makes instead of brittle
// Material UI filter clicking. Discovered from DevTools Network:
//   /api/users?items_page=10&page=1&sort_by=-overprivilege_score&user=<login>
//   /api/users/<login>?source=GitHub
//   /api/users/insights/<login>?source=GitHub
async function scrapeIdentities(page, tenant, actors, elapsed) {
  if (!actors.length) return {};

  const apiBase = 'https://api.blueflagsecurity.com';
  const url = tenant.url.replace(/\/$/, '') + '/identities';
  const results = {};
  let bearer = null;

  const severityName = (v) => {
    const s = String(v ?? '').toLowerCase();
    if (s === '5' || s.includes('critical')) return 'Critical';
    if (s === '4' || s.includes('high')) return 'High';
    if (s === '3' || s.includes('medium')) return 'Medium';
    if (s === '2' || s.includes('low')) return 'Low';
    return null;
  };

  const fmtTime = (ms) => {
    if (!ms) return null;
    try {
      return new Date(ms).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch { return null; }
  };

  const tokenCount = (details) => Array.isArray(details?.tokens) ? details.tokens.length : null;

  // Capture the Authorization header from the real app as it loads /identities.
  const onReq = req => {
    const h = req.headers();
    if (!bearer && h.authorization && /Bearer\s+/i.test(h.authorization)) {
      bearer = h.authorization;
    }
  };
  page.on('request', onReq);

  try {
    console.log(`  → [${elapsed()}] [identities] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    console.log(`  → [${elapsed()}] [identities] Page loaded: "${await page.title()}"`);

    // Fallback: find JWT in browser storage if request capture missed it.
    if (!bearer) {
      const jwt = await page.evaluate(() => {
        const jwtRe = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
        const seen = new Set();
        function scan(v, depth = 0) {
          if (v == null || depth > 5) return null;
          if (typeof v === 'string') {
            const m = v.match(jwtRe);
            if (m) return m[0];
            try { return scan(JSON.parse(v), depth + 1); } catch { return null; }
          }
          if (typeof v === 'object') {
            if (seen.has(v)) return null;
            seen.add(v);
            for (const k of Object.keys(v)) {
              if (/access.?token|id.?token|token/i.test(k)) {
                const r = scan(v[k], depth + 1);
                if (r) return r;
              }
            }
            for (const k of Object.keys(v)) {
              const r = scan(v[k], depth + 1);
              if (r) return r;
            }
          }
          return null;
        }
        const vals = [];
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i++) vals.push(store.getItem(store.key(i)));
        }
        for (const v of vals) {
          const r = scan(v);
          if (r) return r;
        }
        return null;
      }).catch(() => null);
      if (jwt) bearer = `Bearer ${jwt}`;
    }

    if (!bearer) {
      console.log(`  → [${elapsed()}] [identities] No bearer token captured — cannot call API`);
      return {};
    }
    console.log(`  → [${elapsed()}] [identities] Captured API bearer token`);

    async function apiGet(path) {
      const full = `${apiBase}${path}`;
      const out = await page.evaluate(async ({ full, bearer }) => {
        const r = await fetch(full, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': bearer
          }
        });
        const text = await r.text();
        return { status: r.status, ok: r.ok, text };
      }, { full, bearer });

      if (!out.ok) throw new Error(`API ${out.status} for ${path}: ${out.text.slice(0,120)}`);
      try { return JSON.parse(out.text); }
      catch { throw new Error(`API returned non-JSON for ${path}`); }
    }

    for (const actor of actors.slice(0, 5)) {
      console.log(`  → [${elapsed()}] [identities] API lookup: ${actor}`);
      try {
        const searchTerms = [...new Set([
          actor,
          String(actor).split('_')[0],
          String(actor).split('_')[0].replace(/-/g, ' '),
          String(actor).split('_')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        ].filter(Boolean))];

        let lookup = null;
        let row = null;
        let usedSearch = null;
        for (const term of searchTerms) {
          const lookupPath = `/api/users?items_page=10&page=1&sort_by=-overprivilege_score&user=${encodeURIComponent(term)}`;
          lookup = await apiGet(lookupPath);
          row = lookup?.data?.find(u => u.login === actor) || lookup?.data?.[0];
          console.log(`  → [${elapsed()}] [identities] User API search "${term}" returned ${lookup?.total ?? lookup?.data?.length ?? 0}`);
          if (row) { usedSearch = term; break; }
        }

        if (!row) {
          console.log(`  → [${elapsed()}] [identities] API found no identity row for ${actor}`);
          continue;
        }

        const login = row.login || actor;
        console.log(`  → [${elapsed()}] [identities] Found ${login} (${row.display_name || 'no display name'}) via search "${usedSearch}"`);

        let details = {};
        let insights = {};
        let violations = {};
        const src = row.source || row.scm_source || 'GitHub';

        try {
          details = await apiGet(`/api/users/${encodeURIComponent(login)}?source=${encodeURIComponent(src)}`);
          console.log(`  → [${elapsed()}] [identities] Details API OK for ${login}`);
        } catch (e) {
          console.log(`  → [${elapsed()}] [identities] Details API warning for ${login}: ${e.message.split('\n')[0]}`);
        }

        try {
          insights = await apiGet(`/api/users/insights/${encodeURIComponent(login)}?source=${encodeURIComponent(src)}`);
          console.log(`  → [${elapsed()}] [identities] Insights API OK for ${login}`);
        } catch (e) {
          console.log(`  → [${elapsed()}] [identities] Insights API warning for ${login}: ${e.message.split('\n')[0]}`);
        }

        try {
          violations = await apiGet(`/api/users/violations/${encodeURIComponent(login)}?page=1&items_page=10`);
          console.log(`  → [${elapsed()}] [identities] Violations API OK for ${login}`);
        } catch (e) {
          console.log(`  → [${elapsed()}] [identities] Violations API warning for ${login}: ${e.message.split('\n')[0]}`);
        }

        const riskReasons = [];
        const addReason = (policyName, severity, count, tags=[]) => {
          if (!policyName) return;
          const existing = riskReasons.find(r => r.policyName === policyName && r.severity === severity);
          if (existing) {
            existing.violationsCount = Math.max(existing.violationsCount || 0, Number(count || 0));
            return;
          }
          riskReasons.push({ policyName, severity, violationsCount: Number(count || 0), tags });
        };

        // Preferred endpoint from DevTools: /api/users/violations/<login>
        const vf = violations?.data?.findings || {};
        for (const [sevCode, arr] of Object.entries(vf)) {
          const sev = severityName(sevCode) || sevCode;
          for (const r of (Array.isArray(arr) ? arr : [])) addReason(r.name, sev, r.count);
        }

        // Backup source: /api/users/insights/<login>
        const ri = insights?.data?.risk_insights || {};
        for (const [bucket, arr] of Object.entries(ri)) {
          const sev = bucket.toLowerCase().includes('critical') ? 'Critical'
                    : bucket.toLowerCase().includes('high')     ? 'High'
                    : bucket.toLowerCase().includes('medium')   ? 'Medium'
                    : bucket.toLowerCase().includes('low')      ? 'Low'
                    : '';
          for (const r of (Array.isArray(arr) ? arr : [])) addReason(r.name, sev, r.count, r.tags || []);
        }

        riskReasons.sort((a,b) => {
          const rank = { Critical: 4, High: 3, Medium: 2, Low: 1 };
          return (rank[b.severity]||0) - (rank[a.severity]||0) || (b.violationsCount||0) - (a.violationsCount||0);
        });

        const alerts = [];
        for (const group of (insights?.data?.alerts_count_insights || [])) {
          for (const [k, vals] of Object.entries(group)) {
            alerts.push({ type: k, values: vals });
          }
        }

        const activity = insights?.data?.activity_insights || {};
        const access = insights?.data?.access_insights || {};
        const copilot = insights?.data?.copilot_insights || {};

        const stats = {
          login,
          displayName: row.display_name || details.display_name || login,
          riskRating: severityName(row.highest_severity),
          overPrivScore: row.overprivilege_score ?? details?.overprivilege_score?.overprivilege_score ?? null,
          lastEvent: fmtTime(row.last_activity || details.last_activity),
          lastEventRaw: row.last_activity || details.last_activity || null,
          tokens: tokenCount(details),
          repos: row.repos_count ?? details.repos_count ?? null,
          adminPermissions: row.count_admin_permissions ?? null,
          admins: row.count_admin_permissions ?? null,
          identityStatus: row.status_active === true ? 'Active' : row.status_active === false ? 'Inactive' : null,
          accountType: row.account_type || null,
          source: src,
          riskReasons,
          alerts,
          activityInsights: activity,
          accessInsights: access,
          copilotInsights: copilot,
          topActiveRepos: activity['Top active repos '] || [],
          numberOfClones: activity['Number of clones '] ?? null,
          numberOfCommits: activity['Number of commits '] ?? null,
          geoActivity: activity['Activity from geo location '] || [],
          detectionStrings: row.detection_strings || [],
          detectionTypes: row.detection_types || []
        };

        console.log(`  → [${elapsed()}] [identities] Stats for ${actor}: risk=${stats.riskRating}, score=${stats.overPrivScore}, last=${stats.lastEvent}, tokens=${stats.tokens}, policies=${riskReasons.length}`);
        if (riskReasons.length) {
          const top = riskReasons.slice(0,5).map(r => `${r.policyName} (${r.violationsCount})`).join('; ');
          console.log(`  → [${elapsed()}] [identities] Top risk reasons: ${top}`);
        }
        if (stats.numberOfClones || stats.topActiveRepos?.length) {
          console.log(`  → [${elapsed()}] [identities] Activity: clones=${stats.numberOfClones ?? 'n/a'}, top repos=${(stats.topActiveRepos||[]).slice(0,3).join(', ') || 'n/a'}`);
        }
        if (access['Number of admin permissions ']?.length) {
          console.log(`  → [${elapsed()}] [identities] Access: ${access['Number of admin permissions '].join(' / ')}`);
        }

        // Entity graph — Playwright screenshot of BlueFlag's graph UI for Critical/High identities
        if (['Critical','High'].includes(stats.riskRating)) {
          try {
            const identitiesUrl = tenant.url.replace(/\/$/, '') + '/identities';
            // Ensure we're on the identities page before looking for the graph button
            const currentUrl = page.url();
            if (!currentUrl.includes('/identities') || currentUrl.includes('/entity-graph')) {
              await page.goto(identitiesUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(2000);
            }

            // Find the row for this identity and click its entity graph button.
            // The button is inside the row that contains the login name.
            const clicked = await page.evaluate((loginName) => {
              // Look for a row/cell containing the login text, then find a graph/network button nearby
              const allText = document.querySelectorAll('td, [class*="row"] [class*="cell"], [class*="tableRow"] span, [class*="identity"] span, [class*="name"]');
              for (const el of allText) {
                if (el.textContent.trim().toLowerCase() === loginName.toLowerCase()) {
                  // Walk up to find the row, then find a button that looks like a graph icon
                  let row = el;
                  for (let i = 0; i < 6; i++) {
                    row = row.parentElement;
                    if (!row) break;
                    const btn = row.querySelector('button[title*="graph" i], button[title*="network" i], button[aria-label*="graph" i], button[aria-label*="entity" i], button[title*="blast" i]');
                    if (btn) { btn.click(); return true; }
                  }
                }
              }
              return false;
            }, login);

            if (clicked) {
              // Wait for the entity-graph page SVG to render
              await page.waitForURL(/entity-graph/, { timeout: 15000 }).catch(() => {});
              await page.waitForSelector('svg circle, svg [class*="node"]', { timeout: 20000 }).catch(() => {});
              await page.waitForTimeout(2000);

              // Screenshot the graph container
              const graphEl = await page.$('svg[class*="graph"], [class*="graph-container"] svg, [class*="entityGraph"] svg, main svg, .content svg, svg').catch(() => null);
              if (graphEl) {
                const buf = await graphEl.screenshot({ type: 'png' });
                stats.entityGraphScreenshot = 'data:image/png;base64,' + buf.toString('base64');
                console.log(`  → [${elapsed()}] [identities] Entity graph screenshot captured for ${login} (${buf.length} bytes)`);
              } else {
                // Fallback: screenshot the whole viewport
                const buf = await page.screenshot({ type: 'png', fullPage: false });
                stats.entityGraphScreenshot = 'data:image/png;base64,' + buf.toString('base64');
                console.log(`  → [${elapsed()}] [identities] Entity graph viewport screenshot for ${login}`);
              }

              // Navigate back to identities so subsequent API calls still work
              await page.goto(identitiesUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(2000);
            } else {
              console.log(`  → [${elapsed()}] [identities] Entity graph button not found for ${login} — skipping screenshot`);
            }
          } catch(e) {
            console.log(`  → [${elapsed()}] [identities] Entity graph screenshot warning for ${login}: ${e.message.split('\n')[0]}`);
            // Attempt to recover by returning to identities page
            try {
              await page.goto(tenant.url.replace(/\/$/, '') + '/identities', { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(2000);
            } catch { /* ignore recovery errors */ }
          }
        }

        results[actor] = stats;

      } catch(e) {
        console.log(`  → [${elapsed()}] [identities] API error for ${actor}: ${e.message.split('\n')[0]}`);
      }
    }

    console.log(`  → [${elapsed()}] [identities] Done — ${Object.keys(results).length} identities scraped`);
    return results;

  } catch(e) {
    console.log(`  → [${elapsed()}] [identities] Scraping failed: ${e.message.split('\n')[0]}`);
    return results;
  } finally {
    page.off('request', onReq);
  }
}

// ── AI Agents Scraper ─────────────────────────────────────────────────────────
// Navigates to /{tenant}/ai-agents, extracts the agent table. Each row has:
//   name, type, totalActivity, agentPrimaryCommits, humanPrimaryCommits,
//   prsOpened, prsApproved, prsCommented, lastActive
async function scrapeAiAgents(page, tenant, elapsed) {
  const url = tenant.url.replace(/\/$/, '') + '/ai-agents';
  const agents = [];
  try {
    console.log(`  → [${elapsed()}] [ai-agents] Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    console.log(`  → [${elapsed()}] [ai-agents] Page loaded: "${await page.title()}"`);

    // Try to extract table rows from the page DOM
    const rows = await page.evaluate(() => {
      const results = [];
      // Look for table rows — BlueFlag uses Material UI DataGrid or standard tables
      const tables = document.querySelectorAll('table, [role="grid"], [role="rowgroup"]');
      for (const table of tables) {
        const rowEls = table.querySelectorAll('tr, [role="row"]');
        for (const row of rowEls) {
          const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')];
          if (cells.length < 3) continue;
          const texts = cells.map(c => (c.textContent || '').trim().replace(/\s+/g,' '));
          // Skip header-like rows (all text cells that look like column labels)
          if (texts[0] && !texts[0].match(/^[\d\-]/)) {
            results.push(texts);
          }
        }
      }
      return results;
    });

    // Parse each row into a structured agent object
    // Expected column order from the screenshot:
    // Actual column order (8 cols — Commits is ONE merged cell with both values as text):
    //   0: Name | 1: Type | 2: Total Activity | 3: Commits (merged "NAgent Primary•MHuman Primary") |
    //   4: PRs Opened | 5: PRs Approved | 6: PRs Commented | 7: Last Active
    for (const cells of rows) {
      if (!cells[0] || cells[0].length < 2) continue;
      const parseNum = (s) => {
        if (!s) return 0;
        const n = parseInt(String(s).replace(/[^0-9,]/g, '').replace(/,/g,''), 10);
        return isNaN(n) ? 0 : n;
      };
      // The Commits cell contains both agent and human primary values as inline text
      // e.g. "6Agent Primary" or "0Agent Primary•5,250Human Primary"
      const commitsCell = cells[3] || '';
      const agentM = /(\d[\d,]*)\s*Agent\s*Primary/i.exec(commitsCell);
      const humanM = /(\d[\d,]*)\s*Human\s*Primary/i.exec(commitsCell);
      agents.push({
        name:                 cells[0] || '',
        type:                 cells[1] || 'App',
        totalActivity:        parseNum(cells[2]),
        agentPrimaryCommits:  agentM ? parseInt(agentM[1].replace(/,/g,''), 10) : 0,
        humanPrimaryCommits:  humanM ? parseInt(humanM[1].replace(/,/g,''), 10) : 0,
        prsOpened:            parseNum(cells[4]),
        prsApproved:          parseNum(cells[5]),
        prsCommented:         parseNum(cells[6]),
        lastActive:           cells[7] || '—',
      });
    }

    // Fallback: try intercepting the API response if DOM scraping returned nothing.
    // BlueFlag often renders tables via its internal API.
    if (!agents.length) {
      console.log(`  → [${elapsed()}] [ai-agents] DOM scrape returned 0 rows — trying page text extraction`);
      const bodyText = await page.evaluate(() => document.body.innerText);
      // Look for rows that start with known agent names (Claude, Cursor, Copilot, Lovable, Vercel…)
      const knownAgents = ['claude','cursor','copilot','lovable','vercel','codeium','tabnine','github-copilot','github copilot'];
      const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const lower = line.toLowerCase();
        if (knownAgents.some(a => lower.startsWith(a))) {
          const parts = line.split(/\s{2,}|\t/);
          if (parts.length >= 2) {
            const parseNum = (s) => { const n = parseInt(String(s).replace(/[^0-9]/g,''),10); return isNaN(n)?0:n; };
            agents.push({
              name:                parts[0]||'',
              type:                parts[1]||'App',
              totalActivity:       parseNum(parts[2]),
              agentPrimaryCommits: parseNum(parts[3]),
              humanPrimaryCommits: parseNum(parts[4]),
              prsOpened:           parseNum(parts[5]),
              prsApproved:         parseNum(parts[6]),
              prsCommented:        parseNum(parts[7]),
              lastActive:          parts[8]||'—',
            });
          }
        }
      }
    }

    console.log(`  → [${elapsed()}] [ai-agents] Found ${agents.length} agent${agents.length===1?'':'s'}`);
    if (agents.length) {
      agents.slice(0,5).forEach(a => console.log(`  → [${elapsed()}] [ai-agents]   ${a.name} (${a.type}) — activity=${a.totalActivity}, agentCommits=${a.agentPrimaryCommits}`));
    }
    return agents;

  } catch(e) {
    console.log(`  → [${elapsed()}] [ai-agents] Scraping failed: ${e.message.split('\n')[0]}`);
    return agents;
  }
}


// ── Delta ─────────────────────────────────────────────────────────────────────
// ── Detailed Delta (stored in snapshot for UI) ────────────────────────────────
function computeDeltaDetailed(current, prev) {
  const today = new Date().toISOString().slice(0, 10);
  const activeToday = (current.behaviors||[]).some(b => b.dateEnd === today);

  if (!prev) return { firstRun: true, activeToday };

  const currMap = new Map((current.behaviors||[]).filter(b=>b.user).map(b=>[b.user,b]));
  const prevMap = new Map((prev.behaviors||[]).filter(b=>b.user).map(b=>[b.user,b]));

  const newActors      = [...currMap.keys()].filter(u => !prevMap.has(u));
  const resolvedActors = [...prevMap.keys()].filter(u => !currMap.has(u));

  const detectionChanges = {};
  for (const [user, curr] of currMap) {
    const p    = prevMap.get(user);
    const diff = curr.detections - (p?.detections || 0);
    if (diff > 0) detectionChanges[user] = { prev: p?.detections || 0, curr: curr.detections, diff };
  }

  const prevPolicyNames = new Set((prev.policies||[]).map(p=>p.name));
  const newPolicies = (current.policies||[]).filter(p=>!prevPolicyNames.has(p.name)).map(p=>p.name);

  return { firstRun: false, newActors, resolvedActors, detectionChanges, activeToday, newPolicies, prevScrapedAt: prev.scrapedAt };
}


function computeDelta(current, prev) {
  if (!prev) return { firstRun: true, changes: [] };
  const changes = [];

  // New actors not seen in previous run
  const prevUsers = new Set((prev.behaviors || []).map(b => b.user).filter(Boolean));
  const newActors = (current.behaviors || []).filter(b => b.user && !prevUsers.has(b.user));
  if (newActors.length) {
    changes.push({ severity: 'high', text: `${newActors.length} new actor(s): ${newActors.map(b => b.user).join(', ')}` });
  }

  // Total detection count delta
  const prevCount = (prev.behaviors || []).reduce((s, b) => s + b.detections, 0);
  const currCount = (current.behaviors || []).reduce((s, b) => s + b.detections, 0);
  if (currCount > prevCount) {
    changes.push({ severity: 'medium', text: `+${currCount - prevCount} detections` });
  }

  // Critical / High risk level changes per section
  for (const section of ['Identities Risk', 'Assets Risk', 'Teams Risk']) {
    const c = current.risk?.[section];
    const p = prev.risk?.[section];
    if (!c || !p) continue;
    for (const level of ['critical', 'high']) {
      const diff = (c[level] ?? 0) - (p[level] ?? 0);
      if (diff > 0) {
        changes.push({ severity: level, text: `${section.replace(' Risk', '')}: +${diff} ${level}` });
      }
    }
  }

  return { firstRun: false, changes };
}

// ── Report ────────────────────────────────────────────────────────────────────
function badgeHTML(d) {
  if (d.firstRun)        return `<span class="badge new">First Run</span>`;
  if (!d.changes.length) return `<span class="badge ok">No Changes</span>`;
  return d.changes.map(c => `<span class="badge ${c.severity}">${c.text}</span>`).join('');
}

function riskBlock(label, counts) {
  if (!counts) return `<div class="rs"><div class="rl">${label}</div><span class="na">—</span></div>`;
  const crit = counts.critical ?? 0;
  const high = counts.high ?? 0;
  return `
    <div class="rs">
      <div class="rl">${label}</div>
      <span class="rb c ${crit > 0 ? 'hot' : ''}">${crit} crit</span>
      <span class="rb h ${high > 0 ? 'hot' : ''}">${high} high</span>
      <span class="tot">/ ${counts.total ?? '—'}</span>
    </div>`;
}

function generateReport(results) {
  const now = new Date().toLocaleString();

  const cards = results.map(({ tenant, data, d, error }) => {
    if (error) return `
      <div class="card err">
        <div class="ch"><span class="cn">${tenant.name}</span>
          <a href="${tenant.url}" target="_blank" class="tlink">↗</a></div>
        <div class="em">${error}</div>
      </div>`;

    const hasCrit  = d.changes.some(c => c.severity === 'critical');
    const lastDate = data.behaviors?.[0]?.dateEnd ?? '—';

    const topBehaviors = (data.behaviors || []).slice(0, 3).map(b =>
      `<div class="brow">
        <span class="bc">${b.detections}</span>
        <span class="bd">${b.user ?? '?'} · ${b.repos ?? '?'} repos · thru ${b.dateEnd ?? '?'}</span>
       </div>`
    ).join('');

    return `
      <div class="card${hasCrit ? ' crit' : ''}">
        <div class="ch">
          <div>
            <span class="cn">${tenant.name}</span>
            <a href="${tenant.url}" target="_blank" class="tlink">↗</a>
          </div>
          <div class="cm">Last finding: <b>${lastDate}</b></div>
        </div>
        <div class="dr">${badgeHTML(d)}</div>
        <div class="rg">
          ${riskBlock('Identities', data.risk?.['Identities Risk'])}
          ${riskBlock('Assets',     data.risk?.['Assets Risk'])}
          ${riskBlock('Teams',      data.risk?.['Teams Risk'])}
        </div>
        ${topBehaviors
          ? `<div class="bsec"><div class="sl">Top Behaviors</div>${topBehaviors}</div>`
          : '<div class="bsec none">No behaviors detected</div>'}
        <div class="cf">Scraped ${new Date(data.scrapedAt).toLocaleString()}</div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BlueFlag Monitor — ${now}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0d1117; color: #e6edf3; padding: 28px;
}
h1 { font-size: 20px; font-weight: 600; color: #58a6ff; margin-bottom: 4px; }
.sub { font-size: 13px; color: #8b949e; margin-bottom: 24px; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}
.card {
  background: #161b22; border: 1px solid #30363d;
  border-radius: 8px; padding: 16px;
}
.card.crit { border-color: #da3633; box-shadow: 0 0 0 1px #da363340; }
.card.err  { opacity: .55; }
.ch { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
.cn { font-size: 15px; font-weight: 600; margin-right: 6px; }
.tlink { color: #58a6ff; text-decoration: none; font-size: 12px; }
.cm { font-size: 12px; color: #8b949e; margin-top: 3px; }
.dr { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; min-height: 22px; }
.badge {
  font-size: 11px; font-weight: 600;
  padding: 3px 8px; border-radius: 10px;
}
.badge.new      { background: #1c3a5c; color: #58a6ff; }
.badge.ok       { background: #0f3526; color: #3fb950; }
.badge.critical { background: #4a1515; color: #f85149; }
.badge.high     { background: #3d2409; color: #e3b341; }
.badge.medium   { background: #2a2208; color: #d29922; }
.rg { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.rs {
  display: flex; align-items: center; gap: 8px;
  background: #0d1117; border-radius: 5px; padding: 6px 10px;
  font-size: 12px;
}
.rl { color: #8b949e; width: 72px; font-weight: 500; flex-shrink: 0; }
.rb { font-weight: 600; min-width: 52px; color: #484f58; }
.rb.c.hot { color: #f85149; }
.rb.h.hot { color: #e3b341; }
.tot { color: #484f58; margin-left: auto; }
.na { color: #484f58; font-size: 12px; }
.bsec { margin-bottom: 10px; }
.bsec.none { font-size: 12px; color: #484f58; font-style: italic; }
.sl {
  font-size: 10px; color: #8b949e;
  text-transform: uppercase; letter-spacing: .06em;
  font-weight: 600; margin-bottom: 6px;
}
.brow {
  display: flex; gap: 8px; align-items: baseline;
  font-size: 12px; padding: 4px 0;
  border-bottom: 1px solid #1c2128;
}
.brow:last-child { border: none; }
.bc { font-weight: 700; color: #f85149; min-width: 28px; }
.bd { color: #8b949e; }
.cf { font-size: 11px; color: #30363d; margin-top: 4px; }
.em { font-size: 12px; color: #f85149; margin-top: 8px; font-family: monospace; }
</style>
</head>
<body>
  <h1>BlueFlag Tenant Monitor</h1>
  <div class="sub">Generated: ${now} · ${results.length} tenant(s)</div>
  <div class="grid">${cards}</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let tenants = config.tenants;

  if (siteFilter) {
    tenants = tenants.filter(t => t.id.toLowerCase().includes(siteFilter.toLowerCase()));
    if (!tenants.length) {
      console.error(`No tenant matching: "${siteFilter}"`);
      console.error(`Available IDs: ${config.tenants.map(t => t.id).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`BlueFlag Monitor — ${tenants.length} tenant(s)${siteFilter ? ` [${siteFilter}]` : ''}${forceAll ? ' [refresh]' : ''}\n`);

  // Fetch today's intel from Gary's HackMD
  await fetchIntel(config);

  const results = [];

  for (const tenant of tenants) {
    console.log(`[${tenant.name}]`);
    try {
      const data = await scrape(tenant);
      const prev = forceAll ? null : loadSnapshot(tenant.id);

      // Archive previous snapshot before overwriting
      if (prev) {
        fs.writeFileSync(path.join(SNAPSHOTS_DIR, `${tenant.id}.prev.json`), JSON.stringify(prev, null, 2));
      }

      // Attach detailed delta to snapshot so UI can display it
      data.delta = computeDeltaDetailed(data, prev);

      const d = computeDelta(data, prev);
      saveSnapshot(tenant.id, data);

      // Log delta summary
      const dd = data.delta;
      if (!dd.firstRun) {
        if (dd.newActors.length)      console.log(`  ⚡ NEW actors: ${dd.newActors.join(', ')}`);
        if (dd.resolvedActors.length) console.log(`  ✓ Resolved: ${dd.resolvedActors.join(', ')}`);
        if (dd.activeToday)           console.log(`  ◉ Active today`);
        const ups = Object.entries(dd.detectionChanges).map(([u,v])=>`${u} +${v.diff}`).join(', ');
        if (ups) console.log(`  ↑ Detection increases: ${ups}`);
      }
      console.log(`  ✓ ${data.behaviors.length} behavior(s) · ${d.changes.length} change(s)`);
      results.push({ tenant, data, d, error: null });
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      results.push({ tenant, data: null, d: null, error: err.message });
    }
    console.log();
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFile = path.join(REPORTS_DIR, `report-${stamp}.html`);
  fs.writeFileSync(reportFile, generateReport(results));
  console.log(`Report → ${reportFile}`);
  console.log(`Open:    open "${reportFile}"`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
