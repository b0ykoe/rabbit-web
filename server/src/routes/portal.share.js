//
// portal.share.js — public landing page for share URLs.
//
// v0.17.1: proper preview. The page shows share METADATA so a visitor can
// tell what they're about to import before opening the bot:
//   • share name, created date, source server (when stamped)
//   • the contained tabs with friendly labels + per-tab key counts
//   • for Plans: each plan's name, step count and loop flag
//
// Deliberately NOT shown: any actual config values — no coordinates, no
// step contents, no item/skill ids. Plan names are sender-chosen labels on
// a link the sender chose to publish, so they are fair game; everything
// below that stays bot-side (authenticated import preview).
//
// Deactivated shares render as 404, matching the bot API's behaviour.
//

import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Friendly labels for the key namespaces the bot exports. Mirrors
// Bot/inject/config/exportable_tabs.h — LENIENT: unknown prefixes render as
// their raw namespace, so a newer bot's shares still preview fine.
const TAB_LABELS = {
  combo:           'Combo',
  training:        'Training',
  plan_runner:     'Plans',
  skills:          'Skills',
  inventory:       'Inventory',
  buffs:           'Buffs',
  consumables:     'Consumables',
  travel_training: 'Training places',
  auto_sell:       'Auto-Sell',
  auto_buy:        'Auto-Buy',
  drops:           'Drops',
  monsters:        'Monsters',
  party_manager:   'Party',
  no_killsteal:    'No-Killsteal',
  teleport:        'Teleport bookmarks',
  options:         'Options',
  security:        'Security',
};

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${esc(title)} — Rabbit Config Share</title>
  <style>
    :root {
      --bg:        #0f1014;
      --card:      #181a21;
      --border:    #262934;
      --text:      #e0e3ec;
      --text-dim:  #8a8f9d;
      --accent:    #4de680;
      --warn:      #f0c040;
      --frame:     #0f1117;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 32px 16px;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 { margin: 0 0 4px; font-size: 22px; font-weight: 600; color: var(--text); }
    .sub { color: var(--text-dim); font-size: 13px; margin: 0 0 20px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    .chip {
      display: inline-block; padding: 3px 10px; border-radius: 999px;
      background: var(--frame); border: 1px solid var(--border);
      color: var(--text-dim); font-size: 12px;
    }
    .chip strong { color: var(--text); font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left; color: var(--text-dim); font-weight: 500;
      padding: 6px 8px; border-bottom: 1px solid var(--border);
      font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
    }
    td { padding: 7px 8px; border-bottom: 1px solid var(--frame); }
    td.num { text-align: right; color: var(--text-dim); font-variant-numeric: tabular-nums; }
    .tag {
      display: inline-block; padding: 1px 7px; border-radius: 4px;
      background: var(--frame); border: 1px solid var(--border);
      color: var(--text-dim); font-size: 11px; margin-left: 6px;
    }
    h2 {
      margin: 0 0 10px; font-size: 13px; font-weight: 600;
      color: var(--text-dim); text-transform: uppercase; letter-spacing: .05em;
    }
    .url-row { display: flex; gap: 8px; }
    .url-row input {
      flex: 1; min-width: 0;
      background: var(--frame); color: var(--text);
      border: 1px solid var(--border);
      padding: 9px 11px; border-radius: 6px;
      font: inherit; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 13px;
    }
    .url-row button {
      background: var(--accent); color: #0a1010;
      border: 0; padding: 9px 16px; border-radius: 6px;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .url-row button:hover { filter: brightness(1.07); }
    ol { margin: 0; padding-left: 18px; color: var(--text-dim); }
    ol li { padding: 3px 0; }
    ol strong { color: var(--text); }
    .err { text-align: center; padding: 64px 16px; color: var(--text-dim); }
    .err h1 { color: var(--text); }
    .note { color: var(--text-dim); font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="wrap">${bodyHtml}</div>
</body>
</html>`;
}

function renderError(code, msg) {
  return shell('Not found', `
    <div class="err">
      <h1>${esc(String(code))}</h1>
      <p>${esc(msg)}</p>
    </div>`);
}

// ── Preview extraction (metadata only — see file header) ────────────────────

function parseEnvelope(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

// Count steps in the bot's EncodeSteps CSV. Records are comma-separated and
// the label field %XX-escapes ','/':' — a plain comma count is exact.
function countSteps(csv) {
  if (typeof csv !== 'string' || csv.length === 0) return 0;
  let n = 1;
  for (const c of csv) if (c === ',') n++;
  return n;
}

// Pull { name, steps, loop } per plan out of the flat KV
// (plan_runner.count + plan_runner.p<i>_name/_loop/_steps).
function extractPlans(data) {
  if (!data || typeof data !== 'object') return [];
  const count = Number(data['plan_runner.count']) || 0;
  const out = [];
  for (let i = 0; i < count && i < 512; i++) {
    const base = `plan_runner.p${i}_`;
    out.push({
      name:  typeof data[base + 'name'] === 'string' ? data[base + 'name'] : `Plan ${i + 1}`,
      steps: countSteps(data[base + 'steps']),
      loop:  data[base + 'loop'] === true || data[base + 'loop'] === 1,
    });
  }
  return out;
}

function tabKeyCounts(envelope) {
  const counts = {};
  const tabs = Array.isArray(envelope.tabs) ? envelope.tabs : [];
  for (const t of tabs) counts[t] = 0;
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  for (const k of Object.keys(data)) {
    for (const t of tabs) {
      if (k.length > t.length && k.startsWith(t) && k[t.length] === '.') {
        counts[t]++;
        break;
      }
    }
  }
  return counts;
}

function renderShare(req, row) {
  const shareId = row.share_id;
  const host  = req.get('host') || 'rabbitlc.xyz';
  const proto = req.protocol || 'https';
  const url   = `${proto}://${host}/share/${shareId}`;

  const envelope = parseEnvelope(row.data) || {};
  const title    = row.share_name || envelope.shareName
                || envelope.source?.name || `Share ${shareId}`;
  const tabs     = Array.isArray(envelope.tabs) ? envelope.tabs : [];
  const counts   = tabKeyCounts(envelope);
  const plans    = tabs.includes('plan_runner') ? extractPlans(envelope.data) : [];
  const srvName  = envelope.sourceServer?.name || '';
  const exported = envelope.exportedAt || '';
  const created  = row.created_at
    ? new Date(Number(row.created_at) * 1000).toISOString().slice(0, 10)
    : '';

  const chips = [];
  if (created)  chips.push(`<span class="chip">created <strong>${esc(created)}</strong></span>`);
  else if (exported) chips.push(`<span class="chip">exported <strong>${esc(exported.slice(0, 10))}</strong></span>`);
  if (srvName)  chips.push(`<span class="chip">server <strong>${esc(srvName)}</strong></span>`);
  chips.push(`<span class="chip"><strong>${tabs.length}</strong> tab${tabs.length === 1 ? '' : 's'}</span>`);

  const tabRows = tabs.map((t) => `
        <tr>
          <td>${esc(TAB_LABELS[t] || t)}</td>
          <td class="num">${counts[t] || 0} setting${(counts[t] || 0) === 1 ? '' : 's'}</td>
        </tr>`).join('');

  const plansSection = plans.length ? `
    <div class="card">
      <h2>Plans in this share</h2>
      <table>
        <tr><th>Name</th><th style="text-align:right">Steps</th></tr>
        ${plans.map((p) => `
        <tr>
          <td>${esc(p.name)}${p.loop ? '<span class="tag">loop</span>' : ''}</td>
          <td class="num">${p.steps}</td>
        </tr>`).join('')}
      </table>
      <div class="note">Step details stay private — the bot shows the full
      preview after you fetch the share there.</div>
    </div>` : '';

  const body = `
    <h1>${esc(title)}</h1>
    <p class="sub">Rabbit config share — open it in your bot to import.</p>

    <div class="card">
      <div class="meta">${chips.join('')}</div>
    </div>

    <div class="card">
      <h2>Contents</h2>
      <table>
        <tr><th>Tab</th><th style="text-align:right">Size</th></tr>
        ${tabRows || '<tr><td colspan="2" style="color:var(--text-dim)">(empty share)</td></tr>'}
      </table>
    </div>
    ${plansSection}

    <div class="card">
      <div class="url-row">
        <input id="url" value="${esc(url)}" readonly>
        <button id="copy" type="button">Copy</button>
      </div>
      <ol style="margin-top:18px">
        <li>Open the Rabbit Bot in-game</li>
        <li>Go to the <strong>Config</strong> tab</li>
        <li>Under <strong>Import</strong>, paste this URL and click <strong>Fetch</strong></li>
      </ol>
    </div>

    <script>
      (function () {
        var btn = document.getElementById('copy');
        var inp = document.getElementById('url');
        btn.addEventListener('click', function () {
          inp.select(); inp.setSelectionRange(0, 99999);
          try {
            navigator.clipboard ? navigator.clipboard.writeText(inp.value)
                                : document.execCommand('copy');
            var orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = orig; }, 1500);
          } catch (e) {}
        });
      })();
    </script>
  `;
  return shell(title, body);
}

router.get('/share/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).type('html').send(renderError(400, 'Invalid share id'));
    return;
  }
  let row;
  try {
    row = await db('config_shares').where('share_id', id)
      .select('share_id', 'share_name', 'data', 'active', 'created_at')
      .first();
  } catch (err) {
    console.error('[share] db error', err);
    res.status(500).type('html').send(renderError(500, 'Server error'));
    return;
  }
  // Deactivated shares are indistinguishable from missing ones on purpose —
  // matches the bot API, and "Deactivate" in the bot promises a 404 here.
  if (!row || row.active === 0 || row.active === false) {
    res.status(404).type('html').send(renderError(404, 'Share not found'));
    return;
  }
  res.type('html').send(renderShare(req, row));
});

export default router;
