import { useState, useEffect, useMemo } from 'react';
import {
  Box, Button, Alert, TextField, Autocomplete, Typography, Stack, Chip,
  Stepper, Step, StepLabel, CircularProgress,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';

// Ordered labels for the per-table "moved" counts the dry-run returns. Keys mirror
// the PART A merge contract exactly (child tables re-pointed onto the target).
const MOVED_ROWS = [
  ['mob_catalog',             'Mob catalog'],
  ['mob_spawn_cells',         'Spawn cells'],
  ['mob_spawn_cell_versions', 'Spawn cell versions'],
  ['spawn_version_meta',      'Version metadata'],
  ['zone_bounds',             'Zone bounds'],
  ['zone_maps',               'Zone backgrounds'],
  ['game_zones',              'Zone names'],
  ['mob_names',               'Mob names'],
  ['game_npcs',               'NPCs'],
  ['game_server_hosts',       'Known IPs'],
  ['scan_sessions',           'Scan sessions'],
];

const STEPS = ['Pick source', 'Preview', 'Confirm'];

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Fold one server INTO another. A 3-step stepper:
//   (1) pick the SOURCE (survivor = targetServer) from `servers` minus the target;
//   (2) dry-run PREVIEW — per-table "moved" counts + an irreversible-merge warning;
//   (3) CONFIRM — type the source name to unlock the destructive merge.
// Props: { open, onClose, targetServer, servers, onMerged }.
export default function MergeServerDialog({ open, onClose, targetServer, servers, onMerged }) {
  const { showSnackbar } = useSnackbar();

  const [step, setStep]       = useState(0);
  const [source, setSource]   = useState(null);   // the picked source server row
  const [preview, setPreview] = useState(null);   // dry-run { moved:{…} }
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [confirmText, setConfirmText] = useState('');

  // Reset the whole flow whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSource(null);
    setPreview(null);
    setLoading(false);
    setError('');
    setConfirmText('');
  }, [open]);

  // Source options = every OTHER server (cannot merge a server into itself).
  const options = useMemo(
    () => (servers || []).filter((s) => s.id !== targetServer?.id),
    [servers, targetServer],
  );

  const closeIfIdle = () => { if (!loading) onClose(); };

  // Step 1 → 2: run the dry-run against the picked source.
  const runPreview = async () => {
    if (!source) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.mergeWorldServer(targetServer.id, { source_id: source.id, dry_run: true });
      setPreview(res);
      setStep(1);
    } catch (err) {
      setError(errMsg(err, 'Preview failed'));
    } finally {
      setLoading(false);
    }
  };

  // Step 3: perform the real merge.
  const runMerge = async () => {
    if (!source) return;
    setLoading(true);
    setError('');
    try {
      await adminApi.mergeWorldServer(targetServer.id, { source_id: source.id });
      showSnackbar(`Merged "${source.name}" into "${targetServer?.name}"`);
      onMerged?.();
      onClose();
    } catch (err) {
      const msg = errMsg(err, 'Merge failed');
      setError(msg);
      showSnackbar(msg, 'error');
    } finally {
      setLoading(false);
    }
  };

  const moved = preview?.moved || {};
  const confirmOk = source && confirmText.trim() === (source.name || '').trim();

  return (
    <Dialog open={open} onClose={closeIfIdle} maxWidth="sm" fullWidth>
      <DialogTitle>Merge another server in…</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <Stepper activeStep={step} sx={{ mb: 1 }}>
          {STEPS.map((label) => (
            <Step key={label}><StepLabel>{label}</StepLabel></Step>
          ))}
        </Stepper>

        {error && <Alert severity="error">{error}</Alert>}

        {/* ── Step 1: pick source ─────────────────────────────────────────── */}
        {step === 0 && (
          <>
            <Typography variant="body2" color="text.secondary">
              Choose the server to fold into <strong>{targetServer?.name || 'this server'}</strong>.
              Its spawn data, names, bounds and backgrounds move over; the source is deleted.
            </Typography>
            <Autocomplete
              options={options}
              value={source}
              onChange={(_e, v) => setSource(v)}
              getOptionLabel={(o) => o?.name || `#${o?.id}`}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              disabled={loading}
              renderOption={(props, o) => (
                <Box component="li" {...props} key={o.id}>
                  <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600} noWrap>{o.name || `#${o.id}`}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {o.variant || 'Unknown'} · {o.mob_count || 0} mobs · {o.cell_count || 0} cells
                    </Typography>
                  </Box>
                </Box>
              )}
              renderInput={(params) => (
                <TextField {...params} label="Source server" size="small" autoFocus placeholder="Search servers…" />
              )}
            />
          </>
        )}

        {/* ── Step 2: dry-run preview ─────────────────────────────────────── */}
        {step === 1 && (
          <>
            <Alert severity="warning" icon={<WarningAmberIcon />}>
              This folds <strong>{source?.name}</strong> INTO <strong>{targetServer?.name}</strong> and
              deletes <strong>{source?.name}</strong>. Heat data (spawn cells, catalog, versions) is
              summed; names, bounds and backgrounds keep the target on conflict.{' '}
              <strong>This cannot be undone.</strong>
            </Alert>
            <Typography variant="subtitle2">Rows that will move from the source</Typography>
            <TableContainer sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Table</TableCell>
                    <TableCell align="right">Rows</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {MOVED_ROWS.map(([key, label]) => (
                    <TableRow key={key} hover>
                      <TableCell>{label}</TableCell>
                      <TableCell align="right">
                        <Chip
                          size="small"
                          variant={moved[key] ? 'filled' : 'outlined'}
                          color={moved[key] ? 'primary' : 'default'}
                          label={Number(moved[key] || 0).toLocaleString()}
                          sx={{ height: 22, minWidth: 48 }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {/* ── Step 3: type-to-confirm ─────────────────────────────────────── */}
        {step === 2 && (
          <>
            <Alert severity="error">
              You are about to permanently merge and delete <strong>{source?.name}</strong>. This
              cannot be undone.
            </Alert>
            <Typography variant="body2">
              Type the source name <strong>{source?.name}</strong> to confirm.
            </Typography>
            <TextField
              size="small" fullWidth autoFocus value={confirmText} disabled={loading}
              placeholder={source?.name || ''}
              onChange={(e) => setConfirmText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmOk) runMerge(); }}
            />
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={loading}>Cancel</Button>

        {step > 0 && (
          <Button onClick={() => { setError(''); setStep(step - 1); }} disabled={loading}>
            Back
          </Button>
        )}

        {step === 0 && (
          <Button variant="contained" onClick={runPreview} disabled={!source || loading}>
            {loading ? <CircularProgress size={18} /> : 'Preview'}
          </Button>
        )}
        {step === 1 && (
          <Button variant="contained" color="error" onClick={() => { setError(''); setStep(2); }} disabled={loading}>
            Continue
          </Button>
        )}
        {step === 2 && (
          <Button variant="contained" color="error" onClick={runMerge} disabled={!confirmOk || loading}>
            {loading ? <CircularProgress size={18} /> : 'Merge & delete source'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
