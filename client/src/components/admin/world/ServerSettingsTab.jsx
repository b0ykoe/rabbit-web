import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Stack, Paper, Typography, TextField, MenuItem, Switch, Alert, Button,
  Link, Tooltip, InputAdornment, CircularProgress, Divider,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import { useVariantOptions } from './useVariantOptions.js';
import KnownIpsEditor from './KnownIpsEditor.jsx';
import MergeServerDialog from './MergeServerDialog.jsx';

// Sentinel Select value that reveals the free-text variant field. Variant is free
// text on the server (VARCHAR 32); the managed variant list is just a shortlist —
// a custom value self-registers into game_variants on save (C1 auto-upsert).
const CUSTOM_VARIANT = '__custom__';

// A titled section wrapper — outlined Paper with a heading + optional caption.
function SettingsCard({ title, caption, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" fontWeight={600}>{title}</Typography>
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {caption}
        </Typography>
      )}
      <Box sx={{ mt: caption ? 0 : 1.5 }}>{children}</Box>
    </Paper>
  );
}

// Settings tab for one server. A single scroll column of inline-autosave cards — no
// page-level Save button; each field commits on its own and shows a snackbar. Props:
//   server   — the detail row { id, name, variant, visible, known_ips, ... }
//   onChanged — refetch the parent after a successful mutation
export default function ServerSettingsTab({ server, onChanged }) {
  const navigate = useNavigate();
  const { showSnackbar } = useSnackbar();
  const { options: variantOptions } = useVariantOptions();
  const id = server?.id;

  // ── Identity: name ─────────────────────────────────────────────────────────
  const [name, setName]         = useState(server?.name || '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved]   = useState(false);

  // ── Identity: variant ──────────────────────────────────────────────────────
  const [variantSel, setVariantSel]   = useState('');
  const [variantCustom, setVariantCustom] = useState('');
  const [variantSaving, setVariantSaving] = useState(false);

  // ── Visibility ─────────────────────────────────────────────────────────────
  const [visible, setVisible]   = useState(!!server?.visible);
  const [visSaving, setVisSaving] = useState(false);

  // ── Known IPs (locally mirrored so the editor stays snappy) ────────────────
  const [localIps, setLocalIps] = useState(server?.known_ips || []);
  const [ipsSaving, setIpsSaving] = useState(false);

  // ── Danger zone ────────────────────────────────────────────────────────────
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting]     = useState(false);

  // ── Merge (fold another server into this one) ──────────────────────────────
  const [mergeOpen, setMergeOpen]   = useState(false);
  const [mergeServers, setMergeServers] = useState([]); // source-picker options
  const [mergeLoading, setMergeLoading] = useState(false);

  // Load the server list (source-picker options) when the merge dialog opens.
  const openMerge = async () => {
    setMergeOpen(true);
    setMergeLoading(true);
    try {
      const res = await adminApi.getWorldServers();
      setMergeServers(res?.data || []);
    } catch (err) {
      showSnackbar(errMsg(err, 'Failed to load servers'), 'error');
    } finally {
      setMergeLoading(false);
    }
  };

  // Re-seed local fields whenever the underlying server row OR the loaded variant
  // options change (e.g. refetch after a save, navigating between servers without
  // unmounting, or the variants list arriving async). A variant not in the managed
  // list resolves to the Custom… row so the free-text field is prefilled.
  useEffect(() => {
    setName(server?.name || '');
    const v = server?.variant || '';
    const known = variantOptions.some((o) => o.name === v);
    setVariantSel(known || !v ? v : CUSTOM_VARIANT);
    setVariantCustom(known ? '' : v);
    setVisible(!!server?.visible);
    setLocalIps(server?.known_ips || []);
  }, [server, variantOptions]);

  const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

  // ── Name autosave (blur / Enter) ───────────────────────────────────────────
  const saveName = async () => {
    const nm = name.trim();
    if (!nm || nm === (server?.name || '')) { setName(server?.name || ''); return; }
    setNameSaving(true);
    try {
      await adminApi.updateWorldServer(id, { name: nm });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1800);
      showSnackbar('Name updated');
      onChanged?.();
    } catch (err) {
      showSnackbar(errMsg(err, 'Rename failed'), 'error');
      setName(server?.name || ''); // revert on error
    } finally {
      setNameSaving(false);
    }
  };

  // ── Variant autosave ───────────────────────────────────────────────────────
  const commitVariant = async (nextVariant) => {
    const v = (nextVariant ?? '').trim();
    if (!v || v === (server?.variant || '')) return;
    setVariantSaving(true);
    try {
      await adminApi.updateWorldServer(id, { variant: v });
      showSnackbar('Variant updated');
      onChanged?.();
    } catch (err) {
      showSnackbar(errMsg(err, 'Variant update failed'), 'error');
      // revert selection to reflect the server's persisted value
      const pv = server?.variant || '';
      const known = variantOptions.some((o) => o.name === pv);
      setVariantSel(known || !pv ? pv : CUSTOM_VARIANT);
      setVariantCustom(known ? '' : pv);
    } finally {
      setVariantSaving(false);
    }
  };

  const handleVariantSelect = (e) => {
    const val = e.target.value;
    setVariantSel(val);
    if (val === CUSTOM_VARIANT) return;          // wait for free-text entry
    commitVariant(val);
  };

  // ── Visibility toggle (optimistic) ─────────────────────────────────────────
  const toggleVisible = async (checked) => {
    setVisible(checked); // optimistic
    setVisSaving(true);
    try {
      await adminApi.updateWorldServer(id, { visible: checked });
      showSnackbar(checked ? 'Server made public' : 'Server hidden');
      onChanged?.();
    } catch (err) {
      setVisible(!checked); // roll back
      showSnackbar(errMsg(err, 'Toggle failed'), 'error');
    } finally {
      setVisSaving(false);
    }
  };

  // ── Known-IP diff → scoped add_ips / remove_ips PATCHes ─────────────────────
  const handleIpsChange = async (newIps) => {
    const prev = localIps;
    setLocalIps(newIps); // optimistic, keeps the editor responsive
    const added   = newIps.filter((ip) => !prev.includes(ip));
    const removed = prev.filter((ip) => !newIps.includes(ip));
    if (added.length === 0 && removed.length === 0) return;
    setIpsSaving(true);
    try {
      if (added.length)   await adminApi.updateWorldServer(id, { add_ips: added });
      if (removed.length) await adminApi.updateWorldServer(id, { remove_ips: removed });
      showSnackbar('Known IPs updated');
      onChanged?.();
    } catch (err) {
      setLocalIps(prev); // roll back the optimistic change
      showSnackbar(errMsg(err, 'IP update failed'), 'error');
    } finally {
      setIpsSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    setDeleting(true);
    try {
      await adminApi.deleteWorldServer(id);
      showSnackbar('Server and its spawn data deleted');
      setConfirmDel(false);
      navigate('/admin/world');
    } catch (err) {
      showSnackbar(errMsg(err, 'Delete failed'), 'error');
      setDeleting(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      {/* IDENTITY */}
      <SettingsCard
        title="Identity"
        caption="How this server is labelled across the admin and user maps."
      >
        <Stack spacing={2}>
          <TextField
            label="Name" size="small" value={name} disabled={nameSaving} fullWidth
            inputProps={{ maxLength: 128 }}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
            InputProps={{
              endAdornment: (nameSaving || nameSaved) ? (
                <InputAdornment position="end">
                  {nameSaving
                    ? <CircularProgress size={16} />
                    : <CheckIcon fontSize="small" color="success" />}
                </InputAdornment>
              ) : undefined,
            }}
          />

          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField
              select label="Variant" size="small" value={variantSel} disabled={variantSaving}
              onChange={handleVariantSelect}
              sx={{ minWidth: 200 }}
            >
              {variantOptions.map((v) => (
                <MenuItem key={v.name} value={v.name}>
                  {v.display_name ? `${v.display_name} (${v.name})` : v.name}
                </MenuItem>
              ))}
              <MenuItem value={CUSTOM_VARIANT}>Custom…</MenuItem>
            </TextField>
            {variantSel === CUSTOM_VARIANT && (
              <TextField
                label="Custom variant" size="small" value={variantCustom} disabled={variantSaving}
                autoFocus inputProps={{ maxLength: 32 }} sx={{ minWidth: 200 }}
                onChange={(e) => setVariantCustom(e.target.value)}
                onBlur={() => commitVariant(variantCustom)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }}
              />
            )}
            {variantSaving && <CircularProgress size={16} sx={{ mt: 1.25 }} />}
          </Box>
        </Stack>
      </SettingsCard>

      {/* VISIBILITY */}
      <SettingsCard title="Visibility">
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
          <Switch checked={visible} disabled={visSaving} onChange={(e) => toggleVisible(e.target.checked)} />
          <Typography variant="body2">
            {visible ? 'Public on the user map' : 'Hidden from users'}
          </Typography>
        </Box>
        {visible ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'success.main' }} />
            <Link
              href="/portal/world" target="_blank" rel="noopener"
              underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
            >
              View public map <OpenInNewIcon sx={{ fontSize: 14 }} />
            </Link>
          </Box>
        ) : (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            Not public yet — users cannot see this server.
          </Alert>
        )}
      </SettingsCard>

      {/* KNOWN IPs */}
      <SettingsCard
        title="Known IPs"
        caption="Changes save immediately as they're added or removed."
      >
        <KnownIpsEditor value={localIps} onChange={handleIpsChange} disabled={ipsSaving} />
      </SettingsCard>

      {/* DANGER ZONE */}
      <Paper variant="outlined" sx={{ p: 2.5, borderColor: 'error.light' }}>
        <Typography variant="subtitle1" fontWeight={600} color="error">Danger zone</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Irreversible and destructive actions.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
          <Tooltip title="Fold another server's data into this one, then delete it">
            <span>
              <Button variant="outlined" onClick={openMerge} disabled={mergeLoading && mergeOpen}>
                Merge another server in…
              </Button>
            </span>
          </Tooltip>
          <Divider flexItem orientation="vertical" sx={{ display: { xs: 'none', sm: 'block' } }} />
          <Button color="error" variant="outlined" onClick={() => setConfirmDel(true)}>
            Delete server
          </Button>
        </Stack>
      </Paper>

      {/* Merge dialog — folds a chosen SOURCE server into THIS one (the target),
          then deletes the source. onMerged: the source is gone, so we stay on the
          target and refetch — never navigate away. */}
      <MergeServerDialog
        open={mergeOpen}
        onClose={() => setMergeOpen(false)}
        targetServer={server}
        servers={mergeServers}
        onMerged={() => {
          // The dialog already fired the "Merged X into Y" snackbar; just refetch.
          // The merged-away source is gone — staying on this target is correct.
          setMergeOpen(false);
          onChanged?.();
        }}
      />

      {/* Delete confirmation — mirrors ServerCard's copy. */}
      <Dialog open={confirmDel} onClose={() => !deleting && setConfirmDel(false)}>
        <DialogTitle>Delete server?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes server{' '}
            <strong>{server?.name || `#${id}`}</strong>{' '}
            (#{id}) and <strong>all of its collected spawn data</strong> — mob
            catalog, spawn cells, versions and zone bounds. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(false)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
