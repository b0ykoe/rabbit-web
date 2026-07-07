import { apiFetch } from './client.js';

// ── Meta ─────────────────────────────────────────────────────────────────────

export const metaApi = {
  // Public — returns { version } of the running server build.
  getVersion: () => apiFetch('/api/version'),
};

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  me:             ()     => apiFetch('/api/auth/me'),
  login:          (data) => apiFetch('/api/auth/login',           { method: 'POST', body: JSON.stringify(data) }),
  logout:         ()     => apiFetch('/api/auth/logout',          { method: 'POST' }),
  changePassword: (data) => apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
};

// ── Admin ────────────────────────────────────────────────────────────────────

export const adminApi = {
  // Dashboard
  getDashboard: () => apiFetch('/api/admin/dashboard'),

  // Users
  getUsers:       (page = 1)    => apiFetch(`/api/admin/users?page=${page}`),
  createUser:     (data)        => apiFetch('/api/admin/users',            { method: 'POST',   body: JSON.stringify(data) }),
  updateUser:     (id, data)    => apiFetch(`/api/admin/users/${id}`,      { method: 'PATCH',  body: JSON.stringify(data) }),
  deleteUser:     (id)          => apiFetch(`/api/admin/users/${id}`,      { method: 'DELETE' }),
  adjustCredits:  (id, data)    => apiFetch(`/api/admin/users/${id}/credits`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Licenses
  getLicenses:    (page = 1)    => apiFetch(`/api/admin/licenses?page=${page}`),
  getLicensesAll: ()            => apiFetch('/api/admin/licenses?all=1'),
  createLicense:  (data)        => apiFetch('/api/admin/licenses',                  { method: 'POST',  body: JSON.stringify(data) }),
  updateLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}`,           { method: 'PATCH', body: JSON.stringify(data) }),
  extendLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}/extend`,    { method: 'PATCH', body: JSON.stringify(data) }),
  revokeLicense:  (key)         => apiFetch(`/api/admin/licenses/${key}/revoke`,    { method: 'PATCH' }),
  assignLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}/assign`,    { method: 'PATCH', body: JSON.stringify(data) }),

  // Releases
  getReleases:     ()           => apiFetch('/api/admin/releases'),
  uploadRelease:   (formData)   => apiFetch('/api/admin/releases', { method: 'POST', body: formData }),
  updateRelease:   (id, data)   => apiFetch(`/api/admin/releases/${id}`,          { method: 'PATCH', body: JSON.stringify(data) }),
  activateRelease:   (id)         => apiFetch(`/api/admin/releases/${id}/activate`,   { method: 'PATCH' }),
  deactivateRelease: (id)         => apiFetch(`/api/admin/releases/${id}/deactivate`, { method: 'PATCH' }),
  resetLicenseHwid:  (key)        => apiFetch(`/api/admin/licenses/${key}/reset-hwid`, { method: 'PATCH' }),

  // Sessions
  getSessions:        (page = 1, status = 'active') => apiFetch(`/api/admin/sessions?page=${page}&status=${status}`),
  getSessionProxyStats: (id) => apiFetch(`/api/admin/sessions/${encodeURIComponent(id)}/proxy-stats`),
  killSession:        (id)  => apiFetch(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Global Statuses (no delete — archive only)
  getStatuses:    ()          => apiFetch('/api/admin/statuses'),
  createStatus:   (data)      => apiFetch('/api/admin/statuses',      { method: 'POST',   body: JSON.stringify(data) }),
  updateStatus:   (id, data)  => apiFetch(`/api/admin/statuses/${id}`,{ method: 'PATCH',  body: JSON.stringify(data) }),

  // Audit
  getAuditLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/admin/audit?${qs}`);
  },

  // Purchase history
  getUserPurchases: (id, page = 1) => apiFetch(`/api/admin/users/${id}/purchases?page=${page}`),

  // Settings
  getSettings:    ()           => apiFetch('/api/admin/settings'),
  updateSetting:  (key, data)  => apiFetch(`/api/admin/settings/${key}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Monster-map ingest tokens (super-admin) — PLAN_v2 §3.9
  getIngestTokens:   ()      => apiFetch('/api/admin/world/ingest-tokens'),
  mintIngestToken:   (data)  => apiFetch('/api/admin/world/ingest-token', { method: 'POST', body: JSON.stringify(data) }),
  revokeIngestToken: (jti)   => apiFetch(`/api/admin/world/ingest-token/${encodeURIComponent(jti)}`, { method: 'DELETE' }),

  // Monster-map server management (super-admin) — additive.
  // Servers are ADMIN-DEFINED named entities (server_id). createWorldServer takes
  // { name, variant, visible?, known_ips? }; updateWorldServer accepts any of
  // { name, variant, visible, display_name, add_ips, remove_ips }.
  getWorldServers:   ()          => apiFetch('/api/admin/world/servers'),
  createWorldServer: (data)      => apiFetch('/api/admin/world/servers', { method: 'POST', body: JSON.stringify(data) }),
  updateWorldServer: (id, data)  => apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}`, { method: 'PATCH',  body: JSON.stringify(data) }),
  deleteWorldServer: (id)        => apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Fold one server (source) INTO another (target=id). Re-points every child table
  // of the source onto the target then deletes the source row — destructive, in one
  // transaction. body { source_id, dry_run? }: dry_run:true returns the per-table
  // "moved" counts WITHOUT mutating; dry_run:false performs the merge and returns
  // { ok, target_id, source_id, moved:{…} }.
  mergeWorldServer:  (id, body)  => apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}/merge`, { method: 'POST', body: JSON.stringify(body) }),

  // Per-(server,zone) background map images (super-admin) — additive.
  // Lists every data-zone for a server with its background status; upload/delete a
  // single SVG/PNG per (server, zone). Upload is multipart: reuse the Releases
  // FormData pattern (apiFetch skips the JSON Content-Type for FormData bodies, so
  // the browser sets the multipart boundary and CSRF + credentials still apply).
  listZoneMaps:  (sid)             => apiFetch(`/api/admin/world/servers/${encodeURIComponent(sid)}/zone-maps`),
  uploadZoneMap: (sid, zone, file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch(`/api/admin/world/servers/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/map`, { method: 'POST', body: formData });
  },
  deleteZoneMap: (sid, zone)       => apiFetch(`/api/admin/world/servers/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/map`, { method: 'DELETE' }),

  // Per-server reference-list coverage (super-admin) — additive. Returns
  // { counts, zones:[{ zone_no, name|null, has_data, has_bounds, has_background }],
  //   mobs:[{ mob_id, name }] }. Optional ?q filters the mob table server-side.
  getServerOverview: (id, q) => {
    const qs = q ? `?${new URLSearchParams({ q }).toString()}` : '';
    return apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}/overview${qs}`);
  },

  // Import a bot-exported reference name list (super-admin) — additive. The bot
  // writes names.json / zones.csv / mobs.csv locally; the admin uploads one file
  // here. Multipart FormData (single field "file"), same pattern as uploadZoneMap
  // (apiFetch skips the JSON Content-Type for FormData so the browser sets the
  // multipart boundary; CSRF + credentials still apply). → { ok, zones, mobs }.
  importServerNames: (id, file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}/import-names`, { method: 'POST', body: formData });
  },

  // Import a bot-exported zone_<N>_calib.json (map-export sidecar) to set the
  // per-(server, zone) zone_bounds so an uploaded background renders framed
  // (accurate) instead of the auto-fit approximation (super-admin) — additive.
  // Multipart FormData (single field "file"), same pattern as uploadZoneMap /
  // importServerNames (apiFetch skips the JSON Content-Type for FormData so the
  // browser sets the multipart boundary; CSRF + credentials still apply).
  // → { ok, zone_no }.
  importZoneBounds: (id, zoneNo, file) => {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch(`/api/admin/world/servers/${encodeURIComponent(id)}/zones/${encodeURIComponent(zoneNo)}/bounds`, { method: 'POST', body: formData });
  },
};

// ── Portal ───────────────────────────────────────────────────────────────────

export const portalApi = {
  getDashboard: () => apiFetch('/api/portal/dashboard'),
  getKeys:      () => apiFetch('/api/portal/keys'),
  killSession:  (id) => apiFetch(`/api/portal/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  redeemKey:    (data) => apiFetch('/api/portal/redeem', { method: 'POST', body: JSON.stringify(data) }),
  getShop:      () => apiFetch('/api/portal/shop'),
  purchase:     (data) => apiFetch('/api/portal/shop/purchase', { method: 'POST', body: JSON.stringify(data) }),
  resetHwid:    (data) => apiFetch('/api/portal/reset-hwid', { method: 'POST', body: JSON.stringify(data) }),
  getStatuses:  () => apiFetch('/api/portal/statuses'),
  getSessions:  (page = 1, status = 'all') => apiFetch(`/api/portal/sessions?page=${page}&status=${status}`),
};

