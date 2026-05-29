'use strict';

const express = require('express');
const cron    = require('node-cron');
const { spawn, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const app = express();
const DIR = __dirname;

app.use(express.json());
app.use(express.static(path.join(DIR, 'public'), { etag: false, lastModified: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));

// ── Helpers ───────────────────────────────────────────────────────────────────
// In Docker, persistent data lives in /app/data (volume-mounted from Synology)
// Outside Docker, falls back to the project root — no config change needed
const DATA_DIR  = require('fs').existsSync(path.join(DIR, 'data')) ? path.join(DIR, 'data') : DIR;
const cfgPath   = path.join(DATA_DIR, 'config.json');
const notesPath = path.join(DATA_DIR, 'notes.json');

function readNotes() {
  if (!fs.existsSync(notesPath)) return {};
  try { return JSON.parse(fs.readFileSync(notesPath, 'utf8')); } catch { return {}; }
}
const snapDir = path.join(DATA_DIR, 'snapshots');
const repDir  = path.join(DATA_DIR, 'reports');

function readConfig() {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function decodeCfg(cfg) {
  return {
    ...cfg,
    defaultUsername: Buffer.from(cfg.defaultUsername || '', 'base64').toString(),
    defaultPassword: Buffer.from(cfg.defaultPassword || '', 'base64').toString(),
    tenants: (cfg.tenants || []).map(t => ({
      ...t,
      username: t.username ? Buffer.from(t.username, 'base64').toString() : '',
      password: t.password ? Buffer.from(t.password, 'base64').toString() : '',
    })),
  };
}

function encodeCfg(body) {
  return {
    _note: 'Managed by BlueFlag Monitor UI',
    staleDays:     body.staleDays ?? 30,
    runTime:       body.runTime  || '07:00',
    claudeApiKey:  body.claudeApiKey || '',
    intelUrl:      body.intelUrl || '',
    defaultUsername: Buffer.from(body.defaultUsername || '').toString('base64'),
    defaultPassword: Buffer.from(body.defaultPassword || '').toString('base64'),
    tenants: (body.tenants || []).map(t => ({
      id:       t.id || slugify(t.name),
      name:     t.name,
      url:      t.url.replace(/\/$/, ''),
      contactName: t.contactName || null,
      username: t.username ? Buffer.from(t.username).toString('base64') : null,
      password: t.password ? Buffer.from(t.password).toString('base64') : null,
    })),
  };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'tenant' + Date.now();
}

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try   { res.json(decodeCfg(readConfig())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', (req, res) => {
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(encodeCfg(req.body), null, 2));
    scheduleDailyRun();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Snapshots ─────────────────────────────────────────────────────────────────
app.get('/api/snapshots', (req, res) => {
  const out = {};
  if (fs.existsSync(snapDir)) {
    for (const f of fs.readdirSync(snapDir).filter(f => f.endsWith('.json'))) {
      try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')); }
      catch {}
    }
  }
  res.json(out);
});

// ── Delete snapshot (force next run to be "first run") ────────────────────────
app.delete('/api/snapshots/:id', (req, res) => {
  const file = path.join(snapDir, `${req.params.id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ── Run Stream (SSE) + Stop ───────────────────────────────────────────────────
let activeProc = null;
const aiLogClients = new Set();
const aiLogBuffer  = []; // ring buffer — holds last 500 messages for late-connecting clients
const AI_BUF_MAX   = 500;

// Broadcast a plain text line to all SSE clients and the buffer
// Used for cron/startup runs so they appear in the Activity Log
function broadcastRun(text) {
  process.stdout.write(text);
  const frame = `event: log\ndata: ${JSON.stringify({ text })}\n\n`;
  aiLogBuffer.push(frame);
  if (aiLogBuffer.length > AI_BUF_MAX) aiLogBuffer.shift();
  for (const client of aiLogClients) client.write(frame);
}

app.get('/api/run/stream', (req, res) => {
  if (activeProc) {
    res.status(409).json({ error: 'A run is already in progress' });
    return;
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');

  const runArgs = ['run.js'];
  if (req.query.site)    runArgs.push(`--site=${req.query.site}`);
  if (req.query.refresh) runArgs.push('--refresh');

  aiLogClients.add(res);
  const proc = spawn('node', runArgs, { cwd: DIR });
  activeProc = proc;

  const send = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);

  proc.stdout.on('data', c => send('log', { text: c.toString() }));
  proc.stderr.on('data', c => send('log', { text: c.toString(), err: true }));
  proc.on('close', code => {
    activeProc = null;
    aiLogClients.delete(res);
    send('done', { code });
    res.end();
  });
  req.on('close', () => { aiLogClients.delete(res); if (activeProc === proc) activeProc = null; proc.kill(); });
});

app.post('/api/run/stop', (req, res) => {
  if (activeProc) {
    activeProc.kill('SIGTERM');
    activeProc = null;
    res.json({ ok: true });
  } else {
    res.json({ ok: false, msg: 'No active run' });
  }
});

// ── Notes ────────────────────────────────────────────────────────────────────────
app.get('/api/notes', (req, res) => {
  res.json(readNotes());
});

app.post('/api/notes/:id', (req, res) => {
  try {
    const notes = readNotes();
    notes[req.params.id] = req.body.note ?? '';
    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Latest Report ─────────────────────────────────────────────────────────────
app.get('/api/reports/latest', (req, res) => {
  if (!fs.existsSync(repDir)) return res.status(404).send('No reports yet');
  const files = fs.readdirSync(repDir).filter(f => f.endsWith('.html')).sort();
  if (!files.length) return res.status(404).send('No reports yet');
  res.sendFile(path.join(repDir, files.at(-1)));
});

// ── Daily Cron ───────────────────────────────────────────────────────────────────
let cronTask = null;
function scheduleDailyRun() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  const cfg     = readConfig();
  const runTime = cfg.runTime || process.env.RUN_TIME || '07:00';
  const [hh, mm] = runTime.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return;

  cronTask = cron.schedule(`${mm} ${hh} * * *`, () => {
    if (activeProc) { broadcastRun('[cron] Skipping — a run is already in progress\n'); return; }
    broadcastRun(`[cron] Daily run starting (${new Date().toLocaleString()})\n`);
    const proc = spawn('node', ['run.js'], { cwd: DIR });
    activeProc = proc;
    proc.stdout.on('data', d => broadcastRun(d.toString()));
    proc.stderr.on('data', d => broadcastRun(d.toString()));
    proc.on('close', code => {
      activeProc = null;
      broadcastRun(`[cron] Daily run complete (exit ${code}) at ${new Date().toLocaleString()}\n`);
    });
  }, { timezone: process.env.TZ || 'America/Chicago' });

  console.log(`Cron: daily run scheduled at ${runTime} (${process.env.TZ || 'America/Chicago'})`);
}
scheduleDailyRun();

// ── Startup catch-up run ──────────────────────────────────────────────────────
// If today's scheduled run time has already passed but no scrape has happened
// today, run immediately on boot. Handles the Mac sleeping through the cron.
function startupCatchupRun() {
  if (activeProc) return;
  if (!fs.existsSync(snapDir)) return;

  let newest = null;
  try {
    for (const f of fs.readdirSync(snapDir).filter(f => f.endsWith('.json') && !f.endsWith('.prev.json') && !f.includes('history'))) {
      const snap = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8'));
      if (snap.scrapedAt && (!newest || snap.scrapedAt > newest)) newest = snap.scrapedAt;
    }
  } catch {}

  if (!newest) return;

  const cfg = readConfig();
  const [hh, mm] = (cfg.runTime || '07:00').split(':').map(Number);
  const now = new Date();
  const scheduledToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
  const lastScrape = new Date(newest);

  console.log(`[startup] Last scrape: ${lastScrape.toLocaleString()}`);
  console.log(`[startup] Scheduled run today: ${scheduledToday.toLocaleString()}`);

  // Catch-up if: scheduled time has passed today AND last scrape was before today's scheduled run
  if (now >= scheduledToday && lastScrape < scheduledToday) {
    broadcastRun(`[startup] Missed today's scheduled run — catch-up scrape in 10s\n`);
    setTimeout(() => {
      if (activeProc) return;
      broadcastRun(`[startup] Catch-up run starting...\n`);
      const proc = spawn('node', ['run.js'], { cwd: DIR });
      activeProc = proc;
      proc.stdout.on('data', d => broadcastRun(d.toString()));
      proc.stderr.on('data', d => broadcastRun(d.toString()));
      proc.on('close', code => {
        activeProc = null;
        broadcastRun(`[startup] Catch-up run complete (exit ${code})\n`);
      });
    }, 10000);
  } else {
    console.log(`[startup] No catch-up needed — data is current`);
  }
}
startupCatchupRun();

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = 3737;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nBlueFlag Monitor → ${url}\n`);
  exec(`open ${url}`, () => {}); // auto-open on Mac
});

// ── Intel ─────────────────────────────────────────────────────────────────────
const intelPath = path.join(DATA_DIR, 'intel.json');

function readIntel() {
  if (!fs.existsSync(intelPath)) return null;
  try { return JSON.parse(fs.readFileSync(intelPath, 'utf8')); } catch { return null; }
}

app.get('/api/intel', (req, res) => {
  res.json(readIntel() || {});
});


// ── AI Log Stream (for email generation outside of a scrape run) ──────────────
app.get('/api/ai/log-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  // Flush any buffered messages so late-connecting clients see the full log
  for (const msg of aiLogBuffer) res.write(msg);
  aiLogClients.add(res);
  req.on('close', () => aiLogClients.delete(res));
});

// ── AI Email Generation ───────────────────────────────────────────────────────
app.post('/api/generate-email', async (req, res) => {
  const { tenantId } = req.body;
  try {
    const cfg    = readConfig();
    const apiKey = cfg.claudeApiKey;
    if (!apiKey) return res.status(400).json({ error: 'No Claude API key in Settings' });

    // Load tenant data
    const tenant = (cfg.tenants||[]).find(t=>t.id===tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const snapFile = path.join(snapDir, `${tenantId}.json`);
    const snap     = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile,'utf8')) : null;
    const intel    = readIntel();

    // Build context
    const actorLines = [];
    for (const p of (snap?.policies||[])) {
      for (const a of (p.actors||[])) {
        if (!a.user) continue;
        let line = `- ${a.user} (${a.identityType||'user'}): ${p.name} [${p.severity}]`;
        if (a.spikePercent > 0) line += ` — ${a.spikePercent}% clone spike, ${a.baselineCount} → ${a.newCount} repos`;
        if (a.date)             line += ` on ${a.date}`;
        if (a.repository)       line += ` in ${a.repository}`;
        actorLines.push(line);
      }
    }
    // Enrich with identity-level data if available
    const identities = snap?.identities || {};
    for (const line of [...actorLines]) {
      const user = line.match(/^- ([^:(\s]+)/)?.[1];
      if (!user || !identities[user]) continue;
      const id = identities[user];
      const extras = [];
      if (id.riskRating)    extras.push(`Risk: ${id.riskRating}`);
      if (id.overPrivScore) extras.push(`OverPrivilege Score: ${id.overPrivScore}`);
      if (id.lastEvent)     extras.push(`Last active: ${id.lastEvent}`);
      if (id.tokens)        extras.push(`${id.tokens} tokens`);
      if (id.repos)         extras.push(`${id.repos} repos`);
      if (id.adminPermissions) extras.push(`${id.adminPermissions} admin permissions`);
      if (id.numberOfClones) extras.push(`${id.numberOfClones} clones`);
      if (id.topActiveRepos?.length) extras.push(`Top repos: ${id.topActiveRepos.slice(0,3).join(', ')}`);
      if (id.riskReasons?.length) {
        const top = id.riskReasons.slice(0,2).map(r=>`${r.policyName} (${r.violationsCount})`).join(', ');
        extras.push(`Top violations: ${top}`);
      }
      if (extras.length) {
        const idx = actorLines.indexOf(line);
        actorLines[idx] = line + ` [${extras.join(' | ')}]`;
      }
    }

    // Fallback to behaviors
    if (!actorLines.length && snap?.behaviors?.length) {
      for (const b of snap.behaviors.slice(0,3)) {
        if (!b.user) continue;
        const id = identities[b.user];
        let line = `- ${b.user}: ${b.detections} detections over ${b.days||'?'} days, ${b.repos||'?'} repos (${b.dateStart} → ${b.dateEnd})`;
        if (id?.riskRating)    line += ` | Risk: ${id.riskRating}`;
        if (id?.overPrivScore) line += ` | OPS: ${id.overPrivScore}`;
        if (id?.lastEvent)     line += ` | Last active: ${id.lastEvent}`;
        if (id?.numberOfClones) line += ` | ${id.numberOfClones} clones`;
        if (id?.riskReasons?.length) line += ` | Top risk reasons: ${id.riskReasons.slice(0,3).map(r=>`${r.policyName} (${r.violationsCount})`).join(', ')}`;
        actorLines.push(line);
      }
    }

    const intelHook = intel?.stories?.filter(s=>s.score>=4).slice(0,2)
      .map(s=>`- ${s.title}${s.why?`: ${s.why}`:''}`)
      .join('\n') || '';

    const riskSummary = Object.entries(snap?.risk||{})
      .map(([sec,r])=>r&&(r.critical||r.high)?`${sec.replace(' Risk','')}: ${r.critical||0} critical, ${r.high||0} high`:'')
      .filter(Boolean).join(' | ');

    // ── Scrambler — replace all customer-identifiable strings with generic tokens ──
    // Nothing identifiable leaves this server; tokens are reversed on the response.
    const _actorSet = new Set();
    const _repoSet  = new Set();
    for (const p of (snap?.policies||[])) {
      for (const a of (p.actors||[])) {
        if (a.user)       _actorSet.add(a.user);
        if (a.repository) _repoSet.add(a.repository);
      }
    }
    for (const [user, id] of Object.entries(identities)) {
      _actorSet.add(user);
      (id.topActiveRepos||[]).forEach(r => _repoSet.add(r));
    }
    for (const b of (snap?.behaviors||[])) { if (b.user) _actorSet.add(b.user); }

    const tokenMap   = new Map(); // real → fake
    const reverseMap = new Map(); // fake → real
    const addToken   = (real, fake) => { if (real) { tokenMap.set(real, fake); reverseMap.set(fake, real); } };

    addToken(tenant.name, 'Contoso');
    addToken(tenant.url,  'https://contoso.blueflagsecurity.com');
    // Use numbered tokens — no pool limit, no collisions
    [..._actorSet].forEach((u, i) => addToken(u, `dev_${String(i + 1).padStart(2, '0')}`));
    [..._repoSet ].forEach((r, i) => addToken(r, `repo_${String(i + 1).padStart(2, '0')}`));

    const applyMap = (text, map) => {
      let out = text;
      [...map.entries()].sort((a,b) => b[0].length - a[0].length).forEach(([k,v]) => { out = out.split(k).join(v); });
      return out;
    };
    const scramble   = t => applyMap(t, tokenMap);
    const unscramble = t => applyMap(t, reverseMap);

    const prompt = `You are Chris Goodman, Head of Threat at BlueFlag Security. Write a short, direct customer-facing outreach email to a security/engineering leader at the customer organization.

VOICE: Casual, credible, and slightly urgent — but not alarmist. Sound like a security partner sharing a specific finding worth reviewing, not a sales pitch. Use real names, real numbers, and specific repo/policy details. Keep it concise: 2-3 short paragraphs max. End with a clear ask for 15 minutes to review the findings.

CUSTOMER: ${tenant.name}
URL: ${tenant.url}

ACTOR FINDINGS:
${actorLines.length ? actorLines.join('\n') : 'No specific actors identified yet — use risk data below'}

RISK EXPOSURE:
${riskSummary || 'Not available'}

TODAY'S THREAT CONTEXT (use only if it naturally strengthens the message; do not force it):
${intelHook || 'General SDLC and developer identity threats are elevated'}

Write:
1. A subject line (start with "Subject: ")
2. Then the email body addressed directly to the customer.

Rules:
- Do not mention a sales rep, prospect owner, or internal handoff.
- Do not say "your prospect" or "the customer"; speak directly to the customer using "your environment" and "your team".
- Do not overstate breach/exfiltration. Use language like "worth reviewing", "pattern we would want to validate", or "could indicate".
- Do not use bullet points in the email body.
- Reference the strongest actor finding and 1-2 concrete numbers/policy reasons.
- If there is a very large clone count, mention it plainly and connect it to why it matters.`;

    const scrambledPrompt = scramble(prompt);

    // Log to activity SSE stream if one is open, otherwise just console
    const logAI = (msg) => {
      console.log(`[AI] ${msg}`);
      const frame = `event: log\ndata: ${JSON.stringify({ text: `[AI] ${msg}\n` })}\n\n`;
      aiLogBuffer.push(frame);
      if (aiLogBuffer.length > AI_BUF_MAX) aiLogBuffer.shift();
      for (const client of aiLogClients) client.write(frame);
    };

    logAI(`Generating customer-facing email for ${tenant.name}`);
    logAI(`Model: claude-sonnet-4-20250514`);
    logAI(`Context: ${actorLines.length} actor(s), ${intelHook ? 'intel hook loaded' : 'no intel'}`);
    logAI(`Scramble map (${tokenMap.size} values):\n${[...tokenMap.entries()].map(([r,f])=>`  "${r}" → "${f}"`).join('\n')}`);
    logAI(`Sending request to Anthropic API...`);
    logAI(`--- PROMPT SENT TO ANTHROPIC (scrambled) ---\n${scrambledPrompt}\n--- END PROMPT ---`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: scrambledPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const usage = data.usage;
    logAI(`Response received — input tokens: ${usage?.input_tokens}, output tokens: ${usage?.output_tokens}`);

    const rawText  = data.content?.[0]?.text || '';
    const text     = unscramble(rawText);
    const lines    = text.split('\n');
    const subjIdx  = lines.findIndex(l=>l.startsWith('Subject:'));
    const subject  = subjIdx>=0 ? lines[subjIdx].replace('Subject:','').trim() : '';
    const body     = lines.slice(subjIdx>=0?subjIdx+1:0).join('\n').trim();

    logAI(`--- RESPONSE FROM ANTHROPIC (scrambled, as received) ---\n${rawText}\n--- END RESPONSE ---`);
    logAI(`--- FINAL EMAIL (names restored) ---\n${text}\n--- END EMAIL ---`);
    logAI(`✓ Email draft generated for ${tenant.name}`);
    res.json({ subject, body });
  } catch(e) {
    console.error(`[AI] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});
