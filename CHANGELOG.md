# Changelog

## [0.10.0] — Feature-flag parity + role hierarchy + session security

### Added
- **`super_admin` role** — new top-tier role above `admin`. Only super-admins can create/promote admin or super_admin accounts (enforced in `admin.users.js` via `checkRoleAssignmentAllowed`, mirrored client-side in `UserFormDialog.jsx`). Super-admins bypass the entire feature-flag system — the bot receives every flag as `true` regardless of persisted `feature_flags` JSON.
- **IP logging per bot session** — `bot_sessions.ip_address` (initial) + `bot_sessions.last_ip_address` (updated every heartbeat). Both columns surface in the admin sessions list **only for super-admins** (server strips them from the JSON for plain admins). IP drift between heartbeats emits a `session.ip_changed` audit-log row.
- **Concurrent-session enforcement** — `/api/bot/auth/start` now counts active sessions for the license key; when at `max_sessions`, the oldest active session is archived with `end_reason='session_overflow'` (new `archiveOldestSessionByKey` helper) so the new login succeeds. Super-admins skip the check entirely. Audit entry per overflow-kill.
- **Feature-flag parity with the bot DLL** — admin UI `FEATURE_FLAG_GROUPS` now lists all 27 flags the bot understands. Added: `inventory`, `buffs`, `consumables` (user, default off via `SHOP_MODULES`) and `dev_terrain`, `dev_debug`, `dev_chat`, `dev_inventory`, `dev_buffs`, `dev_anticheat`, `dev_packets` (dev).
- **`is_super_admin` in `/api/bot/auth/login` response** — bot can display a super-admin badge if desired.
- **Super-admin badge on user list** — client Users page renders "super admin" label in a distinct color.

### Changed
- `requireAdmin` middleware now accepts both `admin` AND `super_admin` roles.
- User form role selector hides the Admin / Super Admin options unless the session user is super-admin (plain admins only get "User" in the dropdown with a helper text).
- Validation schemas `createUserSchema` + `updateUserSchema` accept `super_admin`.

### New Files
- `server/migrations/015_add_super_admin_role.js` — extends `users.role` enum to `['super_admin', 'admin', 'user']`.
- `server/migrations/016_bot_sessions_ip.js` — adds `ip_address` + `last_ip_address` to `bot_sessions`.

### Notes
- Rate limiting on auth endpoints was already implemented at the right thresholds (10/min on login+start, 600/min on heartbeat) — no changes needed there.
- Heartbeat-timeout cleanup already runs every 60 s via `startSessionCleanup` in `sessionCleanup.js` — no changes needed there.
- No bot DLL changes: `ParseFeatureFlags` ignores unknown keys and defaults missing ones to `false`, so the bot transparently picks up new flag state when admins toggle them.

## [0.9.0] - 2026-04-12

### Added
- **Session stats** — bot sends stats (kills, XP, items, deaths, runtime) with every heartbeat. Server stores latest snapshot in `stats_json` per session. Stats persist in archived sessions.
- **Server-side config storage** — `GET/PUT /api/bot/config` endpoints for per-user, per-character bot configuration. Replaces local disk config files.
- **Live stats in frontend** — admin sessions and portal keys display live stats (kills, XP, items, deaths) with auto-refresh.
- **Configurable session timeout** — `config.bot.sessionTimeoutSec` (default 30s) replaces all hardcoded 90s cutoffs.

### Changed
- **Heartbeat interval** — 30s → 10s for near-real-time stats
- **Session timeout** — 90s → 30s (3 missed heartbeats)
- **Heartbeat rate limit** — 200/min → 600/min (matches 10s interval)
- All 8 timeout references now use central `config.bot.sessionTimeoutSec`
- Portal keys page auto-refreshes every 5s for live stats

### New Files
- `server/migrations/012_session_stats_and_configs.js`
- `server/src/routes/bot.config.js`

## [0.8.0] - 2026-04-12

### Added
- **Session archiving** — sessions are never deleted, only archived (`active=false`) with `ended_at` timestamp and `end_reason` (heartbeat_timeout, user_end, admin_kill, user_kill, hwid_reset)
- **Session kill** — admin and portal users can terminate active sessions. Admin: `DELETE /api/admin/sessions/:id`. Portal: `DELETE /api/portal/keys/:id` (own sessions only)
- **Session history** — portal keys page shows archived sessions with end reason and timestamp. Admin sessions page has Active/Archived/All toggle filter

### New Files
- `server/migrations/011_session_archive.js`

### Changed
- All session deletion operations replaced with archiving across: bot auth/end, session cleanup, admin kill, portal kill, HWID reset
- Session slot counting and heartbeat validation now filter by `active=true`
- Admin sessions table shows end_reason, runtime, ended-at for archived sessions. Kill button only on active
- Portal keys shows "Session History" section with archived sessions per key

## [0.7.0] - 2026-04-12