// ── World map (user-facing read view) ─────────────────────────────────────────
// Consumes the existing portal.world.js read API. All GETs (CSRF-exempt).

// ── Cached world reads ───────────────────────────────────────────────────────
// The Monster Map fans out one clusters+spawns request PER selected mob PER zone,
// and effects re-run on every mob/zone toggle — uncached that easily trips the
// portal rate limiter (429). Memoise idempotent GETs by full URL with a short TTL
// so a burst / re-selection reuses an in-flight-or-recent result instead of
// re-hitting the server. Concurrent identical requests share one promise (collapse
// to a single network call); failures are never cached; a page reload (or the TTL)
// refreshes.
const WORLD_GET_TTL_MS = 60_000;
const _worldGetCache = new Map(); // url -> { p: Promise, ts: number }
function cachedGet(url) {
  const now = Date.now();
  const hit = _worldGetCache.get(url);
  if (hit && now - hit.ts < WORLD_GET_TTL_MS) return hit.p;
  const p = apiFetch(url).catch((err) => {
    if (_worldGetCache.get(url)?.p === p) _worldGetCache.delete(url);
    throw err;
  });
  _worldGetCache.set(url, { p, ts: now });
  return p;
}

export const worldApi = {
  // Visible servers only (API filters game_servers.visible = true).
  servers:   ()      => cachedGet('/api/portal/world/servers'),

  // Mob catalog for a server; optional q matches name LIKE or numeric mob_id.
  mobs:      (sid, q) => {
    const qs = q ? `?${new URLSearchParams({ q }).toString()}` : '';
    return cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/mobs${qs}`);
  },

  // All zones where a given mob spawns → { mob_id, zones:{ "<zone_no>":[...] }, total_cells }.
  // Used to derive the zone list for a selected mob. opts: { channel }.
  mobSpawns: (sid, mobId, opts = {}) => {
    const qs = (opts.channel !== undefined && opts.channel !== null && opts.channel !== '')
      ? `?${new URLSearchParams({ channel: opts.channel }).toString()}` : '';
    return cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/mobs/${encodeURIComponent(mobId)}/spawns${qs}`);
  },

  // Spawn cells for a zone. opts: { version, mob_id, channel, ignore_channels }.
  zoneSpawns: (sid, zone, opts = {}) => {
    const params = {};
    for (const k of ['version', 'mob_id', 'channel', 'ignore_channels']) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') params[k] = opts[k];
    }
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    return cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/spawns${qs}`);
  },

  // Clusters for a zone. mob_id is REQUIRED server-side. opts: { mob_id, channel, min_count }.
  zoneClusters: (sid, zone, opts = {}) => {
    const params = {};
    for (const k of ['mob_id', 'channel', 'min_count']) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') params[k] = opts[k];
    }
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    return cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/clusters${qs}`);
  },

  // Zone framing bounds (additive portal GET; 404 when absent).
  zoneBounds: (sid, zone) => cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/bounds`),

  // Per-server reference name lists (bot-exported) → { zones:{ "<zone_no>":"<name>" },
  // mobs:{ "<mob_id>":"<name>" } }. Used to label zone/mob pickers with real names.
  names: (sid) => cachedGet(`/api/portal/world/${encodeURIComponent(sid)}/names`),

  // URL of a zone's uploaded background image (same-origin authed GET streamed by
  // the server). Used directly as an <image href> — not fetched via apiFetch, so
  // the browser sends the session cookie implicitly. 404 when no background exists.
  zoneMapUrl: (sid, zone) => `/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/map`,

  // ── Spawn-recording read views (PLAN_v2 §channel-live) ─────────────────────
  // All additive GETs against the existing portal.world.js read API.

  // Own ingest tokens for the session user (never exposes the secret) →
  // { data:[{ jti, scope, revoked, expires_at, created_at, status, remaining_seconds }] }.
  myTokens:          ()   => apiFetch('/api/portal/world/my-ingest-tokens'),

  // Whether the session user currently has spawn_tracking enabled →
  // { spawn_tracking: bool }.
  myRecordingStatus: ()   => apiFetch('/api/portal/world/my-recording-status'),

  // Recording sessions (version windows) for a server; opts: { zone_no, limit }.
  sessions: (sid, opts = {}) => {
    const params = {};
    for (const k of ['zone_no', 'limit']) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') params[k] = opts[k];
    }
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch(`/api/portal/world/${encodeURIComponent(sid)}/sessions${qs}`);
  },

  // Per-zone scan coverage summary for a server →
  // { data:[{ zone_no, last_scanned, version_count, total_renewed_spots, has_bounds }] }.
  coverage: (sid) => apiFetch(`/api/portal/world/${encodeURIComponent(sid)}/coverage`),

  // What ONE session (version window) renewed for a zone, grouped by mob, each spot
  // tagged with its change status (new|group_changed|same) vs the PREVIOUS session,
  // plus a compact changes summary →
  //   { server_id, zone_no, version_id, prev_version_id,
  //     summary:{ added, removed, group_changed, same },
  //     mobs:[{ mob_id, mob_name, spot_count,
  //             spots:[{ center_x, center_z, cell_x, cell_z, typical_group, hits,
  //                      reliability, change }] }] }.
  // center_x/center_z are world metres when the zone is framed (else cell centroid);
  // cell_x/cell_z are always the raw cell centroid (used for map-highlight matching).
  sessionDetail: (sid, zone, versionId) =>
    apiFetch(`/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/sessions/${encodeURIComponent(versionId)}/detail`),

  // Diff two version snapshots of a zone; opts: { a, b, channel } →
  // { counts:{ added, removed, group_changed, same, moved }, list:[], truncated }.
  diff: (sid, zone, opts = {}) => {
    const params = {};
    for (const k of ['a', 'b', 'channel']) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') params[k] = opts[k];
    }
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    return apiFetch(`/api/portal/world/${encodeURIComponent(sid)}/zones/${encodeURIComponent(zone)}/diff${qs}`);
  },

  // STRING URL (admin/super-admin only) for the streamed spawns CSV export. Used
  // directly as an <a download href> — NOT fetched via apiFetch, so the browser
  // sends the session cookie implicitly and streams the file to disk.
  // opts: { zone_no, mob_id, channel, ignore_channels, version } (version = 'all'|'latest'|<n>).
  exportCsvUrl: (sid, opts = {}) => {
    const params = {};
    for (const k of ['zone_no', 'mob_id', 'channel', 'ignore_channels', 'version']) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') params[k] = opts[k];
    }
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    return `/api/admin/world/servers/${encodeURIComponent(sid)}/spawns.csv${qs}`;
  },
};
