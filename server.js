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
  const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };

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

  // Chart data for D3
  const chartData = JSON.stringify(runs.map(r=>({ date: r.date, crit: r.crit, high: r.high })));

  // Sankey data from latest snapshot
  const sankeyData = (() => {
    if (!latestSnap?.risk) return null;
    const nodes = [], links = [];
    const cats = Object.entries(latestSnap.risk).filter(([,r])=>r&&(r.critical||r.high));
    const tenantIdx = 0;
    nodes.push({ name: tenant.name });
    cats.forEach(([cat], i) => nodes.push({ name: cat.replace(' Risk','') }));
    nodes.push({ name: 'Critical' }, { name: 'High' });
    const critIdx = nodes.length - 2, highIdx = nodes.length - 1;
    cats.forEach(([cat, r], i) => {
      if (r.critical) links.push({ source: 0, target: i+1, value: r.critical });
      if (r.high)     links.push({ source: 0, target: i+1, value: r.high });
      if (r.critical) links.push({ source: i+1, target: critIdx, value: r.critical });
      if (r.high)     links.push({ source: i+1, target: highIdx, value: r.high });
    });
    return JSON.stringify({ nodes, links });
  })();

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${tenant.name} — BlueFlag Security Engagement Arc</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9ff; color: #1a1a2e; }
  .page { max-width: 1100px; margin: 0 auto; padding: 40px 32px 60px; }

  /* Header */
  .header { background: linear-gradient(135deg, #0d1e3c 0%, #1550FF 100%); border-radius: 12px; padding: 32px 36px; margin-bottom: 28px; color: #fff; display: flex; justify-content: space-between; align-items: flex-end; }
  .header-left h1 { font-size: 26px; font-weight: 800; margin-bottom: 4px; }
  .header-left .sub { font-size: 13px; opacity: .65; font-family: monospace; }
  .header-right { text-align: right; }
  .trend-badge { font-size: 18px; font-weight: 800; color: ${trendColor}; background: rgba(255,255,255,.12); padding: 8px 16px; border-radius: 8px; }
  .trend-label { font-size: 10px; opacity: .6; text-transform: uppercase; letter-spacing: .1em; margin-top: 4px; }

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
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }

  /* Charts */
  #trendChart { width: 100%; }
  #sankeyChart { width: 100%; }
  .chart-line-crit { fill: none; stroke: #e05252; stroke-width: 2.5; }
  .chart-line-high { fill: none; stroke: #e07d22; stroke-width: 2; stroke-dasharray: 4 2; }
  .chart-area-crit { fill: rgba(224,82,82,.1); }
  .chart-area-high { fill: rgba(224,125,34,.07); }
  .axis text { font-size: 10px; fill: #999; font-family: monospace; }
  .axis line, .axis path { stroke: #eee; }
  .grid line { stroke: #f0f0f0; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #666; margin-right: 16px; }
  .legend-dot { width: 10px; height: 3px; border-radius: 2px; }

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

  /* Footer */
  .footer { text-align: center; font-size: 11px; color: #bbb; margin-top: 32px; padding-top: 20px; border-top: 1px solid #eee; }
</style>
</head><body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>${tenant.name} — Security Engagement Arc</h1>
      <div class="sub">${tenant.url} · BlueFlag Security · Generated ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}</div>
    </div>
    <div class="header-right">
      <div class="trend-badge">${trend}</div>
      <div class="trend-label" style="color:rgba(255,255,255,.5)">Risk Trajectory</div>
    </div>
  </div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi"><div class="kpi-val">${engagementDays}</div><div class="kpi-label">Days Monitored</div></div>
    <div class="kpi"><div class="kpi-val">${runs.length}</div><div class="kpi-label">Monitoring Runs</div></div>
    <div class="kpi"><div class="kpi-val red">${lastRun.crit.toLocaleString()}</div><div class="kpi-label">Critical (Latest)</div></div>
    <div class="kpi"><div class="kpi-val">${Object.keys(actorTimeline).length}</div><div class="kpi-label">Unique Actors</div></div>
    <div class="kpi"><div class="kpi-val ${resolved.length ? 'green' : ''}">${resolved.length}</div><div class="kpi-label">Resolved Actors</div></div>
  </div>

  <!-- Charts side by side -->
  <div class="two-col">
    <div class="section">
      <div class="section-title">Risk Trend — Critical &amp; High Over Time</div>
      <div style="margin-bottom:10px">
        <span class="legend-item"><span class="legend-dot" style="background:#e05252"></span>Critical</span>
        <span class="legend-item"><span class="legend-dot" style="background:#e07d22"></span>High</span>
      </div>
      <svg id="trendChart" height="200"></svg>
    </div>
    <div class="section">
      <div class="section-title">Current Risk Flow — Categories → Severity</div>
      <svg id="sankeyChart" height="200"></svg>
    </div>
  </div>

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

  <div class="section">
    <div class="section-title">All Actors Observed During Engagement</div>
    <div class="actor-grid">
      ${Object.entries(actorTimeline).sort((a,b)=>b[1].count-a[1].count).map(([name,v])=>`
        <div class="actor-card">
          <div class="actor-name">${name}</div>
          <div class="actor-meta">First: ${v.first} · Last: ${v.last}</div>
          <div class="actor-bar"><div class="actor-bar-fill" style="width:${Math.round(v.count/runs.length*100)}%"></div></div>
          <div class="actor-meta" style="margin-top:4px">${v.count} / ${runs.length} runs</div>
        </div>`).join('')}
    </div>
  </div>

  <div class="footer">BlueFlag Security Threat Dashboard · Confidential · ${tenant.url}</div>
</div>

<script>
// ── Trend Chart ──────────────────────────────────────────────────
(function() {
  const data = ${chartData};
  if (data.length < 2) return;
  const svg = d3.select('#trendChart');
  const W = svg.node().parentElement.clientWidth - 48;
  const H = 200, pad = { t:10, r:10, b:30, l:45 };
  svg.attr('width', W).attr('height', H);
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  const g = svg.append('g').attr('transform', \`translate(\${pad.l},\${pad.t})\`);

  const dates = data.map(d => new Date(d.date));
  const x = d3.scaleTime().domain(d3.extent(dates)).range([0, w]);
  const maxY = d3.max(data, d => Math.max(d.crit, d.high)) * 1.1 || 10;
  const y = d3.scaleLinear().domain([0, maxY]).range([h, 0]);

  // Grid
  g.append('g').attr('class','grid').call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(''));

  // Areas
  const areaCrit = d3.area().x((_,i)=>x(dates[i])).y0(h).y1(d=>y(d.crit)).curve(d3.curveMonotoneX);
  const areaHigh = d3.area().x((_,i)=>x(dates[i])).y0(h).y1(d=>y(d.high)).curve(d3.curveMonotoneX);
  g.append('path').datum(data).attr('class','chart-area-high').attr('d',areaHigh);
  g.append('path').datum(data).attr('class','chart-area-crit').attr('d',areaCrit);

  // Lines
  const lineCrit = d3.line().x((_,i)=>x(dates[i])).y(d=>y(d.crit)).curve(d3.curveMonotoneX);
  const lineHigh = d3.line().x((_,i)=>x(dates[i])).y(d=>y(d.high)).curve(d3.curveMonotoneX);
  g.append('path').datum(data).attr('class','chart-line-high').attr('d',lineHigh);
  g.append('path').datum(data).attr('class','chart-line-crit').attr('d',lineCrit);

  // Axes
  g.append('g').attr('class','axis').attr('transform',\`translate(0,\${h})\`).call(d3.axisBottom(x).ticks(Math.min(data.length,6)).tickFormat(d3.timeFormat('%b %d')));
  g.append('g').attr('class','axis').call(d3.axisLeft(y).ticks(4).tickFormat(d3.format(',d')));
})();

// ── Sankey Chart ─────────────────────────────────────────────────
(function() {
  const raw = ${sankeyData || 'null'};
  if (!raw || !raw.nodes.length) return;
  const svg = d3.select('#sankeyChart');
  const W = svg.node().parentElement.clientWidth - 48;
  const H = 200;
  svg.attr('width', W).attr('height', H);

  const sk = d3.sankey().nodeWidth(14).nodePadding(8).extent([[1,4],[W-80,H-4]]);
  let { nodes, links } = sk({ nodes: raw.nodes.map(d=>({...d})), links: raw.links.map(d=>({...d})) });

  const color = n => {
    if (n.name==='Critical') return '#e05252';
    if (n.name==='High')     return '#e07d22';
    return '#1550FF';
  };

  svg.append('g').selectAll('rect').data(nodes).join('rect')
    .attr('x',d=>d.x0).attr('y',d=>d.y0).attr('width',d=>d.x1-d.x0).attr('height',d=>Math.max(1,d.y1-d.y0))
    .attr('fill',color).attr('rx',3).attr('opacity',.85);

  svg.append('g').attr('fill','none').selectAll('path').data(links).join('path')
    .attr('d',d3.sankeyLinkHorizontal()).attr('stroke',d=>color(nodes[d.target.index||d.target]))
    .attr('stroke-width',d=>Math.max(1,d.width)).attr('opacity',.25);

  svg.append('g').selectAll('text').data(nodes).join('text')
    .attr('x',d=>d.x0<W/2?d.x1+6:d.x0-6).attr('y',d=>(d.y0+d.y1)/2).attr('dy','0.35em')
    .attr('text-anchor',d=>d.x0<W/2?'start':'end')
    .attr('font-size',10).attr('font-family','monospace').attr('fill','#555').text(d=>d.name);
})();
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-arc-${new Date().toISOString().slice(0,10)}.html"`);
  res.send(html);
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
