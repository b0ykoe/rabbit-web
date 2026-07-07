import { useMemo, useState } from 'react';
import {
  Box, Paper, Tabs, Tab, TextField, InputAdornment, Typography,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Skeleton,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import StatusDot from './StatusDot.jsx';

const SUB_TABS = ['Monsters', 'NPCs', 'Zones'];

// A searchable, sticky-header table shell used by every sub-tab. `columns` is
// [{ key, label, align?, render? }]; `filter(row, needle)` narrows by the search
// box; empty/loading states are handled here.
function DataTable({ rows, columns, filter, placeholder, loading, emptyLabel }) {
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
              <TableRow key={r._key ?? i} hover>
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
export default function ServerDataTab({ overview, loading }) {
  const [sub, setSub] = useState(0);

  const mobs  = overview?.mobs  || [];
  const npcs  = overview?.npcs  || [];
  const zones = overview?.zones || [];

  const busy = loading && !overview;

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Tabs value={sub} onChange={(_e, v) => setSub(v)} sx={{ mb: 2, minHeight: 40 }}>
        {SUB_TABS.map((label, i) => (
          <Tab key={label} label={`${label}${i === 0 ? ` (${mobs.length})` : i === 1 ? ` (${npcs.length})` : ` (${zones.length})`}`} sx={{ minHeight: 40 }} />
        ))}
      </Tabs>

      {/* Monsters — [mob_id, name] */}
      {sub === 0 && (
        <DataTable
          rows={mobs}
          loading={busy}
          placeholder="Search monsters by name or id…"
          emptyLabel="No monsters recorded for this server."
          filter={(r, n) => String(r.mob_id).includes(n) || (r.name || '').toLowerCase().includes(n)}
          columns={[
            { key: 'mob_id', label: 'ID', align: 'right', render: (r) => (
              <Box component="span" sx={{ fontFamily: 'monospace' }}>{r.mob_id}</Box>
            ) },
            { key: 'name', label: 'Name', render: (r) => r.name || (
              <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>unnamed</Box>
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
              <StatusDot state={r.has_data ? 'done' : 'inert'} title={r.has_data ? 'Spawn data collected' : 'No spawn data yet'} size={16} />
            ) },
            { key: 'has_bounds', label: 'Bounds', align: 'center', render: (r) => (
              <StatusDot state={r.has_bounds ? 'done' : 'missing'} title={r.has_bounds ? 'Bounds set' : 'No bounds'} size={16} />
            ) },
            { key: 'has_background', label: 'Background', align: 'center', render: (r) => (
              <StatusDot state={r.has_background ? 'done' : 'missing'} title={r.has_background ? 'Background uploaded' : 'No background'} size={16} />
            ) },
          ]}
        />
      )}
    </Paper>
  );
}