### Added
- **Bot user login** (`POST /api/bot/auth/login`) — stateless login with email+password for C++ loader. Returns Ed25519-signed user token + user data + license keys with live sessions.
- **Bot keys endpoint** (`GET /api/bot/keys`) — refresh user's license keys with live sessions. Requires user token via `Authorization: Bearer` header.
- **User token middleware** (`validateBotUserToken`) — verifies Ed25519-signed user tokens (type=user) from Authorization header, loads user from DB.

### Changed
- **Bot version endpoint** (`GET /api/bot/version`) — now requires user token, only returns versions for user's allowed channels
- **Bot changelog endpoint** (`GET /api/bot/changelog`) — now requires user token, filters releases by user's allowed channels
- **Bot download** — channel parameter support in download requests, response includes version + channel

## [0.6.0] - 2026-04-12

### Added
- **Rate limiting** — tiered per-endpoint rate limits using `express-rate-limit`. Bot auth start (10/min), heartbeat (200/min), downloads (10/min), web auth (10/min), admin (100/min), portal (60/min). All per-IP for bot API, per-session for web routes.
- **Token refresh via heartbeat** — bot can optionally send its token with heartbeat requests. If the token expires within 5 minutes, the server automatically issues a fresh token in the response. Fully backwards-compatible (token field is optional).

### New Files
- `server/src/middleware/rateLimiter.js`

### Changed
- `server/src/index.js` — rate limiters applied before all route handlers
- `server/src/crypto/ed25519.js` — added `parseTokenPayload()` for reading token payload without signature verification
- `server/src/validation/schemas.js` — `botHeartbeatSchema` now accepts optional `token` field
- `server/src/routes/bot.auth.js` — heartbeat endpoint supports token refresh

## [0.5.0] - 2026-04-12

### Added
- **Status timestamps** — global statuses support `starts_at` and `ends_at` timestamps
- **Status history** — statuses are archived, never deleted. History section shows past statuses with reactivate option
- **Changelog tabs** — portal "Recent Updates" split into DLL / Loader tabs so users know exactly what each update is for

### Changed
- **Chip unification** — all chips now use consistent height (22px), uppercase text, and uniform font weight/size across the entire app. No more mixed "Current" vs "Beta" width differences
- **Admin dashboard cards** — fixed flex layout so stat cards properly fill grid cells without being cut off
- **Admin status management** — delete button removed; statuses are archived instead. "Ends at" datetime field added. History section shows archived statuses at reduced opacity
- **Portal dashboard** — removed "My Keys" section (users use the menu link instead). Downloads now in compact table format with channel/version/download columns. "Current DLL" card replaced with "Last Login" since previous version.
- **Portal changelog** — inactive releases no longer show a stray "0" — only truly active releases show "CURRENT" chip. Fixed `rel.active` check to handle MySQL integer (0/1) vs boolean
- **Portal downloads** — compact table style with one row per channel showing type, channel chip, version, and download button

### New Files
- `server/migrations/010_status_timestamps.js`

## [0.4.0] - 2026-04-11

### Added
- **Global status banners** — admin creates/toggles multiple status messages (info/warning/error/success), shown as Alert banners on portal dashboard. Multiple active at once.
- **Last login tracking** — `last_login_at` recorded on each login, shown in portal dashboard instead of "Current DLL" card
- **Channel colors everywhere** — release=green, beta=yellow, alpha=red chips throughout admin + portal
- **Hash prefixes** — admin releases table shows "SHA-256" and "MD5" labels before each hash
- **Channel-aware portal downloads** — users with alpha/beta access see all their channel downloads, not just release
- **Channel-aware changelogs** — portal changelog entries show colored channel chip so users know which channel each update is for
- **Channel-aware loader download** — portal download URL accepts `?channel=` param, validates user access

### Changed
- Admin dashboard: reworked with global status management section, colored idle time chips (green/yellow/red), HWID column in sessions, channel chip on active releases
- Admin releases: hash display now prefixed with type label (SHA-256 / MD5)
- Portal dashboard: "Current DLL" card replaced with "Last Login" card
- Portal dashboard: "Your Keys" → "My Keys"
- Portal dashboard: downloads section shows one card per channel the user has access to (with changelog per loader)
- Portal dashboard: changelog entries have colored channel chips
- Portal keys: heading "My License Keys" → "My Keys"

### New Files
- `server/migrations/009_global_statuses_last_login.js`
- `server/src/routes/admin.statuses.js`
- `server/src/routes/portal.statuses.js`

## [0.3.0] - 2026-04-11

### Added
- **HWID binding** — first use binds key to hardware ID; mismatched HWID is rejected on auth/start
- **HWID reset** — admin can reset any key's HWID; users can reset their own (if `hwid_reset_enabled`)
- **User status** — admin can set a custom status text per user, shown in portal navbar + dashboard
- **MD5 hash** — releases now store both SHA-256 and MD5, both copyable in admin
- **Release deactivate** — admin can deactivate a release (fallback to no active version for that type+channel)
- **Release channel edit** — admin can change a release's channel after upload
- **Loader changelog** — portal download section shows the loader's changelog text
- **Portal credits display** — navbar shows credit balance as clickable chip
- **Portal HWID reset** — "Reset HWID" button on keys page with confirmation dialog

