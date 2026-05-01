//
// portal.share.js — public landing page for share URLs.
//
// Minimalist by design: the page shows nothing about what's *inside* the
// snapshot (source name, tabs, key count etc.). All it does is:
//   • confirm the URL belongs to a real Rabbit share
//   • offer a Copy-URL button
//   • tell the visitor how to import it in the bot
//
// What's in the snapshot is the bot's job to present to the importing user
// in their own UI, where they have authentication context and can preview
// before committing.
//

import { Router } from 'express';
import db from '../db.js';

const router = Router();

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
    .sub { color: var(--text-dim); font-size: 13px; margin: 0 0 24px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px;
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
    .err {
      text-align: center; padding: 64px 16px; color: var(--text-dim);
    }
    .err h1 { color: var(--text); }
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

function renderShare(req, shareId) {
  // Reconstruct the canonical URL the user copied. Using req.protocol/host
  // so localhost dev and prod both yield the right URL.
  const host  = req.get('host') || 'rabbitlc.xyz';
  const proto = req.protocol || 'https';
  const url   = `${proto}://${host}/share/${shareId}`;

  const body = `
    <h1>Rabbit Config Share</h1>
    <p class="sub">Open this in your bot to see what's inside and import it.</p>

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
  return shell(`Share ${shareId}`, body);
}

router.get('/share/:id', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).type('html').send(renderError(400, 'Invalid share id'));
    return;
  }
  // Existence check only — we don't expose any of the snapshot's contents
  // here. The bot fetches the actual data via the authenticated API.
  let row;
  try {
    row = await db('config_shares').where('share_id', id).select('share_id').first();
  } catch (err) {
    console.error('[share] db error', err);
    res.status(500).type('html').send(renderError(500, 'Server error'));
    return;
  }
  if (!row) {
    res.status(404).type('html').send(renderError(404, 'Share not found'));
    return;
  }
  res.type('html').send(renderShare(req, id));
});

export default router;
