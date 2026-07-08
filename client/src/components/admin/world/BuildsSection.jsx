import { useState, useEffect, useCallback } from 'react';
import {
  Box, Stack, Paper, Typography, Button, Chip, IconButton, Tooltip, Skeleton, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, TextField,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LockIcon from '@mui/icons-material/Lock';
import MemoryIcon from '@mui/icons-material/Memory';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import OffsetFieldTable, { parseIntFlexible, hasInvalidOverride, fieldHex } from './OffsetFieldTable.jsx';

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Fixed-width stamp hex (0x%08X). Null → em dash. Mirrors ServerOffsetsTab.toHex.
function toHex(n) {
  return n == null ? '—' : '0x' + (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Relative "time ago" from epoch seconds — matches ServerOffsetsTab.fmtRelative.
function fmtRelative(sec) {
  if (!sec) return 'never';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

// ── Per-build value editor ────────────────────────────────────────────────────
// Opens ONE build's per-build overrides. The Base column is the build's INHERITED
// effective (per the getServerBuildOffsets effective[] — general override ?? template
// base), the Override column is the per-build delta. Reuses OffsetFieldTable, whose
// "Effective" column then resolves per-build override ?? inherited-base. Save REPLACES
// the per-build overrides; a field left empty drops that per-build delta.
// Props: { open, onClose, serverId, build, onSaved }
function BuildOffsetsDialog({ open, onClose, serverId, build, onSaved }) {
  const { showSnackbar } = useSnackbar();
  const buildId = build?.id;

  const [data, setData]       = useState(null);   // getServerBuildOffsets payload | null
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [overrides, setOverrides] = useState({}); // field_name -> rawString
  const [dirty, setDirty]     = useState(false);
  const [saving, setSaving]   = useState(false);

  // Seed the working copy from a freshly-loaded payload.
  const seedFrom = useCallback((payload) => {
    const map = {};
    for (const o of (payload?.overrides || [])) {
      map[o.field_name] = '0x' + (Number(o.value) >>> 0).toString(16);
    }
    setOverrides(map);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (serverId == null || buildId == null) return;
    setLoading(true);
    setError(null);
    // Clear any stale working copy so a failed load can't leave Save enabled over
    // the previous build's values.
    setDirty(false);
    setOverrides({});
    try {
      const res = await adminApi.getServerBuildOffsets(serverId, buildId);
      setData(res);
      seedFrom(res);
    } catch (err) {
      setError(err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [serverId, buildId, seedFrom]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const onFieldChange = useCallback((fieldName, raw) => {
    setOverrides((prev) => ({ ...prev, [fieldName]: raw }));
    setDirty(true);
  }, []);

  const invalid = hasInvalidOverride(overrides);

  // The Base column = this build's inherited effective (general ?? template base).
  // OffsetFieldTable reads base from effective[].base_value first, then catalog.
  const catalog   = data?.catalog || [];
  const effective = data?.effective || [];

  const handleSave = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    try {
      const out = [];
      for (const [field_name, raw] of Object.entries(overrides)) {
        if (raw === '' || raw == null) continue;
        const p = parseIntFlexible(raw);
        if (!p.ok || p.value == null) continue; // guarded by `invalid`, belt-and-braces
        out.push({ field_name, value: p.value });
      }
      const res = await adminApi.putServerBuildOffsets(serverId, buildId, { overrides: out });
      showSnackbar(`Per-build overrides saved — ${res?.count ?? out.length} field(s). The build's signed blob is now invalidated; re-sign to apply.`);
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

  const label = build?.label ? `${build.label} · ${toHex(build?.stamp)}` : toHex(build?.stamp);

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="md" fullWidth>
      <DialogTitle>Per-build overrides — {label}</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        {loading ? (
          <Stack spacing={2}>
            <Skeleton variant="rectangular" height={40} sx={{ borderRadius: 1 }} />
            <Skeleton variant="rectangular" height={320} sx={{ borderRadius: 1 }} />
          </Stack>
        ) : error ? (
          <Alert severity="error">{errMsg(error, 'Failed to load build offsets.')}</Alert>
        ) : (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Base = this build's <strong>inherited effective</strong> (server general override, else
              template base). Set an override to shift a field for this Engine.dll only — these are the
              deltas that move per game patch. Saving REPLACES the per-build overrides; a field left
              empty drops its per-build delta.
            </Typography>
            <OffsetFieldTable
              catalog={catalog}
              effective={effective}
              value={overrides}
              onChange={onFieldChange}
            />
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
          {saving ? 'Saving…' : 'Save overrides'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Add-build dialog ──────────────────────────────────────────────────────────
// Creates a build row from an Engine.dll stamp + size (hex-or-decimal) + optional
// label. Both stamp and size are required and parsed via parseIntFlexible.
function AddBuildDialog({ open, onClose, serverId, onCreated }) {
  const { showSnackbar } = useSnackbar();
  const [stampStr, setStampStr] = useState('');
  const [sizeStr, setSizeStr]   = useState('');
  const [label, setLabel]       = useState('');
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    if (open) { setStampStr(''); setSizeStr(''); setLabel(''); setSaving(false); }
  }, [open]);

  const stampParsed = parseIntFlexible(stampStr);
  const sizeParsed  = parseIntFlexible(sizeStr);
  const canCreate = stampParsed.ok && stampParsed.value != null
    && sizeParsed.ok && sizeParsed.value != null;

  const handleCreate = async () => {
    if (!canCreate || saving) return;
    setSaving(true);
    try {
      const body = { stamp: stampParsed.value, size: sizeParsed.value };
      const nm = label.trim();
      if (nm) body.label = nm;
      await adminApi.createServerBuild(serverId, body);
      showSnackbar('Build added');
      onCreated?.();
      onClose();
    } catch (err) {
      showSnackbar(errMsg(err, 'Create failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>Add build</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem', mb: 2 }}>
          One build = one Engine.dll (a game patch). Enter its PE fingerprint — export it
          from the bot's <strong>Dev &gt; Exporter</strong> tab. Values accept <code>0x…</code> or decimal.
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            label="TimeDateStamp"
            size="small"
            fullWidth
            autoFocus
            value={stampStr}
            disabled={saving}
            error={stampStr !== '' && !stampParsed.ok}
            placeholder="0x00000000"
            helperText={stampStr !== '' && !stampParsed.ok ? 'Enter hex (0x…) or a decimal integer' : undefined}
            onChange={(e) => setStampStr(e.target.value)}
            inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
          />
          <TextField
            label="SizeOfImage"
            size="small"
            fullWidth
            value={sizeStr}
            disabled={saving}
            error={sizeStr !== '' && !sizeParsed.ok}
            placeholder="0x00000000"
            helperText={sizeStr !== '' && !sizeParsed.ok ? 'Enter hex (0x…) or a decimal integer' : undefined}
            onChange={(e) => setSizeStr(e.target.value)}
            inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
          />
          <TextField
            label="Label (optional)"
            size="small"
            fullWidth
            value={label}
            disabled={saving}
            inputProps={{ maxLength: 64 }}
            placeholder="e.g. 2026-07 patch"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={!canCreate || saving}>
          {saving ? 'Adding…' : 'Add build'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Sign dialog (single build OR re-sign all) ─────────────────────────────────
// Password-gates signServerBuild / signAllServerBuilds. Stays open on failure so
// the admin can retry (mirrors SignOffsetsDialog's inline error mapping). When
// `build` is null the dialog signs ALL of the server's builds.
function SignBuildDialog({ open, onClose, serverId, build, onSigned }) {
  const { showSnackbar } = useSnackbar();
  const [password, setPassword] = useState('');
  const [signing, setSigning]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    if (open) { setPassword(''); setSigning(false); setError(''); }
  }, [open]);

  const all = !build;

  const mapError = (err) => {
    const status = err?.status;
    if (status === 403) return 'Wrong signing password.';
    if (status === 409) return err?.data?.error || 'Generate a signing key first.';
    if (status === 400) return err?.data?.error || 'Set the build fingerprint first.';
    return err?.data?.error || err?.message || 'Signing failed.';
  };

  const handleSign = async () => {
    if (!password || signing) return;
    setError('');
    setSigning(true);
    try {
      if (all) {
        const res = await adminApi.signAllServerBuilds(serverId, password);
        showSnackbar(`Signed ${res?.signed ?? 0} build(s)`);
      } else {
        await adminApi.signServerBuild(serverId, build.id, password);
        showSnackbar('Build signed');
      }
      onSigned?.();
      onClose();
    } catch (err) {
      setError(mapError(err)); // stay open so the admin can retry
    } finally {
      setSigning(false);
    }
  };

  const label = build?.label ? `${build.label} · ${toHex(build?.stamp)}` : toHex(build?.stamp);

  return (
    <Dialog open={open} onClose={() => !signing && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{all ? 'Re-sign all builds' : 'Sign build'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          {all
            ? <>Re-signs <strong>every</strong> build of this server with its own merged effective set. You'll need this password each time you sign; it is <strong>never stored</strong>.</>
            : <>Signs the merged effective set for build <strong>{label}</strong>. You'll need this password every time you sign; it is <strong>never stored</strong>.</>}
        </DialogContentText>

        {error && <Alert severity="error">{error}</Alert>}

        <TextField
          label="Signing password"
          type="password"
          size="small"
          fullWidth
          autoFocus
          value={password}
          disabled={signing}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && password && !signing) handleSign(); }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={signing}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<LockIcon />}
          onClick={handleSign}
          disabled={!password || signing}
        >
          {signing ? 'Signing…' : (all ? 'Re-sign all' : 'Sign')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// The per-server Builds section (P4 — the PER-PATCH tier). Lists one server's builds
// (one row per Engine.dll stamp) with per-build override counts + signed status, and
// lets an admin add builds, edit each build's per-build overrides (the deltas that
// shift per game patch), sign one build, re-sign all, and delete. Each build carries
// its OWN signed blob keyed to its stamp so a bot fetches the blob matching its dll.
// Props: { serverId, serverName }.
export default function BuildsSection({ serverId, serverName }) {
  const { showSnackbar } = useSnackbar();
  const [rows, setRows]   = useState(null);   // null = loading
  const [error, setError] = useState(null);

  const [addOpen, setAddOpen]       = useState(false);
  const [editTarget, setEditTarget] = useState(null);   // build open in the value editor
  const [signTarget, setSignTarget] = useState(null);   // { build } | { all:true } for sign dialog
  const [delTarget, setDelTarget]   = useState(null);   // build pending delete
  const [deleting, setDeleting]     = useState(false);

  const load = useCallback(async () => {
    if (serverId == null) return;
    setError(null);
    try { setRows(await adminApi.getServerBuilds(serverId)); }
    catch (err) { setError(err); setRows([]); }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await adminApi.deleteServerBuild(serverId, delTarget.id);
      showSnackbar(`Build ${toHex(delTarget.stamp)} deleted`);
      setDelTarget(null);
      load();
    } catch (err) {
      showSnackbar(errMsg(err, 'Delete failed'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <MemoryIcon fontSize="small" color="action" />
        <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
          Per-build overrides
        </Typography>
        <Tooltip title={rows && rows.length ? '' : 'Add a build first'}>
          <span>
            <Button
              size="small"
              variant="text"
              startIcon={<LockIcon fontSize="small" />}
              onClick={() => setSignTarget({ all: true })}
              disabled={!rows || rows.length === 0}
            >
              Re-sign all builds
            </Button>
          </span>
        </Tooltip>
        <Button size="small" variant="outlined" startIcon={<AddIcon fontSize="small" />} onClick={() => setAddOpen(true)}>
          Add build
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        One build = one Engine.dll (a game patch). Its overrides are the per-patch deltas that
        layer ABOVE the server's general overrides (effective = per-build &gt; general &gt; template).
        Each build carries its OWN signed blob keyed to its stamp, so a bot fetches the blob
        matching its Engine.dll.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errMsg(error, 'Failed to load builds.')}</Alert>}

      {rows == null ? (
        <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 1 }} />
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No builds yet — add one per Engine.dll stamp you want to ship offsets for.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Stamp</TableCell>
                <TableCell>Label</TableCell>
                <TableCell align="right">SizeOfImage</TableCell>
                <TableCell align="right">Overrides</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600 }}>
                    {toHex(b.stamp)}
                  </TableCell>
                  <TableCell sx={{ color: b.label ? 'text.primary' : 'text.secondary', fontSize: '0.8rem' }}>
                    {b.label || '—'}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                    {fieldHex(b.size)}
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      variant="outlined"
                      color={b.override_count ? 'primary' : 'default'}
                      label={b.override_count}
                      sx={{ height: 20 }}
                    />
                  </TableCell>
                  <TableCell>
                    {b.signed ? (
                      b.stale ? (
                        <Tooltip title="The signed blob no longer matches this build's current effective set (overrides/label/template changed) — re-sign to apply.">
                          <Chip
                            size="small" color="warning" variant="filled"
                            label="Out of date — re-sign"
                            sx={{ height: 22 }}
                          />
                        </Tooltip>
                      ) : (
                        <Chip
                          size="small" color="success" variant="filled"
                          label={`Signed ${fmtRelative(b.signed_at)}`}
                          sx={{ height: 22 }}
                        />
                      )
                    ) : (
                      <Chip size="small" color="default" variant="outlined" label="Not signed" sx={{ height: 22 }} />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit values">
                      <IconButton size="small" onClick={() => setEditTarget(b)}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Sign build">
                      <IconButton size="small" onClick={() => setSignTarget({ build: b })}>
                        <LockIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete build">
                      <IconButton size="small" onClick={() => setDelTarget(b)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add build */}
      <AddBuildDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        serverId={serverId}
        onCreated={load}
      />

      {/* Per-build value editor */}
      <BuildOffsetsDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        serverId={serverId}
        build={editTarget}
        onSaved={load}
      />

      {/* Sign one build OR re-sign all */}
      <SignBuildDialog
        open={!!signTarget}
        onClose={() => setSignTarget(null)}
        serverId={serverId}
        build={signTarget?.build ?? null}
        onSigned={load}
      />

      {/* Delete confirm */}
      <Dialog open={!!delTarget} onClose={() => !deleting && setDelTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete build?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete build <strong>{toHex(delTarget?.stamp)}</strong>
            {delTarget?.label ? <> (<strong>{delTarget.label}</strong>)</> : null}? Its per-build
            overrides and signed blob are removed. Bots on this Engine.dll fall back to the
            server-level blob until you re-add + re-sign.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDelTarget(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
