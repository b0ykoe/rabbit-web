import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box, Stack, Typography, TextField, InputAdornment, Chip, Alert, Skeleton, Button,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import { parseIntFlexible, hasInvalidOverride } from './OffsetFieldTable.jsx';

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Kind chip — data (blue) vs va (purple-ish "secondary"). Mirrors the tiny-chip
// styling in OffsetFieldTable (height 20, small, mono uppercase).
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

// Per-template base-value editor. Opens a template, shows its fields in a dense
// searchable table, and lets an admin edit each field's base value (hex or
// decimal) + rename the template. Save REPLACES the template values — a field
// left empty is dropped from the template. Props:
//   { open, onClose, templateId, templateName, onSaved }
export default function TemplateEditorDialog({ open, onClose, templateId, templateName, onSaved }) {
  const { showSnackbar } = useSnackbar();

  const [data, setData]       = useState(null);   // getOffsetTemplate payload | null
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const [nameStr, setNameStr] = useState('');      // rename working copy
  const [values, setValues]   = useState({});      // field_name -> rawString
  const [dirty, setDirty]     = useState(false);
  const [saving, setSaving]   = useState(false);
  const [q, setQ]             = useState('');

  // Seed the working copies from a freshly-loaded payload.
  const seedFrom = useCallback((payload) => {
    setNameStr(payload?.name ?? '');
    const map = {};
    for (const f of (payload?.fields || [])) {
      map[f.field_name] = f.value == null ? '' : '0x' + (Number(f.value) >>> 0).toString(16);
    }
    setValues(map);
    setDirty(false);
  }, []);

  // Load the template on open (and whenever templateId changes).
  const load = useCallback(async () => {
    if (templateId == null) return;
    setLoading(true);
    setError(null);
    // Clear any stale working copy from a previous template/save so a failed load
    // can never leave Save enabled over the previous template's values.
    setDirty(false);
    setValues({});
    try {
      const res = await adminApi.getOffsetTemplate(templateId);
      setData(res);
      seedFrom(res);
    } catch (err) {
      setError(err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [templateId, seedFrom]);

  useEffect(() => {
    if (open) { setQ(''); load(); }
  }, [open, load]);

  // ── Change handlers → mark dirty ───────────────────────────────────────────
  const onValueChange = useCallback((fieldName, raw) => {
    setValues((prev) => ({ ...prev, [fieldName]: raw }));
    setDirty(true);
  }, []);

  const onNameChange = (v) => { setNameStr(v); setDirty(true); };

  // ── Validation + counts ────────────────────────────────────────────────────
  const rows = data?.fields || [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => (r.field_name || '').toLowerCase().includes(needle));
  }, [rows, q]);

  // "(N of M set)" — a field counts as set when its working raw is non-empty
  // (regardless of validity, so a half-typed value still counts).
  const setCount = useMemo(
    () => rows.reduce((acc, r) => acc + ((values?.[r.field_name] ?? '') !== '' ? 1 : 0), 0),
    [rows, values],
  );

  const invalid = hasInvalidOverride(values);

  // ── Save: PATCH the name (if changed) + PUT the non-empty, valid values ─────
  const handleSave = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    try {
      // Rename first (only when it actually changed and isn't empty).
      const nm = nameStr.trim();
      if (nm && nm !== (data?.name ?? '')) {
        await adminApi.updateOffsetTemplate(templateId, { name: nm });
      }
      // Build values from the working copy (skip empty = "removed").
      const out = [];
      for (const [field_name, raw] of Object.entries(values)) {
        if (raw === '' || raw == null) continue;
        const p = parseIntFlexible(raw);
        if (!p.ok || p.value == null) continue; // guarded by `invalid`, belt-and-braces
        out.push({ field_name, value: p.value });
      }
      await adminApi.putOffsetTemplateValues(templateId, out);
      showSnackbar(`Saved ${out.length} value(s)`);
      onSaved?.();
      onClose();
    } catch (err) {
      // A rejected unknown field_name comes back with err.data.fields.
      const fields = err?.data?.fields;
      const suffix = Array.isArray(fields) && fields.length ? ` (${fields.join(', ')})` : '';
      showSnackbar(errMsg(err, 'Save failed') + suffix, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="md" fullWidth>
      <DialogTitle>Edit template — {templateName || `#${templateId}`}</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        {loading ? (
          <Stack spacing={2}>
            <Skeleton variant="rectangular" height={40} sx={{ borderRadius: 1 }} />
            <Skeleton variant="rectangular" height={320} sx={{ borderRadius: 1 }} />
          </Stack>
        ) : error ? (
          <Alert severity="error">{errMsg(error, 'Failed to load template.')}</Alert>
        ) : (
          <Box>
            <TextField
              label="Name"
              size="small"
              value={nameStr}
              disabled={saving}
              inputProps={{ maxLength: 64 }}
              onChange={(e) => onNameChange(e.target.value)}
              sx={{ minWidth: 260, mb: 2 }}
            />

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              sx={{ mb: 1.5, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
            >
              <Chip
                size="small"
                variant="outlined"
                color={setCount ? 'primary' : 'default'}
                label={`${setCount} of ${rows.length} set`}
                sx={{ height: 20 }}
              />
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

            <TableContainer sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Field</TableCell>
                    <TableCell>Kind</TableCell>
                    <TableCell>Criticality</TableCell>
                    <TableCell align="right">Value</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((r) => {
                    const raw = values?.[r.field_name] ?? '';
                    const parsed = parseIntFlexible(raw);
                    const isSet = raw !== '';
                    const bad = isSet && !parsed.ok;
                    return (
                      <TableRow
                        key={r.field_name}
                        hover
                        sx={isSet ? { bgcolor: 'action.hover' } : undefined}
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
                        <TableCell align="right" sx={{ py: 0.25 }}>
                          <TextField
                            size="small"
                            variant="standard"
                            value={raw}
                            error={bad}
                            placeholder="—"
                            onChange={(e) => onValueChange(r.field_name, e.target.value)}
                            inputProps={{
                              style: { fontFamily: 'monospace', fontSize: '0.75rem', textAlign: 'right' },
                              spellCheck: false,
                            }}
                            sx={{ width: 110 }}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 3 }}>
                        <Typography variant="body2" color="text.secondary">
                          {q.trim() ? 'No fields match your search.' : 'This template has no fields.'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Values shown as hex — each field accepts <code>0x1a2b</code> or decimal. Saving
              REPLACES the template values; a field left empty is dropped from the template.
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!dirty || invalid || saving || loading || !!error || !data}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
