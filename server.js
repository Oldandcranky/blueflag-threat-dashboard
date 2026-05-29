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

// ── Actor History — new vs returning across all runs ─────────────────────────
app.get('/api/history/:id', (req, res) => {
  const histDir = path.join(snapDir, 'history', req.params.id);
  if (!fs.existsSync(histDir)) return res.json({ runs: [], actors: {} });

  const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json')).sort();
  const actorMap = {}; // actor → { firstSeen, lastSeen, runCount, ratings[] }

  for (const f of files) {
    const date = f.slice(0, 10);
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      const actors = new Set([
        ...(snap.behaviors||[]).map(b=>b.user).filter(Boolean),
        ...Object.keys(snap.identities||{})
      ]);
      for (const actor of actors) {
        if (!actorMap[actor]) actorMap[actor] = { firstSeen: date, lastSeen: date, runCount: 0, ratings: [] };
        actorMap[actor].lastSeen = date;
        actorMap[actor].runCount++;
        const rating = snap.identities?.[actor]?.riskRating;
        if (rating) actorMap[actor].ratings.push(rating);
      }
    } catch {}
  }

  const today = new Date().toISOString().slice(0, 10);
  const totalRuns = files.length;
  const actors = Object.entries(actorMap).map(([name, d]) => {
    const daysSinceFirst = Math.floor((Date.now() - new Date(d.firstSeen)) / 86400000);
    let status;
    if (d.firstSeen === today)                status = 'new';
    else if (daysSinceFirst < 7)              status = 'recent';
    else if (daysSinceFirst < 30)             status = 'persistent';
    else                                       status = 'chronic';
    const topRating = ['Critical','High','Medium','Low'].find(r => d.ratings.includes(r)) || 'Unknown';
    return { name, firstSeen: d.firstSeen, lastSeen: d.lastSeen, runCount: d.runCount, totalRuns, status, daysSinceFirst, topRating };
  }).sort((a,b) => b.daysSinceFirst - a.daysSinceFirst);

  res.json({ runs: files.map(f=>f.slice(0,10)), actors });
});

