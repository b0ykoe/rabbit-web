import { useMemo, useRef, useState } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Switch, FormControlLabel, Link, Tooltip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton,
  Skeleton,
} from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import StatusDot from './StatusDot.jsx';

// A rollup chip for one missing-* count: amber when >0, success "all set" at 0.
function RollupChip({ label, count }) {
  const missing = count > 0;
  return (
    <Chip
      size="small"
      color={missing ? 'warning' : 'success'}
      variant={missing ? 'outlined' : 'filled'}
      label={missing ? `${count} ${label}` : `${label}: all set`}
      sx={{ height: 22 }}
    />
  );
}

// Per-server names import, driven by a hidden file input owned by the header (so a
// single control covers the whole-server "Named" fix from any row).
function useNamesImport(serverId, refetch, showSnackbar) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const onPicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const res = await adminApi.importServerNames(serverId, file);
      showSnackbar(`Names imported — ${res?.zones ?? 0} zones, ${res?.mobs ?? 0} monsters`);
      refetch?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Name import failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  const trigger = () => inputRef.current?.click();
  const input = (
    <input ref={inputRef} type="file" accept=".json,.csv" hidden onChange={onPicked} />
  );
  return { input, trigger, busy };
}

// Replaces the old zone-coverage table. A dense, sticky-header matrix over
// overview.zones with a rollup chip row + "Show only incomplete" filter, and
// inline fix affordances per cell:
//   Named      — StatusDot; missing -> triggers whole-server names import.
//   Spawn data — StatusDot state="inert" when missing (bot-recorded, no upload).
//   Bounds     — missing -> inline importZoneBounds(id, zone, file) upload.
//   Background — missing -> inline uploadZoneMap(id, zone, file) upload.
// Both zone uploads refetch()+bumpNonce() so any embedded render cache-busts.
export default function CoverageMatrix({ server, overview, refetch, bumpNonce, onOpenZoneMap, loading }) {
  const { showSnackbar } = useSnackbar();
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const names = useNamesImport(server?.id, refetch, showSnackbar);

  const zones  = overview?.zones || [];
  const counts = overview?.counts || {};

  const afterUpload = () => { refetch?.(); bumpNonce?.(); };

  const onBoundsPicked = async (zoneNo, file) => {
    if (!file) return;
    try {
      await adminApi.importZoneBounds(server.id, zoneNo, file);
      showSnackbar(`Bounds imported for zone ${zoneNo}`);
      afterUpload();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Bounds import failed', 'error');
    }
  };

  const onBackgroundPicked = async (zoneNo, file) => {
    if (!file) return;
    try {
      await adminApi.uploadZoneMap(server.id, zoneNo, file);
      showSnackbar(`Background uploaded for zone ${zoneNo}`);
      afterUpload();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Background upload failed', 'error');
    }
  };

  const rows = useMemo(() => {
    if (!onlyIncomplete) return zones;
    return zones.filter((z) => !z.name || !z.has_data || !z.has_bounds || !z.has_background);
  }, [zones, onlyIncomplete]);

  if (loading && !overview) {
    return (
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Skeleton variant="text" width="30%" height={28} />
        <Skeleton variant="rectangular" height={220} sx={{ mt: 1.5, borderRadius: 1 }} />
      </Paper>
    );
  }

  // Empty state — no zones recorded yet.
  if ((counts.zones_total ?? zones.length) === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        {names.input}
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>
          No zones yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Import a reference name list to seed zones, or grant a recording key so a bot
          starts collecting spawns for this server.
        </Typography>
        <Link component="button" type="button" underline="hover" onClick={names.trigger} disabled={names.busy}>
          {names.busy ? 'Importing…' : 'Import names.json / zones.csv'}
        </Link>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      {names.input}

      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        sx={{ mb: 2, alignItems: { md: 'center' }, justifyContent: 'space-between' }}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.75 }}>
            Zone coverage
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" sx={{ rowGap: 0.75 }}>
            <RollupChip label="unnamed" count={counts.missing_name ?? 0} />
            <RollupChip label="no spawn data" count={counts.missing_data ?? 0} />
            <RollupChip label="no bounds" count={counts.missing_bounds ?? 0} />
            <RollupChip label="no background" count={counts.missing_background ?? 0} />
          </Stack>
        </Box>
        <FormControlLabel
          control={<Switch size="small" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} />}
          label={<Typography variant="body2">Show only incomplete</Typography>}
        />
      </Stack>

      <TableContainer sx={{ maxHeight: 420 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Zone</TableCell>
              <TableCell align="center">Named</TableCell>
              <TableCell align="center">Spawn data</TableCell>
              <TableCell align="center">Bounds</TableCell>
              <TableCell align="center">Background</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((z) => (
              <TableRow key={z.zone_no} hover>
                <TableCell>
                  <Link
                    component="button"
                    type="button"
                    underline="hover"
                    onClick={() => onOpenZoneMap?.(z.zone_no)}
                    sx={{ textAlign: 'left' }}
                  >
                    <Box component="span" sx={{ fontWeight: 600 }}>#{z.zone_no}</Box>
                    {z.name && (
                      <Box component="span" sx={{ ml: 0.75, color: 'text.secondary' }}>{z.name}</Box>
                    )}
                    {!z.name && (
                      <Box component="span" sx={{ ml: 0.75, color: 'text.disabled', fontStyle: 'italic' }}>
                        unnamed
                      </Box>
                    )}
                  </Link>
                </TableCell>

                {/* Named — whole-server import when missing. */}
                <TableCell align="center">
                  {z.name ? (
                    <StatusDot state="done" title="Named" />
                  ) : (
                    <Tooltip title="Import names.json / zones.csv (whole server)">
                      <Box
                        component="span"
                        role="button"
                        tabIndex={0}
                        onClick={names.trigger}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') names.trigger(); }}
                        sx={{ cursor: 'pointer', display: 'inline-flex' }}
                      >
                        <StatusDot state="missing" />
                      </Box>
                    </Tooltip>
                  )}
                </TableCell>

                {/* Spawn data — inert when missing (bot-recorded, no upload). */}
                <TableCell align="center">
                  <StatusDot
                    state={z.has_data ? 'done' : 'inert'}
                    title={z.has_data ? 'Spawn data collected' : 'No spawn data yet — recorded by a bot, not uploadable'}
                  />
                </TableCell>

                {/* Bounds — inline importZoneBounds upload when missing. */}
                <TableCell align="center">
                  {z.has_bounds ? (
                    <StatusDot state="done" title="Bounds set" />
                  ) : (
                    <Tooltip title="Import zone_<N>_calib.json to set bounds">
                      <IconButton
                        component="label"
                        size="small"
                        color="warning"
                      >
                        <StatusDot state="missing" size={16} />
                        <input
                          type="file"
                          accept=".json"
                          hidden
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onBoundsPicked(z.zone_no, f); }}
                        />
                      </IconButton>
                    </Tooltip>
                  )}
                </TableCell>

                {/* Background — inline uploadZoneMap upload when missing. */}
                <TableCell align="center">
                  {z.has_background ? (
                    <StatusDot state="done" title="Background uploaded" />
                  ) : (
                    <Tooltip title="Upload a zone map image (SVG / PNG)">
                      <IconButton
                        component="label"
                        size="small"
                        color="warning"
                      >
                        <UploadFileIcon sx={{ fontSize: 16 }} />
                        <input
                          type="file"
                          accept="image/svg+xml,image/png,.svg,.png"
                          hidden
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onBackgroundPicked(z.zone_no, f); }}
                        />
                      </IconButton>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    {onlyIncomplete ? 'Every zone is fully covered.' : 'No zones to show.'}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