### Changed
- Portal dashboard: equal-height status cards (flexbox), better key/badge spacing (key on left, badges on right)
- Portal dashboard: merged "Current DLL Version" into status card row, removed overlap with changelog section
- Portal keys: spacious layout with key on its own line, meta row below (sessions, HWID, note, actions)
- Admin releases: hashes shown as copyable text (full SHA-256 + MD5), not truncated
- Admin releases: edit dialog now allows changing both changelog and channel
- Admin users: shows status column and HWID reset toggle in user form
- Admin licenses: shows bound HWID column + reset HWID button
- Bot auth `/start`: enforces HWID binding, auto-binds on first use

### New Files
- `server/migrations/008_md5_status_hwid_binding.js`
- `server/src/routes/portal.reset-hwid.js`

## [0.2.0] - 2026-04-11

### Added
- **Rebrand to "Rabbit"** — all UI text, browser title, server log
- **HWID tracking** — bot sessions store hardware ID, visible in admin sessions + portal keys
- **Key expiration** — licenses can have `expires_at`, color-coded ExpiryBadge (green/yellow/red/expired), bot rejects expired keys
- **Key redemption** — users can enter an unassigned key on the portal to claim it
- **Credits system** — users have a credit balance, admins can adjust via "Credits" button
- **Shop** — users purchase new licenses or extend existing ones with credits, pricing in `server/config/shop.json`
- **License extension** — admin can extend via preset durations or custom date, users extend via shop
- **Loader download** — portal users can download the latest active loader binary directly
- **Version channels** — releases tagged as `release`, `beta`, or `alpha`; admins assign channel access per user
- **Editable changelogs** — admin can edit release changelog text after upload
- **Portal layout height fix** — flexbox stretch so content fills viewport

### Changed
- `bot_sessions` table: added `hwid` column
- `licenses` table: added `expires_at` column
- `users` table: added `credits`, `allowed_channels` columns
- `releases` table: added `channel` column, unique constraint now `(type, version, channel)`
- `/api/auth/me` now reads fresh data from DB (credits, channels stay current)
- Release upload/activate scoped per `(type, channel)` instead of just `type`
- Admin users table shows credits + channel chips
- Admin licenses table shows expiry badge + edit/extend buttons
- Admin releases table shows channel chip + edit changelog button
- Portal dashboard shows HWID + runtime per session, expiry per key, download button
- Portal keys page has redeem input, extend button linking to shop

### New Files
- `server/migrations/006_add_hwid_and_expiry.js`
- `server/migrations/007_credits_channels.js`
- `server/config/shop.json`
- `server/src/services/shopService.js`
- `server/src/routes/portal.redeem.js`
- `server/src/routes/portal.shop.js`
- `server/src/routes/portal.download.js`
- `client/src/utils/format.js`
- `client/src/components/common/ExpiryBadge.jsx`
- `client/src/components/portal/Shop.jsx`
- `client/src/components/admin/ChangelogEditDialog.jsx`
- `client/src/components/admin/LicenseEditDialog.jsx`
- `client/src/components/admin/ExtendDialog.jsx`
- `client/src/components/admin/CreditAdjustDialog.jsx`

## [0.1.0] - 2026-04-11

### Added
- **Express + React + MUI portal** — full rewrite from Laravel
- **Server:** Express 4, Knex + MySQL2, Zod validation, bcryptjs, Ed25519 (@noble/ed25519), AES-256-CBC
- **Client:** React 18, React Router 6, MUI 5, Vite, dark theme (zinc/emerald)
- **Auth:** session-based (express-session + connect-session-knex), double-submit CSRF cookie, force password change on first login
- **Admin panel:** dashboard stats, user CRUD, license CRUD (generate/assign/revoke), release management (upload/activate), live session monitoring (auto-refresh 5s), searchable audit log
- **User portal:** dashboard (bot status, DLL version, keys summary, changelog), keys detail view (live/stale sessions)
- **Bot API:** `/api/bot/auth/{start,heartbeat,end}`, `/api/bot/{version,changelog}`, `/api/bot/download/{dll,loader}` (Ed25519 token + AES-256-CBC encrypted binary)
- **CLI:** `npm run keygen` generates Ed25519 keypair with C++ byte array output
- **Session cleanup:** in-process setInterval every 60s, deletes stale sessions (>90s without heartbeat)
- **Database:** 5 tables (users, licenses, bot_sessions, releases, audit_logs), Knex migrations + admin seed
- **Deployment:** pm2 + nginx reverse proxy, single Express process serves API + React build in production
