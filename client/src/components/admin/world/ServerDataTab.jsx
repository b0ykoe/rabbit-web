import { useEffect, useMemo, useState } from 'react';
import {
  Box, Paper, Tabs, Tab, TextField, InputAdornment, Typography, Stack, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Skeleton,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AssetStatusIcon from './AssetStatusIcon.jsx';
import { adminApi } from '../../../api/endpoints.js';

const SUB_TABS = ['Monsters', 'NPCs', 'Zones', 'Captcha'];

// "min-max" (single value when equal), "—" when both null. Used for the mob
// catalog's level and maxhp ranges.
function fmtRange(min, max) {
  if (min == null && max == null) return '—';
  if (min == null) return String(max);
  if (max == null) return String(min);
  return min === max ? String(min) : `${min}-${max}`;
}

// Relative "time ago" from epoch seconds (mob_catalog.last_seen). "—" when null.
function timeAgo(sec) {
  if (!sec) return '—';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

// A searchable, sticky-header table shell used by every sub-tab. `columns` is
// [{ key, label, align?, render? }]; `filter(row, needle)` narrows by the search
// box; empty/loading states are handled here.
function DataTable({ rows, columns, filter, placeholder, loading, emptyLabel, rowSx }) {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => filter(r, needle));
  }, [rows, q, filter]);

  if (loading) {
    return <Skeleton variant="rectangular" height={260} sx={{ borderRadius: 1 }} />;
  }

  return (
    <Box>
      <TextField
        size="small" fullWidth value={q} placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        sx={{ mb: 1.5 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
          ),
        }}
      />
      <TableContainer sx={{ maxHeight: 460 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <TableCell key={c.key} align={c.align || 'left'}>{c.label}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((r, i) => (
              <TableRow key={r._key ?? i} hover sx={rowSx ? rowSx(r) : undefined}>
                {columns.map((c) => (
                  <TableCell key={c.key} align={c.align || 'left'}>
                    {c.render ? c.render(r) : r[c.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length} align="center" sx={{ py: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    {q.trim() ? 'No matches.' : emptyLabel}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

// The Data reference tab (P5): read-only drill-in over the coverage overview's
// reference lists. Sub-tabs Monsters | NPCs | Zones, each a client-side searchable
// table. Props: { server, overview, loading }. Pure read — no mutations.
// Captcha rollup chips shown above the events table.
function CaptchaSummary({ summary, loading }) {
  if (loading) return <Skeleton variant="rounded" height={40} sx={{ mb: 2 }} />;
  const s = summary || {};
  const total = s.total || 0;
  const solved = s.solved || 0;
  const rate = total > 0 ? Math.round((solved / total) * 100) : 0;
  return (
    <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
      <Chip size="small" label={`Total ${total}`} />
      <Chip size="small" color={total > 0 && rate >= 90 ? 'success' : 'default'} label={`Solved ${solved} (${rate}%)`} />
      <Chip size="small" variant="outlined" label={`by id ${s.by_id || 0} · by text ${s.by_text || 0}`} />
      <Chip size="small" variant="outlined" label={`avg answer ${s.avg_solve_ms != null ? `${s.avg_solve_ms} ms` : '—'}`} />
      <Chip size="small" variant="outlined" label={`last ${timeAgo(s.last_sec)}`} />
    </Stack>
  );
}

export default function ServerDataTab({ server, overview, loading }) {
  const [sub, setSub] = useState(0);

  const mobs  = overview?.mobs  || [];
  const npcs  = overview?.npcs  || [];
  const zones = overview?.zones || [];

  const busy = loading && !overview;

  // Captcha telemetry is its own endpoint, fetched lazily the first time the
  // Captcha sub-tab is opened (and reset when the server changes).
  const serverId = server?.id;
  const [captcha, setCaptcha]       = useState(null);
  const [capLoading, setCapLoading] = useState(false);
  useEffect(() => { setCaptcha(null); }, [serverId]);
  useEffect(() => {
    if (sub !== 3 || serverId == null || captcha != null || capLoading) return;
    let alive = true;
    setCapLoading(true);
    adminApi.getServerCaptcha(serverId, 500)
      .then((res) => { if (alive) setCaptcha(res || { summary: {}, events: [] }); })
      .catch(() => { if (alive) setCaptcha({ summary: {}, events: [] }); })
      .finally(() => { if (alive) setCapLoading(false); });
    return () => { alive = false; };
  }, [sub, serverId, captcha, capLoading]);

  const counts = [mobs.length, npcs.length, zones.length, captcha?.summary?.total ?? null];

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Tabs value={sub} onChange={(_e, v) => setSub(v)} sx={{ mb: 2, minHeight: 40 }}>
        {SUB_TABS.map((label, i) => (
          <Tab key={label} label={counts[i] != null ? `${label} (${counts[i]})` : label} sx={{ minHeight: 40 }} />
        ))}
      </Tabs>

      {/* Monsters — [mob_id, name, level, maxhp, sightings, last_seen] (UNION of
          curated mob_names + observed mob_catalog). Seen-but-unnamed rows (no
          curated name) render an italic "unnamed" marker. */}
      {sub === 0 && (
        <DataTable
          rows={mobs}
          loading={busy}
          placeholder="Search monsters by name or id…"
          emptyLabel="No monsters recorded for this server."
          filter={(r, n) => String(r.mob_id).includes(n) || (r.name || '').toLowerCase().includes(n)}
          // Subtle italic marker for seen-but-unnamed rows (observed by a bot but
          // carrying no curated mob_names name).
          rowSx={(r) => (r.name == null && r.last_seen != null ? { fontStyle: 'italic' } : undefined)}
          columns={[
            { key: 'mob_id', label: 'ID', align: 'right', render: (r) => (
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{r.mob_id}</Box>
            ) },
            { key: 'name', label: 'Name', render: (r) => r.name || (
              <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>unnamed</Box>
            ) },
            { key: 'level', label: 'Level', align: 'right', render: (r) => (
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{fmtRange(r.level_min, r.level_max)}</Box>
            ) },
            { key: 'maxhp', label: 'MaxHP', align: 'right', render: (r) => (
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{fmtRange(r.maxhp_min, r.maxhp_max)}</Box>
            ) },
            { key: 'sightings_total', label: 'Sightings', align: 'right', render: (r) => (
              r.sightings_total == null
                ? <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
                : <Box component="span" sx={{ fontFamily: 'monospace' }}>{r.sightings_total}</Box>
            ) },
            { key: 'last_seen', label: 'Seen', align: 'right', render: (r) => (
              <Box component="span" sx={{ color: 'text.disabled' }}>{timeAgo(r.last_seen)}</Box>
            ) },
          ]}
        />
      )}

      {/* NPCs — [npc_id, name, type, zone_no] */}
      {sub === 1 && (
        <DataTable
          rows={npcs}
          loading={busy}
          placeholder="Search NPCs by name, type or id…"
          emptyLabel="No NPCs recorded for this server."
          filter={(r, n) =>
            String(r.npc_id).includes(n)
            || (r.name || '').toLowerCase().includes(n)
            || (r.type || '').toLowerCase().includes(n)}
          columns={[
            { key: 'npc_id', label: 'ID', align: 'right', render: (r) => (
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{r.npc_id}</Box>
            ) },
            { key: 'name', label: 'Name', render: (r) => r.name || (
              <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>unnamed</Box>
            ) },
            { key: 'type', label: 'Type', render: (r) => r.type || '—' },
            { key: 'zone_no', label: 'Zone', align: 'right', render: (r) => (
              r.zone_no == null ? '—' : <Box component="span" sx={{ fontFamily: 'monospace' }}>#{r.zone_no}</Box>
            ) },
          ]}
        />
      )}

      {/* Zones — [zone_no, name, has_data/has_bounds/has_background] */}
      {sub === 2 && (
        <DataTable
          rows={zones}
          loading={busy}
          placeholder="Search zones by name or number…"
          emptyLabel="No zones recorded for this server."
          filter={(r, n) => String(r.zone_no).includes(n) || (r.name || '').toLowerCase().includes(n)}
          columns={[
            { key: 'zone_no', label: 'Zone', render: (r) => (
              <Box component="span">
                <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>#{r.zone_no}</Box>
                {r.name
                  ? <Box component="span" sx={{ ml: 0.75, color: 'text.secondary' }}>{r.name}</Box>
                  : <Box component="span" sx={{ ml: 0.75, color: 'text.disabled', fontStyle: 'italic' }}>unnamed</Box>}
              </Box>
            ) },
            { key: 'has_data', label: 'Spawn data', align: 'center', render: (r) => (
              <AssetStatusIcon kind="data" present={!!r.has_data} actionable={false} size={16} />
            ) },
            { key: 'has_bounds', label: 'Bounds', align: 'center', render: (r) => (
              <AssetStatusIcon kind="bounds" present={!!r.has_bounds} actionable size={16} />
            ) },
            { key: 'has_background', label: 'Background', align: 'center', render: (r) => (
              <AssetStatusIcon kind="background" present={!!r.has_background} actionable size={16} />
            ) },
          ]}
        />
      )}

      {/* Captcha — per-server telemetry: summary rollup + recent events. Events
          uploaded without a selected server land with server_id NULL and are not
          shown here (they belong to no server). */}
      {sub === 3 && (
        <Box>
          <CaptchaSummary summary={captcha?.summary} loading={capLoading && !captcha} />
          <DataTable
            rows={captcha?.events || []}
            loading={capLoading && !captcha}
            placeholder="Search by user, method, outcome, zone…"
            emptyLabel="No captcha events recorded for this server."
            filter={(r, n) =>
              (r.user || '').toLowerCase().includes(n)
              || (r.method || '').toLowerCase().includes(n)
              || (r.outcome || '').toLowerCase().includes(n)
              || String(r.zone_no ?? '').includes(n)}
            columns={[
              { key: 'created_sec', label: 'When', align: 'right', render: (r) => (
                <Box component="span" sx={{ color: 'text.disabled' }}>{timeAgo(r.created_sec)}</Box>
              ) },
              { key: 'user', label: 'User', render: (r) => r.user || (
                <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>—</Box>
              ) },
              { key: 'zone_no', label: 'Zone', align: 'right', render: (r) => (
                r.zone_no == null ? '—' : <Box component="span" sx={{ fontFamily: 'monospace' }}>#{r.zone_no}</Box>
              ) },
              { key: 'method', label: 'Method', render: (r) => r.method || '—' },
              { key: 'outcome', label: 'Outcome', render: (r) => (
                <Box component="span" sx={{
                  color: r.outcome === 'solved' ? 'success.main'
                       : (r.outcome === 'closed' || r.outcome === 'unsolved') ? 'warning.main'
                       : 'text.secondary',
                  fontWeight: 600,
                }}>{r.outcome}</Box>
              ) },
              { key: 'slot', label: 'Correct → chosen', align: 'center', render: (r) => (
                <Box component="span" sx={{ fontFamily: 'monospace' }}>
                  {r.correct_id ?? '—'}
                  {r.chosen_slot != null && r.chosen_slot >= 0 ? ` → slot ${r.chosen_slot}` : ''}
                </Box>
              ) },
              { key: 'solve_ms', label: 'Answer', align: 'right', render: (r) => (
                r.solve_ms == null
                  ? <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
                  : <Box component="span" sx={{ fontFamily: 'monospace' }}>{r.solve_ms} ms</Box>
              ) },
              { key: 'raw_hex', label: 'Raw', render: (r) => (
                r.raw_hex
                  ? <Box component="span" title={r.raw_hex} sx={{ fontFamily: 'monospace', fontSize: '0.7rem', color: 'text.disabled' }}>
                      {r.raw_hex.slice(0, 16)}{r.raw_hex.length > 16 ? '…' : ''}
                    </Box>
                  : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
              ) },
            ]}
          />
        </Box>
      )}
    </Paper>
  );
}
