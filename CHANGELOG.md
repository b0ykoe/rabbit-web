# Changelog

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
