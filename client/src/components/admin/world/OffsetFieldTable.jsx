import { useMemo, useState } from 'react';
import {
  Box, Stack, Typography, TextField, InputAdornment, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

// Loose value formatter for a field's offset/value: "0x" + lowercase hex, or "—"
// for null. Unlike the fingerprint's fixed-width toHex, offset values vary wildly
// in magnitude so we don't zero-pad them.
export function fieldHex(n) {
  if (n == null || n === '') return '—';
  return '0x' + (Number(n) >>> 0).toString(16);
}

// Parse a hex ("0x1a2b") OR decimal string into a non-negative integer.
//   ''            → { ok: true,  value: null }   (empty = "no override")
//   '0x1a2b'/'42' → { ok: true,  value: <int>  }
//   garbage / neg → { ok: false, value: null }
// Offsets are never negative, so a leading '-' is invalid.
export function parseIntFlexible(raw) {
  const s = (raw ?? '').trim();
  if (s === '') return { ok: true, value: null };
  if (/^-/.test(s)) return { ok: false, value: null };
  let n;
  if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^[0-9]+$/.test(s)) n = parseInt(s, 10);
  else return { ok: false, value: null };
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

// A row is invalid when its raw string doesn't parse (and isn't empty). The parent
// calls this over its whole working copy to gate Save.
export function hasInvalidOverride(value) {
  for (const raw of Object.values(value || {})) {
    if (raw === '' || raw == null) continue;
    if (!parseIntFlexible(raw).ok) return true;
  }
  return false;
}

// Kind chip — data (blue) vs va (purple-ish "secondary"). Matches the dense chip
// styling used across the sibling tabs (height 20, small).
function KindChip({ kind }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={kind === 'va' ? 'secondary' : 'info'}
      label={kind || '—'}
      sx={{ height: 20, fontFamily: 'monospace', textTransform: 'uppercase', fontSize: '0.65rem' }}
    />
  );
}

// The base-vs-override field editor. Controlled entirely by the parent's working
// copy (`value`: field_name -> rawString). Columns:
//   Field | Kind | Criticality | Base (hex) | Override (editable) | Effective (hex)
// Override accepts hex-or-decimal; empty = "remove override"; invalid = red field.
// Props:
//   catalog   — [{ field_name, kind, criticality, base_value }]
//   effective — [{ field_name, base_value, override }] (server-computed; used as a
//               fallback for base when catalog is missing a row)
//   value     — { [field_name]: rawString } working overrides
//   onChange  — (field_name, rawString) => void
export default function OffsetFieldTable({ catalog, effective, value, onChange }) {
  const [q, setQ] = useState('');

  // Base lookup: catalog is authoritative; fall back to the effective list so a
  // base still shows even if a catalog row is momentarily absent.
  const baseByName = useMemo(() => {
    const m = new Map();
    for (const e of (effective || [])) m.set(e.field_name, e.base_value);
    for (const c of (catalog || [])) m.set(c.field_name, c.base_value);
    return m;
  }, [catalog, effective]);

  const rows = catalog || [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => (r.field_name || '').toLowerCase().includes(needle));
  }, [rows, q]);

  // "(N of M overridden)" — a field counts as overridden when its working raw is a
  // non-empty string (regardless of validity, so a half-typed value still counts).
  const overriddenCount = useMemo(
    () => rows.reduce((acc, r) => acc + ((value?.[r.field_name] ?? '') !== '' ? 1 : 0), 0),
    [rows, value],
  );

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ mb: 1.5, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.75 }}>
          <Typography variant="caption" color="text.secondary">
            Base = compiled Stock EP4. Set an override to replace one field for this server.
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            color={overriddenCount ? 'primary' : 'default'}
            label={`${overriddenCount} of ${rows.length} overridden`}
            sx={{ height: 20 }}
          />
        </Stack>
        <TextField
          size="small"
          placeholder="Search fields…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ minWidth: 220 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
            ),
          }}
        />
      </Stack>

      <TableContainer sx={{ maxHeight: 460 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Field</TableCell>
              <TableCell>Kind</TableCell>
              <TableCell>Criticality</TableCell>
              <TableCell align="right">Base</TableCell>
              <TableCell align="right">Override</TableCell>
              <TableCell align="right">Effective</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((r) => {
              const raw = value?.[r.field_name] ?? '';
              const base = baseByName.has(r.field_name) ? baseByName.get(r.field_name) : r.base_value;
              const parsed = parseIntFlexible(raw);
              const isOverridden = raw !== '';
              const invalid = isOverridden && !parsed.ok;
              // Effective = override ?? base (only when the override parses cleanly).
              const eff = (isOverridden && parsed.ok && parsed.value != null) ? parsed.value : base;
              return (
                <TableRow
                  key={r.field_name}
                  hover
                  sx={isOverridden ? { bgcolor: 'action.hover' } : undefined}
                >
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                    {r.field_name}
                  </TableCell>
                  <TableCell><KindChip kind={r.kind} /></TableCell>
                  <TableCell>
                    {r.criticality
                      ? <Typography variant="caption" color="text.secondary">{r.criticality}</Typography>
                      : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                    <Box component="span" sx={{ color: base == null ? 'text.disabled' : 'text.secondary' }}>
                      {fieldHex(base)}
                    </Box>
                  </TableCell>
                  <TableCell align="right" sx={{ py: 0.25 }}>
                    <TextField
                      size="small"
                      variant="standard"
                      value={raw}
                      error={invalid}
                      placeholder="—"
                      onChange={(e) => onChange(r.field_name, e.target.value)}
                      inputProps={{
                        style: { fontFamily: 'monospace', fontSize: '0.75rem', textAlign: 'right' },
                        spellCheck: false,
                      }}
                      sx={{ width: 110 }}
                    />
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: '0.75rem',
                      fontWeight: isOverridden && !invalid ? 600 : 400,
                      color: invalid ? 'error.main' : (eff == null ? 'text.disabled' : 'text.primary'),
                    }}
                  >
                    {invalid ? 'invalid' : fieldHex(eff)}
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    {q.trim()
                      ? 'No fields match your search.'
                      : 'No catalog fields yet — import offsets_catalog.json above.'}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Legend */}
      <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          Values shown as hex — the override field accepts <code>0x1a2b</code> or decimal.
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Highlighted rows carry an override; empty override = use the base.
        </Typography>
      </Stack>
    </Box>
  );
}