// ── Engagement Arc — full risk journey HTML leave-behind ──────────────────────
app.get('/api/arc/:id', (req, res) => {
  const cfg     = readConfig();
  const tenant  = (cfg.tenants||[]).find(t=>t.id===req.params.id);
  const histDir = path.join(snapDir, 'history', req.params.id);
  if (!tenant || !fs.existsSync(histDir)) return res.status(404).send('No history found');

  const files = fs.readdirSync(histDir).filter(f=>f.endsWith('.json')).sort();
  if (!files.length) return res.status(404).send('No history found');

  // Load latest snapshot for Sankey data
  const latestSnap = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(snapDir, `${req.params.id}.json`), 'utf8')); } catch { return null; }
  })();

  // ── Aggregate threats across all history runs ────────────────────────────────
  const policyMap = {}; // policyName → { severity, totalViolations, actors, runs, firstSeen, lastSeen }
  const actorPolicyMap = {}; // actor → { policyName → { severity, maxViolations, firstSeen } }

  const runs = files.map(f => {
    const date = f.slice(0,10);
    try {
      const s = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
      const crit = Object.values(s.risk||{}).reduce((n,r)=>n+(r?.critical||0),0);
      const high = Object.values(s.risk||{}).reduce((n,r)=>n+(r?.high||0),0);
      const actors = [...new Set([...(s.behaviors||[]).map(b=>b.user).filter(Boolean)])];

      // Aggregate policy findings from this run's identities
      for (const [actor, identity] of Object.entries(s.identities||{})) {
        for (const reason of (identity.riskReasons||[])) {
          const p = reason.policyName;
          const sev = reason.severity || 'Medium';
          const v = reason.violationsCount || 1;
          if (!policyMap[p]) policyMap[p] = { severity: sev, totalViolations: 0, actors: new Set(), runs: new Set(), firstSeen: date, lastSeen: date };
          policyMap[p].totalViolations += v;
          policyMap[p].actors.add(actor);
          policyMap[p].runs.add(date);
          policyMap[p].lastSeen = date;

          if (!actorPolicyMap[actor]) actorPolicyMap[actor] = {};
          if (!actorPolicyMap[actor][p] || v > actorPolicyMap[actor][p].maxViolations) {
            actorPolicyMap[actor][p] = { severity: sev, maxViolations: v, firstSeen: actorPolicyMap[actor][p]?.firstSeen || date };
          }
        }
      }

      return { date, crit, high, actors, actorCount: actors.length };
    } catch { return null; }
  }).filter(Boolean);

  // Sort policies: Critical first, then by total violations desc
  const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const topPolicies = Object.entries(policyMap)
    .sort((a,b) => (sevOrder[a[1].severity]||9) - (sevOrder[b[1].severity]||9) || b[1].totalViolations - a[1].totalViolations)
    .map(([name, d]) => ({ name, ...d, actors: [...d.actors], runs: d.runs.size }));

  // Build actor timeline
  const actorTimeline = {};
  for (const run of runs) {
    for (const actor of run.actors) {
      if (!actorTimeline[actor]) actorTimeline[actor] = { first: run.date, last: run.date, count: 0 };
      actorTimeline[actor].last = run.date;
      actorTimeline[actor].count++;
    }
  }
  const chronics = Object.entries(actorTimeline).filter(([,v])=>v.count>=runs.length*0.7).map(([k])=>k);
  const lastRunActors = new Set(runs.at(-1)?.actors || []);
  const resolved = Object.entries(actorTimeline)
    .filter(([k, v]) => !lastRunActors.has(k) && v.count > 1)
    .map(([k]) => k);

  const firstRun = runs[0], lastRun = runs.at(-1);
  const engagementDays = Math.floor((new Date(lastRun.date)-new Date(firstRun.date))/86400000)+1;

  // Trend: improving, stable, or worsening?
  const firstCrit = firstRun.crit, lastCrit = lastRun.crit;
  const trend = lastCrit < firstCrit * 0.8 ? '↓ Improving' : lastCrit > firstCrit * 1.1 ? '↑ Worsening' : '→ Stable';
  const trendColor = trend.startsWith('↓') ? '#27ae60' : trend.startsWith('↑') ? '#e05252' : '#f39c12';

  // ── Executive Overview ────────────────────────────────────────────────────────
  const topThreat = topPolicies[0];
  const chronicCount = chronics.length;
  const resolvedCount = resolved.length;
  const critChange = lastCrit - firstCrit;
  const critChangeStr = critChange > 0 ? `increased by ${critChange}` : critChange < 0 ? `decreased by ${Math.abs(critChange)}` : 'remained stable';
  const trendWord = trend.startsWith('↓') ? 'improving' : trend.startsWith('↑') ? 'worsening' : 'stable';
  const execOverviewHTML = `
  <div class="exec-overview">
    <div class="exec-title">Executive Overview</div>
    <div class="exec-kpis">
      <div class="exec-kpi"><div class="exec-kpi-val" style="color:${trendColor}">${trend}</div><div class="exec-kpi-label">Risk Direction</div></div>
      <div class="exec-kpi"><div class="exec-kpi-val" style="color:#e05252">${lastCrit.toLocaleString()}</div><div class="exec-kpi-label">Critical Findings (Latest)</div></div>
      <div class="exec-kpi"><div class="exec-kpi-val">${chronicCount}</div><div class="exec-kpi-label">Persistent Identities</div></div>
      <div class="exec-kpi"><div class="exec-kpi-val" style="color:#27ae60">${resolvedCount}</div><div class="exec-kpi-label">Resolved This Period</div></div>
      <div class="exec-kpi"><div class="exec-kpi-val">${engagementDays}</div><div class="exec-kpi-label">Days Under Monitoring</div></div>
    </div>
    <div class="exec-body">
      <p>Over the past <strong>${engagementDays} days</strong>, BlueFlag Security monitored <strong>${tenant.name}</strong> across <strong>${runs.length} daily scans</strong>.
      Overall, critical findings have ${critChangeStr} since monitoring began${firstCrit > 0 ? ` (${firstCrit.toLocaleString()} → ${lastCrit.toLocaleString()})` : ''}.
      </p>
      ${topThreat ? `<p style="margin-top:10px">The highest-priority finding throughout this engagement has been <strong>${topThreat.name}</strong> (${topThreat.severity}),
      which fired across <strong>${topThreat.runs} of ${runs.length} monitoring runs</strong> with <strong>${topThreat.totalViolations.toLocaleString()} total violations</strong>
      affecting ${topThreat.actors.length} ${topThreat.actors.length === 1 ? 'identity' : 'identities'}. This represents a persistent, unresolved exposure that warrants immediate attention.</p>` : ''}
      ${chronicCount > 0 ? `<p style="margin-top:10px"><strong>${chronicCount} ${chronicCount === 1 ? 'identity has' : 'identities have'} appeared in every monitoring run</strong> —
      indicating these are not transient issues but structural risks embedded in the development workflow.
      ${resolvedCount > 0 ? `Positively, <strong>${resolvedCount} ${resolvedCount === 1 ? 'identity was' : 'identities were'} resolved</strong> during this period, demonstrating that remediation is possible when findings are actioned.` : 'No identities have been remediated during this period.'}
      </p>` : ''}
    </div>
  </div>`;

  const rowsHTML = runs.map((r,i) => {
    const prev = runs[i-1];
    const critDelta = prev ? r.crit - prev.crit : 0;
    const critStr = critDelta > 0 ? `<span style="color:#e05252">▲${critDelta}</span>` : critDelta < 0 ? `<span style="color:#27ae60">▼${Math.abs(critDelta)}</span>` : '<span style="color:#aaa">—</span>';
    return `<tr>
      <td style="font-family:monospace">${r.date}</td>
      <td><strong style="color:#e05252">${r.crit}</strong></td>
      <td>${critStr}</td>
      <td style="color:#e07d22">${r.high}</td>
      <td>${r.actorCount}</td>
      <td style="font-size:11px;color:#888;max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.actors.slice(0,3).map(a=>a.split(/[-_]/)[0]).join(', ')}${r.actors.length>3?` +${r.actors.length-3} more`:''}</td>
    </tr>`;
  }).join('');

  // Sankey: Identities → Policies → Severity (from latest snapshot)
  const sankeyData = (() => {
    const identities = latestSnap?.identities || {};
    if (!Object.keys(identities).length) return null;

    const actorNames = [], policyNames = [], sevNames = ['Critical','High','Medium'];
    const links = [];

    // Collect unique actors and policies
    for (const [actor, id] of Object.entries(identities)) {
      if (!(id.riskReasons||[]).length) continue;
      actorNames.push(actor);
    }
    const topActors = actorNames.slice(0, 8); // cap at 8 for readability
    for (const actor of topActors) {
      for (const r of (identities[actor]?.riskReasons||[])) {
        if (!policyNames.includes(r.policyName)) policyNames.push(r.policyName);
      }
    }
    const topPoliciesNames = policyNames.slice(0, 10);

    // Build node list: actors | policies | severities
    const nodes = [
      ...topActors.map(n=>({ name: n.split(/[-_@]/)[0] + (n.includes('@') ? '@'+n.split('@')[1].split('.')[0] : '') })),
      ...topPoliciesNames.map(n=>({ name: n.length > 35 ? n.slice(0,33)+'…' : n })),
      ...sevNames.map(n=>({ name: n }))
    ];
    const actorOffset  = 0;
    const policyOffset = topActors.length;
    const sevOffset    = topActors.length + topPoliciesNames.length;

    for (let ai = 0; ai < topActors.length; ai++) {
      const actor = topActors[ai];
      for (const r of (identities[actor]?.riskReasons||[])) {
        const pi = topPoliciesNames.indexOf(r.policyName);
        if (pi < 0) continue;
        const v = r.violationsCount || 1;
        links.push({ source: actorOffset+ai, target: policyOffset+pi, value: v });
        const si = sevNames.indexOf(r.severity);
        if (si >= 0) links.push({ source: policyOffset+pi, target: sevOffset+si, value: v });
      }
    }
    // Deduplicate/merge links
    const merged = {};
    for (const l of links) {
      const k = `${l.source}-${l.target}`;
      merged[k] = { source: l.source, target: l.target, value: (merged[k]?.value||0) + l.value };
    }
    return JSON.stringify({ nodes, links: Object.values(merged) });
  })();

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${tenant.name} — Identity Lifecycle Review</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9ff; color: #1a1a2e; }
  .page { max-width: 1100px; margin: 0 auto; padding: 40px 32px 60px; }

  /* Header */
  .header { background: linear-gradient(135deg, #0d1e3c 0%, #1550FF 100%); border-radius: 12px; padding: 32px 36px; margin-bottom: 28px; color: #fff; }
  .header h1 { font-size: 26px; font-weight: 800; margin-bottom: 4px; }
  .header .sub { font-size: 13px; opacity: .65; font-family: monospace; }

  /* KPIs */
  .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 28px; }
  .kpi { background: #fff; border: 1px solid #e0e4f0; border-radius: 10px; padding: 16px 18px; }
  .kpi-val { font-size: 26px; font-weight: 800; color: #1550FF; font-family: monospace; line-height: 1; margin-bottom: 5px; }
  .kpi-val.red { color: #e05252; }
  .kpi-val.green { color: #27ae60; }
  .kpi-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #999; }

  /* Sections */
  .section { background: #fff; border: 1px solid #e0e4f0; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: #999; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid #f0f0f0; }
  /* Charts */
  #sankeyChart { width: 100%; overflow: visible; }
  /* Executive Overview */
  .exec-overview { background:linear-gradient(135deg,#0d1e3c 0%,#1a3a6b 100%); border-radius:10px; padding:24px 28px; margin-bottom:20px; color:#fff; }
  .exec-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.14em; color:rgba(255,255,255,.5); margin-bottom:18px; }
  .exec-kpis { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:20px; }
  .exec-kpi { background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.1); border-radius:8px; padding:12px 14px; }
  .exec-kpi-val { font-size:20px; font-weight:800; font-family:monospace; color:#fff; line-height:1; margin-bottom:4px; }
  .exec-kpi-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:rgba(255,255,255,.45); }
  .exec-body { font-size:13px; line-height:1.7; color:rgba(255,255,255,.8); }
  .exec-body strong { color:#fff; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 10px; background: #f8f9ff; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #999; border-bottom: 2px solid #eee; }
  td { padding: 8px 10px; border-bottom: 1px solid #f5f5f5; }
  tr:last-child td { border-bottom: none; }

  /* Actors */
  .actor-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .actor-card { background: #f8f9ff; border: 1px solid #e8ecf8; border-radius: 8px; padding: 12px 14px; }
  .actor-name { font-family: monospace; font-size: 11px; color: #333; font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .actor-meta { font-size: 10px; color: #999; }
  .actor-bar { height: 3px; background: #eee; border-radius: 2px; margin-top: 8px; }
  .actor-bar-fill { height: 3px; background: #1550FF; border-radius: 2px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; margin: 2px; }
  .tag.chronic { background: #ffe8e8; color: #c0392b; }
  .tag.resolved { background: #e8f8ee; color: #27ae60; }

  /* PDF button */
  .pdf-btn { display:inline-flex; align-items:center; gap:6px; background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); color:#fff; font-family:monospace; font-size:11px; font-weight:700; padding:7px 16px; border-radius:6px; cursor:pointer; text-decoration:none; transition:background .15s; float:right; }
  .pdf-btn:hover { background:rgba(255,255,255,.25); }
  /* Footer */
  .footer { text-align: center; font-size: 11px; color: #bbb; margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; }
  @media print { .pdf-btn { display:none; } .header { -webkit-print-color-adjust:exact; print-color-adjust:exact; } .exec-overview { -webkit-print-color-adjust:exact; print-color-adjust:exact; } .section { break-inside:avoid; } }
</style>
</head><body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <a href="/api/arc/${req.params.id}/pdf" class="pdf-btn">↓ Download PDF</a>
    <h1>${tenant.name} — Identity Lifecycle Review</h1>
    <div class="sub">${tenant.url} · BlueFlag Security · Generated ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
  </div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-val">${engagementDays}</div><div class="kpi-label">Days Monitored</div></div>
    <div class="kpi"><div class="kpi-val">${runs.length}</div><div class="kpi-label">Monitoring Runs</div></div>
    <div class="kpi"><div class="kpi-val red">${lastRun.crit.toLocaleString()}</div><div class="kpi-label">Critical (Latest)</div></div>
    <div class="kpi"><div class="kpi-val">${Object.keys(actorTimeline).length}</div><div class="kpi-label">Unique Actors</div></div>
    <div class="kpi"><div class="kpi-val ${resolved.length ? 'green' : ''}">${resolved.length}</div><div class="kpi-label">Resolved Actors</div></div>
  </div>

  <!-- Sankey full width -->
  <div class="section" style="margin-bottom:20px">
    <div class="section-title">Identities → Policies → Severity</div>
    <svg id="sankeyChart" height="320"></svg>
  </div>

  ${execOverviewHTML}

  <!-- Run history table -->
  <div class="section">
    <div class="section-title">Run History</div>
    <table>
      <thead><tr><th>Date</th><th>Critical</th><th>Δ</th><th>High</th><th>Actors</th><th>Top Actors</th></tr></thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  </div>

  <!-- Actors -->
  ${chronics.length ? `<div class="section">
    <div class="section-title">🔴 Chronic Actors — Present in 70%+ of Runs</div>
    <div>${chronics.map(a=>`<span class="tag chronic">${a}</span>`).join('')}</div>
  </div>` : ''}

  ${resolved.length ? `<div class="section">
    <div class="section-title">✅ Resolved Actors — No Longer Active</div>
    <div>${resolved.map(a=>`<span class="tag resolved">${a}</span>`).join('')}</div>
  </div>` : ''}

  <!-- Threats identified -->
  ${topPolicies.length ? `<div class="section">
    <div class="section-title">🎯 Threats Identified During Engagement</div>
    <table>
      <thead><tr><th>Finding / Policy</th><th>Severity</th><th>Total Violations</th><th>Actors Affected</th><th>Runs Present</th><th>First Seen</th><th>Last Seen</th></tr></thead>
      <tbody>${topPolicies.map(p => {
        const sevColor = p.severity==='Critical'?'#e05252':p.severity==='High'?'#e07d22':p.severity==='Medium'?'#f0b429':'#888';
        return `<tr>
          <td style="font-weight:600;max-width:300px">${p.name}</td>
          <td><span style="color:${sevColor};font-weight:700;font-size:11px">${p.severity}</span></td>
          <td style="font-family:monospace;font-weight:700;color:#333">${p.totalViolations.toLocaleString()}</td>
          <td style="font-size:11px;color:#666">${p.actors.slice(0,3).map(a=>a.split(/[-_@]/)[0]).join(', ')}${p.actors.length>3?` +${p.actors.length-3}`:''}</td>
          <td style="font-family:monospace">${p.runs} / ${runs.length}</td>
          <td style="font-family:monospace;font-size:11px;color:#999">${p.firstSeen}</td>
          <td style="font-family:monospace;font-size:11px;color:#999">${p.lastSeen}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>` : ''}

  <!-- Per-actor threat detail -->
  <div class="section">
    <div class="section-title">👤 Actor Threat Detail</div>
    ${Object.entries(actorPolicyMap).sort((a,b) => {
      const sevA = Math.min(...Object.values(a[1]).map(p=>sevOrder[p.severity]||9));
      const sevB = Math.min(...Object.values(b[1]).map(p=>sevOrder[p.severity]||9));
      return sevA - sevB;
    }).map(([actor, policies]) => {
      const sortedPolicies = Object.entries(policies).sort((a,b)=>(sevOrder[a[1].severity]||9)-(sevOrder[b[1].severity]||9));
      const topSev = sortedPolicies[0]?.[1]?.severity || 'Medium';
      const sevColor = topSev==='Critical'?'#e05252':topSev==='High'?'#e07d22':'#f0b429';
      const timeline = actorTimeline[actor] || {};
      return `<div style="border:1px solid #eee;border-radius:8px;padding:14px 16px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div>
            <div style="font-family:monospace;font-size:12px;font-weight:700;color:#1a1a2e">${actor}</div>
            <div style="font-size:10px;color:#999;margin-top:2px">First seen: ${timeline.first||'—'} · Last seen: ${timeline.last||'—'} · ${timeline.count||0}/${runs.length} runs</div>
          </div>
          <span style="color:${sevColor};font-weight:800;font-size:11px;background:${sevColor}18;padding:3px 10px;border-radius:6px">${topSev}</span>
        </div>
        <table style="margin:0">
          <thead><tr><th>Policy Violation</th><th>Severity</th><th>Max Violations (single run)</th></tr></thead>
          <tbody>${sortedPolicies.map(([p, d])=>{
            const c = d.severity==='Critical'?'#e05252':d.severity==='High'?'#e07d22':d.severity==='Medium'?'#f0b429':'#888';
            return `<tr><td>${p}</td><td style="color:${c};font-weight:700;font-size:11px">${d.severity}</td><td style="font-family:monospace">${d.maxViolations.toLocaleString()}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
    }).join('')}
  </div>

  <div class="footer">BlueFlag Security Threat Dashboard · Confidential · ${tenant.url}</div>
</div>

<script>
// ── Sankey: Identities → Policies → Severity ─────────────────────
(function() {
  const raw = ${sankeyData || 'null'};
  if (!raw || !raw.nodes.length) return;
  const svg = d3.select('#sankeyChart');
  const W = svg.node().parentElement.clientWidth - 48;
  const H = 320;
  svg.attr('width', W).attr('height', H);

  const sk = d3.sankey().nodeWidth(14).nodePadding(6).extent([[1,4],[W-120,H-4]]);
  let { nodes, links } = sk({ nodes: raw.nodes.map(d=>({...d})), links: raw.links.map(d=>({...d})) });

  // Color by column position
  const maxX = Math.max(...nodes.map(n=>n.x0));
  const color = n => {
    if (n.name==='Critical') return '#e05252';
    if (n.name==='High')     return '#e07d22';
    if (n.name==='Medium')   return '#f0b429';
    if (n.x0 === maxX)       return '#e05252';
    if (n.x0 === 0)          return '#1550FF';
    return '#6b7db3';
  };

  svg.append('g').selectAll('rect').data(nodes).join('rect')
    .attr('x',d=>d.x0).attr('y',d=>d.y0).attr('width',d=>d.x1-d.x0).attr('height',d=>Math.max(2,d.y1-d.y0))
    .attr('fill',color).attr('rx',3).attr('opacity',.9);

  svg.append('g').attr('fill','none').selectAll('path').data(links).join('path')
    .attr('d',d3.sankeyLinkHorizontal()).attr('stroke',d=>color(nodes[d.target.index||d.target]))
    .attr('stroke-width',d=>Math.max(1,d.width)).attr('opacity',.25);

  const minX = Math.min(...nodes.map(n=>n.x0));
  svg.append('g').selectAll('text').data(nodes).join('text')
    .attr('x',d=>d.x0===minX?d.x1+6:d.x0===maxX?d.x1+6:d.x0-6)
    .attr('y',d=>(d.y0+d.y1)/2).attr('dy','0.35em')
    .attr('text-anchor',d=>d.x0===minX?'start':d.x0===maxX?'start':'end')
    .attr('font-size',9).attr('font-family','monospace').attr('fill','#444')
    .attr('max-width',100).text(d=>d.name);
})();
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ── Demo Identity Lifecycle Review ───────────────────────────────────────────
app.get('/demo-arc', (req, res) => {
  // Build Sankey using name→index lookup so indices can never be wrong
  const demoNodes = [
    // Actors (0-7)
    'j.martinez_acme','svc-deploy-prod','t.okafor_acme','k.patel_acme','autobot-ci',
    'copilot-bot','claude-code-svc','lovable-bot',
    // Policies (8-17)
    'Terraform misconfigs','Branch protection bypass','Credential in commit',
    'Repo inactivity spike','Code scan vulns','Stale PATs','Failed PR checks',
    'Build config changes','OSS vulns','Unverified AI commits',
    // Severities (18-20)
    'Critical','High','Medium'
  ];
  const ni = Object.fromEntries(demoNodes.map((n,i)=>[n,i]));
  const demoLinks = [
    // j.martinez
    [ni['j.martinez_acme'],   ni['Terraform misconfigs'],    1847],
    [ni['j.martinez_acme'],   ni['Branch protection bypass'], 54],
    [ni['j.martinez_acme'],   ni['Code scan vulns'],          235],
    [ni['j.martinez_acme'],   ni['Failed PR checks'],         87],
    // svc-deploy
    [ni['svc-deploy-prod'],   ni['Terraform misconfigs'],     2104],
    [ni['svc-deploy-prod'],   ni['Repo inactivity spike'],    238],
    [ni['svc-deploy-prod'],   ni['Build config changes'],     136],
    // t.okafor
    [ni['t.okafor_acme'],     ni['Credential in commit'],     47],
    [ni['t.okafor_acme'],     ni['Terraform misconfigs'],     412],
    [ni['t.okafor_acme'],     ni['OSS vulns'],                98],
    // k.patel
    [ni['k.patel_acme'],      ni['Branch protection bypass'], 22],
    [ni['k.patel_acme'],      ni['Stale PATs'],               3],
    [ni['k.patel_acme'],      ni['Failed PR checks'],         69],
    // autobot-ci
    [ni['autobot-ci'],        ni['Code scan vulns'],          1405],
    [ni['autobot-ci'],        ni['Build config changes'],     67],
    // copilot-bot (GitHub Copilot service account)
    [ni['copilot-bot'],       ni['Unverified AI commits'],    312],
    [ni['copilot-bot'],       ni['Failed PR checks'],         44],
    [ni['copilot-bot'],       ni['OSS vulns'],                89],
    // claude-code-svc (Claude Code agentic service account)
    [ni['claude-code-svc'],   ni['Unverified AI commits'],    178],
    [ni['claude-code-svc'],   ni['Terraform misconfigs'],     203],
    [ni['claude-code-svc'],   ni['Credential in commit'],     12],
    // lovable-bot (Lovable AI builder)
    [ni['lovable-bot'],       ni['Unverified AI commits'],    94],
    [ni['lovable-bot'],       ni['OSS vulns'],                156],
    [ni['lovable-bot'],       ni['Failed PR checks'],         31],
    // Policies → Severities
    [ni['Terraform misconfigs'],    ni['Critical'], 4566],
    [ni['Branch protection bypass'],ni['Critical'],  76],
    [ni['Credential in commit'],    ni['Critical'],  59],
    [ni['Unverified AI commits'],   ni['Critical'], 584],
    [ni['Repo inactivity spike'],   ni['High'],     238],
    [ni['Code scan vulns'],         ni['High'],    1640],
    [ni['Stale PATs'],              ni['High'],       3],
    [ni['Failed PR checks'],        ni['High'],     231],
    [ni['Build config changes'],    ni['Medium'],   203],
    [ni['OSS vulns'],               ni['Medium'],   343],
  ].map(([s,t,v])=>({source:s,target:t,value:v}));

  const sankeyJSON = JSON.stringify({
    nodes: demoNodes.map(name=>({name})),
    links: demoLinks
  });

  const demo = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Acme Corp — Identity Lifecycle Review</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f2f8; color:#1a1a2e; }
.page { max-width:1140px; margin:0 auto; padding:0 0 60px; }

/* Cover */
.cover { background:linear-gradient(150deg,#050e1f 0%,#0d1e3c 50%,#1550FF 100%); padding:52px 52px 44px; color:#fff; position:relative; overflow:hidden; }
.cover::after { content:''; position:absolute; right:-60px; top:-60px; width:400px; height:400px; background:radial-gradient(circle,rgba(21,80,255,.25) 0%,transparent 70%); pointer-events:none; }
.cover-logo { font-size:11px; font-weight:700; letter-spacing:.18em; text-transform:uppercase; color:rgba(255,255,255,.4); margin-bottom:32px; }
.cover-title { font-size:36px; font-weight:800; line-height:1.15; margin-bottom:8px; }
.cover-sub { font-size:15px; opacity:.55; margin-bottom:36px; font-family:monospace; }
.cover-meta { display:flex; gap:32px; border-top:1px solid rgba(255,255,255,.12); padding-top:20px; }
.cover-meta-item { }
.cover-meta-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; opacity:.4; margin-bottom:3px; }
.cover-meta-val { font-size:14px; font-weight:700; }
.demo-ribbon { background:#ffc107; color:#1a1a2e; font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; padding:4px 14px; border-radius:3px; display:inline-block; margin-bottom:20px; }

/* Body */
.body { padding:0 40px; }

/* Section headers — SLR style */
.sec-header { display:flex; align-items:center; gap:14px; margin:36px 0 16px; }
.sec-num { width:32px; height:32px; border-radius:8px; background:#1550FF; color:#fff; font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.sec-name { font-size:18px; font-weight:800; color:#0d1e3c; }
.sec-desc { font-size:12px; color:#888; margin-bottom:16px; line-height:1.6; }

/* Cards */
.card { background:#fff; border:1px solid #e0e4f0; border-radius:12px; padding:20px 24px; margin-bottom:16px; }
.card-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; color:#aaa; margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid #f0f0f0; }

/* KPI strips */
.kpi-strip { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:20px; }
.kpi-tile { background:#fff; border:1px solid #e0e4f0; border-radius:10px; padding:16px 18px; }
.kpi-tile.accent { border-color:#1550FF; background:#f5f8ff; }
.kpi-val { font-size:28px; font-weight:800; color:#1550FF; font-family:monospace; line-height:1; margin-bottom:4px; }
.kpi-val.red { color:#e05252; }
.kpi-val.amber { color:#e07d22; }
.kpi-val.green { color:#27ae60; }
.kpi-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#aaa; }

/* Exec overview */
.exec-dark { background:linear-gradient(135deg,#0d1e3c,#1a3a6b); border-radius:12px; padding:28px 32px; color:#fff; margin-bottom:16px; }
.exec-dark-title { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.14em; color:rgba(255,255,255,.4); margin-bottom:16px; }
.exec-dark p { font-size:13px; line-height:1.75; color:rgba(255,255,255,.8); margin-bottom:10px; }
.exec-dark strong { color:#fff; }

/* Two-col layout */
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }
.three-col { display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; margin-bottom:16px; }

/* Risk breakdown bars */
.risk-row { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.risk-label { font-size:11px; color:#555; width:220px; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.risk-bar-wrap { flex:1; background:#f0f2f8; border-radius:3px; height:8px; }
.risk-bar-inner { height:8px; border-radius:3px; }
.risk-count { font-family:monospace; font-size:11px; font-weight:700; width:60px; text-align:right; flex-shrink:0; }

/* Identity type badges */
.id-type { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:8px; font-size:11px; font-weight:600; margin:4px; }
.id-type.human { background:#e8f0ff; color:#1550FF; border:1px solid #c0d0ff; }
.id-type.svc { background:#fff8e8; color:#b45309; border:1px solid #fcd34d; }
.id-type.ai { background:#f5f0ff; color:#7c3aed; border:1px solid #d0b0ff; }

/* Callout box */
.callout { border-radius:8px; padding:14px 16px; margin-bottom:12px; display:flex; gap:12px; align-items:flex-start; }
.callout.red { background:#fff5f5; border:1px solid #fecaca; }
.callout.amber { background:#fffbeb; border:1px solid #fde68a; }
.callout.purple { background:#f5f0ff; border:1px solid #ddd6fe; }
.callout.green { background:#f0fdf4; border:1px solid #bbf7d0; }
.callout-icon { font-size:18px; flex-shrink:0; }
.callout-body { font-size:12px; line-height:1.6; color:#444; }
.callout-body strong { color:#1a1a2e; }

/* Benchmark bar */
.benchmark { background:#f8f9ff; border:1px solid #e8ecf8; border-radius:8px; padding:14px 16px; margin-bottom:12px; }
.benchmark-title { font-size:10px; font-weight:700; color:#888; text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; }
.bench-row { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.bench-label { font-size:11px; color:#666; width:140px; flex-shrink:0; }
.bench-bar-wrap { flex:1; background:#eee; border-radius:3px; height:10px; position:relative; }
.bench-bar { height:10px; border-radius:3px; }
.bench-marker { position:absolute; top:-3px; width:2px; height:16px; background:#1550FF; border-radius:1px; }
.bench-val { font-family:monospace; font-size:11px; font-weight:700; width:50px; text-align:right; flex-shrink:0; }

/* Table */
table { width:100%; border-collapse:collapse; font-size:12px; }
th { text-align:left; padding:9px 10px; background:#f8f9ff; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#aaa; border-bottom:2px solid #eee; }
td { padding:9px 10px; border-bottom:1px solid #f5f5f5; vertical-align:top; }
tr:last-child td { border-bottom:none; }
.sev { font-weight:700; font-size:10px; padding:2px 7px; border-radius:4px; display:inline-block; }
.sev.C { background:#fee2e2; color:#dc2626; }
.sev.H { background:#ffedd5; color:#c2410c; }
.sev.M { background:#fef9c3; color:#a16207; }

/* Rec section */
.rec-item { display:flex; gap:14px; padding:14px 0; border-bottom:1px solid #f0f0f0; }
.rec-item:last-child { border-bottom:none; }
.rec-num { width:28px; height:28px; border-radius:7px; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
.rec-body { flex:1; }
.rec-title { font-size:13px; font-weight:700; color:#0d1e3c; margin-bottom:3px; }
.rec-desc { font-size:12px; color:#666; line-height:1.55; }
.rec-meta { font-size:10px; color:#aaa; margin-top:4px; font-family:monospace; }

/* Sankey */
#sankeyChart { overflow:visible; }

/* PDF button */
.pdf-btn { display:inline-flex; align-items:center; gap:8px; background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); color:#fff; font-family:monospace; font-size:11px; font-weight:700; padding:8px 18px; border-radius:6px; cursor:pointer; text-decoration:none; margin-top:20px; transition:background .15s; }
.pdf-btn:hover { background:rgba(255,255,255,.25); }
/* Footer */
.footer-bar { background:#0d1e3c; color:rgba(255,255,255,.4); font-size:10px; padding:16px 40px; display:flex; justify-content:space-between; align-items:center; margin-top:20px; }
/* Print styles */
@media print {
  body { background:#fff; }
  .pdf-btn { display:none; }
  .cover { border-radius:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .exec-dark { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .card, .section { break-inside:avoid; }
  .page { padding:0; }
}
</style>
</head><body>
<div class="page">

<!-- ── COVER ──────────────────────────────────────────────────────────── -->
<div class="cover">
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div class="demo-ribbon">Demo Report</div>
    <a href="/demo-arc/pdf" class="pdf-btn">↓ Download PDF</a>
  </div>
  <div class="cover-logo">BlueFlag Security · Identity Lifecycle Review</div>
  <div class="cover-title">Developer Identity &amp;<br>Agentic AI Risk Assessment</div>
  <div class="cover-sub">Acme Corp · 30-Day Continuous Monitoring Engagement</div>
  <div class="cover-meta">
    <div class="cover-meta-item"><div class="cover-meta-label">Organization</div><div class="cover-meta-val">Acme Corp</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Monitoring Period</div><div class="cover-meta-val">Apr 30 – May 29, 2026</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Total Runs</div><div class="cover-meta-val">30 Daily Scans</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Generated</div><div class="cover-meta-val">${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div></div>
    <div class="cover-meta-item"><div class="cover-meta-label">Prepared By</div><div class="cover-meta-val">BlueFlag Security</div></div>
  </div>
</div>

<div class="body">

<!-- ── SECTION 1: EXECUTIVE SUMMARY ──────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">1</div><div class="sec-name">Executive Summary</div></div>
<p class="sec-desc">A high-level snapshot of Acme Corp's developer identity risk posture over 30 days of continuous monitoring. This section summarizes the key findings and critical actions required.</p>

<div class="kpi-strip">
  <div class="kpi-tile accent"><div class="kpi-val">30</div><div class="kpi-label">Days Monitored</div></div>
  <div class="kpi-tile"><div class="kpi-val red">401</div><div class="kpi-label">Critical Findings</div></div>
  <div class="kpi-tile"><div class="kpi-val amber">847</div><div class="kpi-label">High Findings</div></div>
  <div class="kpi-tile"><div class="kpi-val">12</div><div class="kpi-label">Identities Flagged</div></div>
  <div class="kpi-tile"><div class="kpi-val green">2</div><div class="kpi-label">Resolved</div></div>
</div>

<div class="exec-dark">
  <div class="exec-dark-title">Executive Summary</div>
  <p>Over 30 days of continuous monitoring, BlueFlag Security identified <strong>persistent, unresolved developer identity risks</strong> across Acme Corp's GitHub and Azure DevOps environments. Critical findings have remained stable between 271–321 throughout the engagement, indicating that while threats were flagged early, <strong>remediation actions have not been taken</strong>.</p>
  <p>The most significant finding is <strong>4,821 Terraform misconfigurations</strong> spread across 3 identities — present in every single monitoring run. Left unaddressed, these represent direct pathways to infrastructure compromise. Additionally, BlueFlag detected a <strong>new threat class emerging from AI tooling</strong>: three agentic service accounts (GitHub Copilot, Claude Code, and Lovable) generated 584 unverified configuration changes with no CI enforcement — an attack surface that most organizations are not yet monitoring.</p>
  <p>Two identities were successfully remediated during the engagement, demonstrating that the BlueFlag monitoring signal is actionable and effective when teams engage with findings promptly.</p>
</div>

<div class="callout red">
  <div class="callout-icon">🔴</div>
  <div class="callout-body"><strong>Critical Action Required:</strong> 8 identities have appeared in every monitoring run with no remediation. Terraform misconfigurations (4,821 violations) and branch protection bypasses (312 violations) represent the highest-priority items for immediate attention by the security and engineering teams.</div>
</div>

<!-- ── SECTION 2: RISK FLOW ────────────────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">2</div><div class="sec-name">Risk Flow — Identities → Policies → Severity</div></div>
<p class="sec-desc">The Sankey diagram below maps each flagged identity to the specific policies they violated, and the resulting severity distribution. Wider flows indicate higher violation counts. AI agent identities are highlighted in color.</p>

<div class="card">
  <div class="card-title">Identities → Policies → Severity</div>
  <svg id="sankeyChart" height="420"></svg>
</div>

<!-- ── SECTION 3: EXECUTIVE OVERVIEW ──────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">3</div><div class="sec-name">Executive Overview</div></div>
<p class="sec-desc">Risk direction, benchmarking against comparable development organizations, and identity distribution breakdown.</p>

<div class="exec-dark">
  <div class="exec-dark-title">Risk Context</div>
  <p>Over the 30-day period, critical findings opened at 312 and closed at 284 — a modest 9% improvement driven by the resolution of 2 identities. However, <strong>8 chronic identities remain fully unaddressed</strong>, meaning the underlying risk exposure has not materially improved. Without intervention, the overall picture will worsen as AI tooling continues to expand its footprint in the codebase.</p>
  <p>Three agentic AI service accounts introduced during this period now represent <strong>31% of all critical violations observed</strong> — a proportion that will grow as AI coding tools proliferate across the development team.</p>
</div>

<div class="two-col">
  <div class="card">
    <div class="card-title">Identity Type Distribution</div>
    <div style="margin-bottom:12px">
      <div class="id-type human">👤 Human Developers <strong style="margin-left:6px">5</strong></div>
      <div class="id-type svc">⚙️ Service Accounts <strong style="margin-left:6px">4</strong></div>
      <div class="id-type ai">🤖 Agentic AI Accounts <strong style="margin-left:6px">3</strong></div>
    </div>
    <div style="font-size:11px;color:#888;line-height:1.6">Human developers account for <strong>67%</strong> of critical violations. AI agents, introduced mid-engagement, now contribute <strong>31%</strong> of total critical findings despite being present for less than the full monitoring period.</div>
  </div>
  <div class="card">
    <div class="card-title">Industry Benchmarking — Similar Dev Orgs (500–2,000 developers)</div>
    <div class="benchmark">
      <div class="bench-row">
        <div class="bench-label">Terraform misconfigs</div>
        <div class="bench-bar-wrap"><div class="bench-bar" style="width:95%;background:#e05252"></div><div class="bench-marker" style="left:40%"></div></div>
        <div class="bench-val" style="color:#e05252">4,821</div>
      </div>
      <div class="bench-row">
        <div class="bench-label">Branch protection bypasses</div>
        <div class="bench-bar-wrap"><div class="bench-bar" style="width:70%;background:#e07d22"></div><div class="bench-marker" style="left:30%"></div></div>
        <div class="bench-val" style="color:#e07d22">312</div>
      </div>
      <div class="bench-row">
        <div class="bench-label">Stale write-access PATs</div>
        <div class="bench-bar-wrap"><div class="bench-bar" style="width:45%;background:#f0b429"></div><div class="bench-marker" style="left:50%"></div></div>
        <div class="bench-val" style="color:#f0b429">89</div>
      </div>
      <div style="font-size:9px;color:#aaa;margin-top:8px">Blue marker = industry peer average. Acme Corp is above peer average on infrastructure risk.</div>
    </div>
  </div>
</div>

<!-- ── SECTION 4: INFRASTRUCTURE & CODE SECURITY ──────────────────────── -->
<div class="sec-header"><div class="sec-num">4</div><div class="sec-name">Infrastructure &amp; Code Security</div></div>
<p class="sec-desc">Findings related to Terraform misconfiguration, code vulnerability scanning, and CI/CD pipeline integrity. This category produced the highest total violation count of the engagement.</p>

<div class="card">
  <div class="card-title">Policy Violation Volume — Infrastructure Category</div>
  <div class="risk-row"><div class="risk-label">Terraform files with critical/high misconfigurations</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:100%;background:#e05252"></div></div><div class="risk-count" style="color:#e05252">4,821</div></div>
  <div class="risk-row"><div class="risk-label">Code scans with critical/high vulnerabilities</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:34%;background:#e07d22"></div></div><div class="risk-count" style="color:#e07d22">1,640</div></div>
  <div class="risk-row"><div class="risk-label">Merged PRs with check run failures</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:5%;background:#e07d22"></div></div><div class="risk-count" style="color:#e07d22">231</div></div>
  <div class="risk-row"><div class="risk-label">Unverified build configuration changes</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:9%;background:#f0b429"></div></div><div class="risk-count" style="color:#f0b429">787</div></div>
</div>

<div class="callout amber">
  <div class="callout-icon">⚠️</div>
  <div class="callout-body"><strong>Key Finding:</strong> autobot-ci logged 1,405 code scan violations across all 30 runs — every daily scan flagged this CI/CD service account. This suggests the pipeline is deploying code with known vulnerabilities without automated blocking gates in place.</div>
</div>

<!-- ── SECTION 5: CREDENTIAL & ACCESS RISK ────────────────────────────── -->
<div class="sec-header"><div class="sec-num">5</div><div class="sec-name">Credential &amp; Access Risk</div></div>
<p class="sec-desc">Findings related to exposed secrets, over-privileged access, stale tokens, and branch protection enforcement. These represent direct pathways for unauthorized access or lateral movement.</p>

<div class="two-col">
  <div class="card">
    <div class="card-title">Credential Exposure</div>
    <div class="risk-row"><div class="risk-label">Credential in code commit</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:100%;background:#e05252"></div></div><div class="risk-count" style="color:#e05252">59</div></div>
    <div class="risk-row"><div class="risk-label">Branch protection bypassed</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:100%;background:#e05252"></div></div><div class="risk-count" style="color:#e05252">76</div></div>
    <div class="risk-row"><div class="risk-label">Stale write-access PATs</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:62%;background:#e07d22"></div></div><div class="risk-count" style="color:#e07d22">89</div></div>
    <div class="risk-row"><div class="risk-label">PRs approved with no commit history</div><div class="risk-bar-wrap"><div class="risk-bar-inner" style="width:43%;background:#f0b429"></div></div><div class="risk-count" style="color:#f0b429">31</div></div>
  </div>
  <div class="card">
    <div class="card-title">Notable Identity — k.patel_acme</div>
    <div style="font-size:12px;line-height:1.7;color:#555">
      <p><strong>k.patel_acme</strong> holds <strong>admin permissions across 3 repositories</strong> and bypassed branch protection on 22 occasions. This identity also has a personal access token with write access that has been inactive for 30+ days — a dormant credential that represents an easy target for attackers.</p>
      <p style="margin-top:8px">Combined with PR approval patterns (3 PRs merged without prior commit history on record), this identity presents a high insider-risk and credential-theft surface.</p>
    </div>
  </div>
</div>

<!-- ── SECTION 6: AGENTIC AI ACTIVITY ────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">6</div><div class="sec-name">Agentic AI Activity — Emerging Threat Vector</div></div>
<p class="sec-desc">Three AI coding tools were detected operating as autonomous service accounts within Acme Corp's repositories during this engagement. This section details their activity patterns and policy violations — a threat class most organizations are not yet monitoring.</p>

<div class="callout purple">
  <div class="callout-icon">🤖</div>
  <div class="callout-body"><strong>What is agentic AI risk?</strong> When AI coding tools (GitHub Copilot, Claude Code, Lovable, etc.) are granted repository write access, they operate as autonomous identities — committing code, merging pull requests, and modifying configuration files without human-in-the-loop review. BlueFlag monitors these service accounts the same way it monitors human developers, surfacing violations that standard SIEM tools miss.</div>
</div>

<div class="three-col">
  <div class="card" style="border-top:3px solid #1550FF">
    <div class="card-title">🤖 copilot-bot — GitHub Copilot</div>
    <div style="font-size:22px;font-weight:800;color:#e05252;margin-bottom:4px">Critical</div>
    <div style="font-size:10px;color:#aaa;margin-bottom:12px">30/30 runs · First detected: Apr 30</div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Unverified config commits</div><div class="risk-count" style="color:#e05252">312</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Failed PR check runs</div><div class="risk-count" style="color:#e07d22">44</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">OSS high vulns imported</div><div class="risk-count" style="color:#f0b429">89</div></div>
  </div>
  <div class="card" style="border-top:3px solid #7c3aed">
    <div class="card-title">🤖 claude-code-svc — Claude Code</div>
    <div style="font-size:22px;font-weight:800;color:#e05252;margin-bottom:4px">Critical</div>
    <div style="font-size:10px;color:#aaa;margin-bottom:12px">30/30 runs · First detected: Apr 30</div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Unverified config commits</div><div class="risk-count" style="color:#e05252">178</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Terraform misconfigurations</div><div class="risk-count" style="color:#e05252">203</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Credential in commit</div><div class="risk-count" style="color:#e05252">12</div></div>
  </div>
  <div class="card" style="border-top:3px solid #c2410c">
    <div class="card-title">🤖 lovable-bot — Lovable AI</div>
    <div style="font-size:22px;font-weight:800;color:#e07d22;margin-bottom:4px">High</div>
    <div style="font-size:10px;color:#aaa;margin-bottom:12px">28/30 runs · First detected: May 1</div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Unverified config commits</div><div class="risk-count" style="color:#e05252">94</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">OSS high vulns imported</div><div class="risk-count" style="color:#e07d22">156</div></div>
    <div class="risk-row"><div class="risk-label" style="width:auto;flex:1">Failed PR check runs</div><div class="risk-count" style="color:#e07d22">31</div></div>
  </div>
</div>

<!-- ── SECTION 7: BEHAVIORAL ANOMALIES ───────────────────────────────── -->
<div class="sec-header"><div class="sec-num">7</div><div class="sec-name">Behavioral Anomalies</div></div>
<p class="sec-desc">Unusual activity patterns detected across identities — including repository activity spikes, inactivity followed by sudden bursts, and open source package risk introduced into the codebase.</p>

<div class="two-col">
  <div class="card">
    <div class="card-title">Notable Behavioral Findings</div>
    <table>
      <thead><tr><th>Identity</th><th>Finding</th><th>Sev</th><th>Count</th></tr></thead>
      <tbody>
        <tr><td style="font-family:monospace;font-size:11px">svc-deploy-prod</td><td>Suspicious activity after long repo inactivity</td><td><span class="sev H">High</span></td><td style="font-family:monospace">238</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">svc-deploy-prod</td><td>Suspicious spike on new repositories</td><td><span class="sev H">High</span></td><td style="font-family:monospace">14</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">t.okafor_acme</td><td>OSS packages with high vulnerabilities</td><td><span class="sev M">Med</span></td><td style="font-family:monospace">98</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">j.martinez_acme</td><td>OSS packages with high vulnerabilities</td><td><span class="sev M">Med</span></td><td style="font-family:monospace">314</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">contractor_42</td><td>PRs approved — no prior commit history</td><td><span class="sev M">Med</span></td><td style="font-family:monospace">31</td></tr>
      </tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-title">30-Day Risk Trend</div>
    <table>
      <thead><tr><th>Date</th><th>Critical</th><th>Δ</th><th>Active IDs</th></tr></thead>
      <tbody>
        <tr><td style="font-family:monospace;font-size:11px">2026-04-30</td><td style="color:#e05252;font-weight:700">312</td><td style="color:#aaa">—</td><td>9</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">2026-05-07</td><td style="color:#e05252;font-weight:700">315</td><td style="color:#e05252">▲3</td><td>9</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">2026-05-14</td><td style="color:#e05252;font-weight:700">288</td><td style="color:#27ae60">▼27</td><td>8</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">2026-05-21</td><td style="color:#e05252;font-weight:700">284</td><td style="color:#27ae60">▼4</td><td>9</td></tr>
        <tr><td style="font-family:monospace;font-size:11px">2026-05-29</td><td style="color:#e05252;font-weight:700">284</td><td style="color:#aaa">→</td><td>9</td></tr>
      </tbody>
    </table>
    <div style="font-size:11px;color:#888;margin-top:10px">Overall trend: <strong style="color:#f39c12">Stable</strong>. Two resolutions (May 14) drove the single meaningful drop. No subsequent remediations observed.</div>
  </div>
</div>

<!-- ── SECTION 8: FULL FINDINGS TABLE ─────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">8</div><div class="sec-name">Complete Findings</div></div>
<p class="sec-desc">All policy violations observed during the engagement, sorted by severity and total violation count.</p>

<div class="card">
  <table>
    <thead><tr><th>Policy</th><th>Sev</th><th>Violations</th><th>Identities</th><th>Runs</th><th>First</th><th>Last</th></tr></thead>
    <tbody>
      <tr><td style="font-weight:600">Terraform files with critical or high misconfigurations</td><td><span class="sev C">Critical</span></td><td style="font-family:monospace;font-weight:700">4,821</td><td style="font-size:11px;color:#666">j.martinez, svc-deploy, t.okafor</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr style="background:#fafafe"><td style="font-weight:600">🤖 Unverified build config changes — AI origin</td><td><span class="sev C">Critical</span></td><td style="font-family:monospace;font-weight:700">584</td><td style="font-size:11px;color:#7c3aed">copilot-bot, claude-code-svc, lovable-bot</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">Branch protection bypassed by administrators</td><td><span class="sev C">Critical</span></td><td style="font-family:monospace;font-weight:700">312</td><td style="font-size:11px;color:#666">j.martinez, k.patel</td><td style="font-family:monospace">28/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr style="background:#fafafe"><td style="font-weight:600">🤖 Terraform misconfigs — AI origin (claude-code-svc)</td><td><span class="sev C">Critical</span></td><td style="font-family:monospace;font-weight:700">203</td><td style="font-size:11px;color:#7c3aed">claude-code-svc</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">Credential detected in code commit</td><td><span class="sev C">Critical</span></td><td style="font-family:monospace;font-weight:700">59</td><td style="font-size:11px;color:#666">r.chen, t.okafor, claude-code-svc</td><td style="font-family:monospace">12/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 3</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 27</td></tr>
      <tr><td style="font-weight:600">Code scans with critical/high vulnerabilities</td><td><span class="sev H">High</span></td><td style="font-family:monospace;font-weight:700">1,640</td><td style="font-size:11px;color:#666">autobot-ci, j.martinez +2</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">Suspicious repo activity after long inactivity</td><td><span class="sev H">High</span></td><td style="font-family:monospace;font-weight:700">238</td><td style="font-size:11px;color:#666">svc-deploy-prod</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">Merged PRs with check run failures</td><td><span class="sev H">High</span></td><td style="font-family:monospace;font-weight:700">231</td><td style="font-size:11px;color:#666">j.martinez, k.patel, copilot-bot, lovable-bot</td><td style="font-family:monospace">22/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 1</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">Personal access tokens inactive 30+ days (write)</td><td><span class="sev H">High</span></td><td style="font-family:monospace;font-weight:700">89</td><td style="font-size:11px;color:#666">k.patel, contractor_42 +3</td><td style="font-family:monospace">25/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 24</td></tr>
      <tr><td style="font-weight:600">OSS packages with high vulnerabilities</td><td><span class="sev M">Med</span></td><td style="font-family:monospace;font-weight:700">588</td><td style="font-size:11px;color:#666">j.martinez, t.okafor, copilot-bot, lovable-bot</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
      <tr><td style="font-weight:600">PRs approved by users with no prior commit history</td><td><span class="sev M">Med</span></td><td style="font-family:monospace;font-weight:700">31</td><td style="font-size:11px;color:#666">contractor_42</td><td style="font-family:monospace">14/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 2</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 19</td></tr>
      <tr><td style="font-weight:600">Identities with multiple risky policy violations</td><td><span class="sev M">Med</span></td><td style="font-family:monospace;font-weight:700">12</td><td style="font-size:11px;color:#666">All flagged identities</td><td style="font-family:monospace">30/30</td><td style="font-family:monospace;font-size:10px;color:#aaa">Apr 30</td><td style="font-family:monospace;font-size:10px;color:#aaa">May 29</td></tr>
    </tbody>
  </table>
</div>

<!-- ── SECTION 9: RECOMMENDATIONS ────────────────────────────────────── -->
<div class="sec-header"><div class="sec-num">9</div><div class="sec-name">Recommendations</div></div>
<p class="sec-desc">Prioritized remediation actions based on risk severity and likelihood of exploitation. Each recommendation targets a specific finding category observed during this engagement.</p>

<div class="card">
  <div class="rec-item">
    <div class="rec-num" style="background:#fee2e2;color:#dc2626">1</div>
    <div class="rec-body">
      <div class="rec-title">Remediate Terraform Misconfigurations Immediately</div>
      <div class="rec-desc">4,821 Terraform violations across j.martinez_acme, svc-deploy-prod, and t.okafor_acme represent the single highest-volume critical finding. Assign ownership to the infrastructure team and establish a mandatory IaC scan gate before any Terraform plan is applied. Target: full resolution within 14 days.</div>
      <div class="rec-meta">Policies: Terraform files with critical or high misconfigurations · Affected: 3 identities · Violations: 4,821</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num" style="background:#fee2e2;color:#dc2626">2</div>
    <div class="rec-body">
      <div class="rec-title">Establish Governance Framework for Agentic AI Tools</div>
      <div class="rec-desc">copilot-bot, claude-code-svc, and lovable-bot are operating with write access and no CI enforcement gate. Immediately audit all AI service account permissions, enforce signed commit requirements, and block PR merges from AI accounts unless a human reviewer has approved the changes. This is an emerging attack surface with no current controls.</div>
      <div class="rec-meta">Policies: Unverified commit changes, Credential in commit (AI), Failed PR checks · Affected: 3 AI accounts · Violations: 671</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num" style="background:#ffedd5;color:#c2410c">3</div>
    <div class="rec-body">
      <div class="rec-title">Revoke Stale Personal Access Tokens</div>
      <div class="rec-desc">89 stale write-access PATs identified across 5+ identities. Dormant credentials with write access are a primary vector for account takeover — attackers acquire old tokens via phishing or credential dumps and use them long after the owner has forgotten they exist. Implement a quarterly PAT rotation policy and revoke all tokens inactive for 30+ days within 7 days.</div>
      <div class="rec-meta">Policy: Personal access tokens with write access inactive 30+ days · Affected: k.patel, contractor_42 +3</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num" style="background:#ffedd5;color:#c2410c">4</div>
    <div class="rec-body">
      <div class="rec-title">Enforce Branch Protection Across All Repositories</div>
      <div class="rec-desc">312 branch protection bypasses by j.martinez_acme and k.patel_acme indicate that administrators are routinely circumventing the one control that prevents unauthorized code from reaching production. Enforce non-bypassable branch protection rules at the organization level and require audit logs for any exception requests.</div>
      <div class="rec-meta">Policy: Branch protection bypassed by administrators · Affected: j.martinez, k.patel · Violations: 312</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num" style="background:#fef9c3;color:#a16207">5</div>
    <div class="rec-body">
      <div class="rec-title">Address Open Source Vulnerability Debt</div>
      <div class="rec-desc">588 OSS high-vulnerability violations observed — many introduced by AI tools importing dependencies without review. Integrate SCA (Software Composition Analysis) blocking into the CI pipeline and establish a process for upgrading dependencies flagged with CVSS ≥ 7.0 within 30 days of detection.</div>
      <div class="rec-meta">Policy: Open source packages with high vulnerabilities · Affected: j.martinez, t.okafor, copilot-bot, lovable-bot</div>
    </div>
  </div>
  <div class="rec-item">
    <div class="rec-num" style="background:#f0fdf4;color:#15803d">6</div>
    <div class="rec-body">
      <div class="rec-title">Continue Monitoring — Expand Coverage</div>
      <div class="rec-desc">Two identities (r.chen_acme, contractor_42) were successfully resolved during this engagement, demonstrating the value of continuous monitoring. Expand coverage to include all developer identities, enforce daily alerting, and establish a SLA for responding to new Critical findings within 72 hours. Consider extending monitoring to pre-production and staging environments.</div>
      <div class="rec-meta">Resolved this period: r.chen_acme, contractor_42 · Remaining chronic: 8 identities</div>
    </div>
  </div>
</div>

</div><!-- /body -->

<div class="footer-bar">
  <span>BlueFlag Security · Identity Lifecycle Review · DEMO — Fictional company, real BlueFlag policy data</span>
  <span>Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span>
</div>
</div><!-- /page -->

<script>
(function() {
  const raw = ${sankeyJSON};
  const svg = d3.select('#sankeyChart');
  const W = svg.node().parentElement.clientWidth - 48;
  const H = 420;
  svg.attr('width', W).attr('height', H).style('overflow','visible');
  const sk = d3.sankey().nodeWidth(14).nodePadding(5).extent([[1,4],[W-140,H-4]]);
  let { nodes, links } = sk({ nodes: raw.nodes.map(d=>({...d})), links: raw.links.map(d=>({...d})) });
  const maxX = Math.max(...nodes.map(n=>n.x0));
  const minX = Math.min(...nodes.map(n=>n.x0));
  const aiNames = new Set(['copilot-bot','claude-code-svc','lovable-bot']);
  const color = n => {
    if (n.name==='Critical') return '#e05252';
    if (n.name==='High')     return '#e07d22';
    if (n.name==='Medium')   return '#f0b429';
    if (n.name==='copilot-bot')     return '#1550FF';
    if (n.name==='claude-code-svc') return '#7c3aed';
    if (n.name==='lovable-bot')     return '#c2410c';
    if (n.x0 === minX) return '#1a3a6b';
    return '#6b7db3';
  };
  svg.append('g').selectAll('rect').data(nodes).join('rect')
    .attr('x',d=>d.x0).attr('y',d=>d.y0).attr('width',d=>d.x1-d.x0).attr('height',d=>Math.max(2,d.y1-d.y0))
    .attr('fill',color).attr('rx',3).attr('opacity',.9);
  svg.append('g').attr('fill','none').selectAll('path').data(links).join('path')
    .attr('d',d3.sankeyLinkHorizontal()).attr('stroke',d=>color(d.target))
    .attr('stroke-width',d=>Math.max(1,d.width)).attr('opacity',.2);
  svg.append('g').selectAll('text').data(nodes).join('text')
    .attr('x',d=>d.x0===minX?d.x1+6:d.x0===maxX?d.x1+6:d.x0-6)
    .attr('y',d=>(d.y0+d.y1)/2).attr('dy','0.35em')
    .attr('text-anchor',d=>d.x0===minX||d.x0===maxX?'start':'end')
    .attr('font-size',9).attr('font-family','monospace')
    .attr('fill',d=>color(d)).attr('font-weight',d=>aiNames.has(d.name)?'700':'400')
    .text(d=>d.name);
})();
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(demo);
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

// ── PDF Export — server-side render via Playwright ───────────────────────────
// Playwright is already installed for scraping, so we reuse it here.
// The page is loaded internally, D3 is given time to paint, then PDF is captured.
async function renderPDF(url, filename, res) {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // let D3 finish rendering
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (e) {
    res.status(500).send(`PDF generation failed: ${e.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

app.get('/demo-arc/pdf', (req, res) => {
  renderPDF(`http://localhost:${3737}/demo-arc`, `identity-lifecycle-review-demo-${new Date().toISOString().slice(0,10)}.pdf`, res);
});

app.get('/api/arc/:id/pdf', (req, res) => {
  const cfg = readConfig();
  const tenant = (cfg.tenants||[]).find(t=>t.id===req.params.id);
  const name = tenant ? tenant.name.toLowerCase().replace(/[^a-z0-9]/g,'-') : req.params.id;
  renderPDF(`http://localhost:${3737}/api/arc/${req.params.id}`, `${name}-identity-lifecycle-review-${new Date().toISOString().slice(0,10)}.pdf`, res);
});

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

    // ── Actor persistence — how many previous runs has each actor appeared in? ──
    const actorPersistence = (() => {
      const histDir = path.join(snapDir, 'history', tenantId);
      if (!fs.existsSync(histDir)) return {};
      const todayStr = new Date().toISOString().slice(0, 10);
      const files = fs.readdirSync(histDir)
        .filter(f => f.endsWith('.json') && f.slice(0, 10) !== todayStr)
        .sort();
      if (!files.length) return {};
      const totalRuns = files.length;
      const counts = {};
      const firstSeen = {};
      for (const f of files) {
        try {
          const h = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
          const date = f.slice(0, 10);
          const actors = new Set([
            ...(h.behaviors||[]).map(b => b.user).filter(Boolean),
            ...Object.keys(h.identities||{})
          ]);
          for (const actor of actors) {
            counts[actor] = (counts[actor] || 0) + 1;
            if (!firstSeen[actor]) firstSeen[actor] = date;
          }
        } catch {}
      }
      return { counts, firstSeen, totalRuns };
    })();

    const persistenceLines = (() => {
      if (!actorPersistence.counts) return '';
      const { counts, firstSeen, totalRuns } = actorPersistence;
      const todayActors = [
        ...(snap?.behaviors||[]).map(b => b.user),
        ...Object.keys(snap?.identities||{})
      ].filter(Boolean);
      const seen = new Set(todayActors);
      const lines = [];
      for (const actor of seen) {
        const n = counts[actor] || 0;
        if (n === 0) {
          lines.push(`- ${actor}: NEW — first appearance today`);
        } else if (n >= totalRuns) {
          lines.push(`- ${actor}: CHRONIC — present in all ${totalRuns} previous run(s) (since ${firstSeen[actor]})`);
        } else {
          lines.push(`- ${actor}: seen in ${n} of ${totalRuns} previous run(s) (first: ${firstSeen[actor]})`);
        }
      }
      return lines.join('\n');
    })();

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
${persistenceLines ? `\nACTOR PERSISTENCE (how long we have been seeing each actor across monitoring runs):\n${persistenceLines}` : ''}
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
- If there is a very large clone count, mention it plainly and connect it to why it matters.
- If any actors are marked CHRONIC, weave that persistence into the narrative — it strengthens urgency without overstating.
- If actors are NEW, note that this is a fresh signal worth validating quickly.`;

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
