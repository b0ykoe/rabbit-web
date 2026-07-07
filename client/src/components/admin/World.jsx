import { useState, useEffect } from 'react';
import {
  Box, Typography, Button, TextField, Alert, Paper, Chip,
  Table, TableHead, TableRow, TableCell, TableBody, Tooltip, IconButton,
  Switch, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
  Collapse, CircularProgress, Menu, MenuItem, Autocomplete,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/VpnKey';
import SaveIcon from '@mui/icons-material/Save';
import DeleteIcon from '@mui/icons-material/Delete';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ImageIcon from '@mui/icons-material/Image';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import DownloadIcon from '@mui/icons-material/Download';
import { adminApi, worldApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

const fmtSec = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');

// Human label for a license option in the picker: "<key> — <name||email||unassigned>"
// (append the email in parens when both a name AND an email exist), and a muted
// "(inactive)" suffix for revoked/inactive licenses.
const licenseOptionLabel = (o) => {
  if (!o) return '';
  const who = o.user_name || o.user_email || 'unassigned';
  const withEmail = o.user_name && o.user_email ? `${who} (${o.user_email})` : who;
  return `${o.license_key} — ${withEmail}${o.active ? '' : ' (inactive)'}`;
};

// Shared license picker (MUI Autocomplete over getLicensesAll). Loads the license
// list once when `active` flips true (dialog/panel opens), exposes loading + error
// on the field, filters on the option label, and calls onPick(license_key|'') on
// selection. The license_key is the anchor the mint signs with.
function LicensePicker({ active, value, onPick, disabled }) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true); setError('');
    adminApi.getLicensesAll()
      .then((r) => { if (alive) setOptions(r?.licenses || []); })
      .catch((err) => { if (alive) setError(err.data?.error || err.message || 'Failed to load licenses'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active]);

  const selected = options.find((o) => o.license_key === value) || null;

  return (
    <Autocomplete
      fullWidth size="small" disabled={disabled}
      options={options} loading={loading} value={selected}
      onChange={(_, opt) => onPick(opt ? opt.license_key : '')}
      getOptionLabel={licenseOptionLabel}
      isOptionEqualToValue={(o, v) => o.license_key === v.license_key}
      noOptionsText={loading ? 'Loading…' : 'No licenses'}
      renderInput={(params) => (
        <TextField
          {...params}
          label="License (user)"
          error={!!error}
          helperText={error || 'Pick the user’s license — a recording key will be created for you to give them.'}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  );
}

// Per-row "Export CSV" control: a small menu offering whole-server all-time
// (default) plus latest-version-only. Streams the admin-only CSV by opening the
// worldApi.exportCsvUrl string in a new tab (browser handles the download).
function ExportCsvMenu({ serverId }) {
  const [anchor, setAnchor] = useState(null);
  const open = Boolean(anchor);

  const download = (opts) => {
    setAnchor(null);
    // Same-origin authed GET; the session cookie rides along automatically.
    window.open(worldApi.exportCsvUrl(serverId, opts), '_blank', 'noopener');
  };

  return (
    <>
      <Tooltip title="Export spawn CSV (admin only)">
        <span>
          <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)}>
            <DownloadIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Menu anchorEl={anchor} open={open} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => download({ version: 'all' })}>Whole server · all versions</MenuItem>
        <MenuItem onClick={() => download({ version: 'latest' })}>Whole server · latest version only</MenuItem>
      </Menu>
    </>
  );
}

// "Grant recording key" dialog — pick a user (id) or license key + a duration
// window (default 6h, max 72h) and mint a scope:ingest token. On success the raw
// token is shown ONCE with a copy button + expiry. A 409 ("user already has an
// active token") is handled cleanly: the existing jti is surfaced with an option
// to revoke it (via the existing revoke endpoint) and retry.
function GrantRecordingKeyDialog({ open, onClose }) {
  const { showSnackbar } = useSnackbar();
  const [licenseKey, setLicenseKey]     = useState('');
  const [durationHours, setDurationHours] = useState('6');
  const [minting, setMinting]           = useState(false);
  const [minted, setMinted]             = useState(null);   // { token, jti, expires_at }
  const [error, setError]               = useState('');
  const [conflict, setConflict]         = useState(null);   // existing active jti on 409
  const [revoking, setRevoking]         = useState(false);

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setLicenseKey(''); setDurationHours('6');
      setMinting(false); setMinted(null); setError(''); setConflict(null); setRevoking(false);
    }
  }, [open]);

  const buildBody = () => {
    if (!licenseKey) return null;
    return {
      license_key: licenseKey,
      duration_hours: Math.min(72, Math.max(1, Math.floor(Number(durationHours)) || 6)),
    };
  };

  const handleMint = async () => {
    setError(''); setMinted(null); setConflict(null);
    const body = buildBody();
    if (!body) { setError('Pick a license first'); return; }
    setMinting(true);
    try {
      const res = await adminApi.mintIngestToken(body);
      setMinted(res);
      showSnackbar('Recording key minted');
    } catch (err) {
      // 409 = an active token already exists; server returns its jti.
      if (err.status === 409 || err.data?.jti) {
        setConflict(err.data?.jti || null);
        setError(err.data?.error || 'This user already has an active recording token.');
      } else {
        setError(err.data?.error || err.message || 'Mint failed');
      }
    } finally {
      setMinting(false);
    }
  };

  const handleRevokeConflict = async () => {
    if (!conflict) return;
    setRevoking(true);
    try {
      await adminApi.revokeIngestToken(conflict);
      showSnackbar('Existing token revoked');
      setConflict(null); setError('');
      await handleMint();   // retry now that the slot is free
    } catch (err) {
      setError(err.data?.error || err.message || 'Revoke failed');
    } finally {
      setRevoking(false);
    }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); showSnackbar('Copied to clipboard'); };
  const fmtTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '—');
  const busy = minting || revoking;

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>Grant recording key</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          Mints a short-lived <code>scope:ingest</code> token bound to a real active license.
          Paste it into a Debug bot's Scan tab to enable spawn upload. Shown <strong>once</strong> — copy it now.
        </DialogContentText>
        {error && (
          <Alert severity={conflict ? 'warning' : 'error'} action={
            conflict ? (
              <Button color="inherit" size="small" disabled={busy} onClick={handleRevokeConflict}>
                {revoking ? 'Revoking…' : 'Revoke & retry'}
              </Button>
            ) : undefined
          }>
            {error}
            {conflict && <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>Existing jti <code>{conflict}</code></Typography>}
          </Alert>
        )}

        {!minted && (
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Box sx={{ flex: 1, minWidth: 240 }}>
              <LicensePicker active={open} value={licenseKey} onPick={setLicenseKey} disabled={busy} />
            </Box>
            <TextField
              label="Window (hours)" size="small" type="number" value={durationHours} disabled={busy}
              onChange={(e) => setDurationHours(e.target.value)}
              inputProps={{ min: 1, max: 72 }} helperText="default 6, max 72" sx={{ minWidth: 130 }}
            />
          </Box>
        )}

        {minted && (
          <Alert severity="success">
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
              jti <code>{minted.jti}</code> · expires {fmtTime(minted.expires_at)}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                value={minted.token} size="small" fullWidth
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: '0.7rem' } }}
              />
              <Tooltip title="Copy token">
                <IconButton size="small" onClick={() => copy(minted.token)}><ContentCopyIcon fontSize="small" /></IconButton>
              </Tooltip>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Copy now — the token is shown only once and is not retrievable later, only revocable.
            </Typography>
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{minted ? 'Done' : 'Cancel'}</Button>
        {!minted && (
          <Button variant="contained" startIcon={<KeyIcon />} onClick={handleMint} disabled={busy}>
            {minting ? 'Minting…' : 'Mint key'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ── Servers management (super-admin) ──────────────────────────────────────────
// Additive: list every tracked game_server, edit its public display_name, toggle
// visible (whether it surfaces on the user map), and destructively delete a
// server + ALL its spawn data. Wraps the admin.world.js server-mgmt endpoints.
function ServersPanel() {
  const { showSnackbar } = useSnackbar();
  const { data, loading, refetch } = useApi(() => adminApi.getWorldServers(), []);
  const [names, setNames]     = useState({});   // { [id]: editedDisplayName }
  const [savingId, setSavingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null); // server row pending delete
  const [deleting, setDeleting] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);  // "Grant recording key" dialog

  const rows = data?.data || [];

  const nameFor = (r) => (names[r.id] !== undefined ? names[r.id] : (r.display_name || ''));

  const handleSaveName = async (r) => {
    setSavingId(r.id);
    try {
      await adminApi.updateWorldServer(r.id, { display_name: nameFor(r) });
      showSnackbar('Display name saved');
      setNames((m) => { const n = { ...m }; delete n[r.id]; return n; });
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Save failed', 'error');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleVisible = async (r) => {
    setTogglingId(r.id);
    try {
      await adminApi.updateWorldServer(r.id, { visible: !r.visible });
      showSnackbar(!r.visible ? 'Server made public' : 'Server hidden');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Toggle failed', 'error');
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      await adminApi.deleteWorldServer(confirmDel.id);
      showSnackbar('Server and its spawn data deleted');
      setConfirmDel(null);
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Box sx={{ mb: 5 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 1 }}>
        <Typography variant="h6" fontWeight={600}>Monster Map — Servers</Typography>
        <Button
          size="small" variant="outlined" startIcon={<KeyIcon fontSize="small" />}
          onClick={() => setGrantOpen(true)}
        >
          Grant recording key
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Every tracked game server. Set a public <strong>display name</strong>, toggle
        {' '}<strong>Visible</strong> to publish/hide a server on the user map, export its
        {' '}<strong>spawn CSV</strong>, or delete a server together with all of its collected
        spawn data.
      </Typography>

      <Paper variant="outlined">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>IP</TableCell>
                <TableCell>Variant</TableCell>
                <TableCell>Port</TableCell>
                <TableCell sx={{ minWidth: 220 }}>Display name</TableCell>
                <TableCell align="center">Visible</TableCell>
                <TableCell align="right">Mobs</TableCell>
                <TableCell align="right">Cells</TableCell>
                <TableCell>Last seen</TableCell>
                <TableCell align="right"></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && <TableRow><TableCell colSpan={10}>Loading…</TableCell></TableRow>}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={10}><Typography variant="caption" color="text.disabled">No servers tracked yet.</Typography></TableCell></TableRow>
              )}
              {rows.map((r) => {
                const dirty = names[r.id] !== undefined && names[r.id] !== (r.display_name || '');
                return (
                  <TableRow key={r.id}>
                    <TableCell>{r.id}</TableCell>
                    <TableCell><Typography variant="caption" fontFamily="monospace">{r.ip}</Typography></TableCell>
                    <TableCell>{r.variant ?? '—'}</TableCell>
                    <TableCell>{r.port ?? '—'}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <TextField
                          size="small" value={nameFor(r)} placeholder="(unnamed)"
                          onChange={(e) => setNames((m) => ({ ...m, [r.id]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter' && dirty) handleSaveName(r); }}
                          sx={{ minWidth: 180 }}
                        />
                        <Tooltip title="Save display name">
                          <span>
                            <IconButton size="small" disabled={!dirty || savingId === r.id} onClick={() => handleSaveName(r)}>
                              <SaveIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    </TableCell>
                    <TableCell align="center">
                      <Switch
                        size="small" checked={!!r.visible} disabled={togglingId === r.id}
                        onChange={() => handleToggleVisible(r)}
                      />
                    </TableCell>
                    <TableCell align="right">{r.mob_count ?? 0}</TableCell>
                    <TableCell align="right">{r.cell_count ?? 0}</TableCell>
                    <TableCell><Typography variant="caption" color="text.secondary">{fmtSec(r.last_seen)}</Typography></TableCell>
                    <TableCell align="right">
                      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        <ExportCsvMenu serverId={r.id} />
                        <Tooltip title="Delete server + all spawn data">
                          <IconButton size="small" color="error" onClick={() => setConfirmDel(r)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Paper>

      <Dialog open={!!confirmDel} onClose={() => !deleting && setConfirmDel(null)}>
        <DialogTitle>Delete server?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes server{' '}
            <strong>{confirmDel?.display_name || confirmDel?.ip}</strong>{' '}
            (#{confirmDel?.id}) and <strong>all of its collected spawn data</strong> — mob
            catalog, spawn cells, versions and zone bounds. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <GrantRecordingKeyDialog open={grantOpen} onClose={() => setGrantOpen(false)} />
    </Box>
  );
}

const fmtBytes = (n) => {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

// One data-zone row inside the per-server backgrounds panel: shows the zone's
// background status (missing vs present + orig_name/size/thumbnail) and provides
// an Upload (.svg/.png behind a Button) + Delete-with-confirm control.
function ZoneMapRow({ serverId, zone, onMutated }) {
  const { showSnackbar } = useSnackbar();
  const [busy, setBusy]       = useState(false);   // upload/delete in flight
  const [confirmDel, setConfirmDel] = useState(false);
  const has = !!zone.has_image;

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    setBusy(true);
    try {
      await adminApi.uploadZoneMap(serverId, zone.zone_no, file);
      showSnackbar(`Background for zone ${zone.zone_no} uploaded`);
      onMutated?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Upload failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await adminApi.deleteZoneMap(serverId, zone.zone_no);
      showSnackbar(`Background for zone ${zone.zone_no} deleted`);
      setConfirmDel(false);
      onMutated?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Delete failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <TableRow>
      <TableCell>Zone {zone.zone_no}</TableCell>
      <TableCell>
        {has ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box
              component="img"
              src={worldApi.zoneMapUrl(serverId, zone.zone_no)}
              alt=""
              sx={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 0.5, border: '1px solid', borderColor: 'divider', bgcolor: 'rgba(0,0,0,0.2)' }}
            />
            <Box>
              <Chip icon={<ImageIcon />} label="present" size="small" color="success" variant="outlined" />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                {zone.image?.orig_name || '—'}{zone.image?.byte_size != null ? ` · ${fmtBytes(zone.image.byte_size)}` : ''}
              </Typography>
            </Box>
          </Box>
        ) : (
          <Chip label="Background missing" size="small" color="warning" variant="outlined" />
        )}
      </TableCell>
      <TableCell align="right">
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {busy && <CircularProgress size={16} sx={{ mr: 0.5 }} />}
          <Button
            component="label" size="small" variant="outlined"
            startIcon={<CloudUploadIcon fontSize="small" />} disabled={busy}
          >
            {has ? 'Replace' : 'Upload'}
            <input type="file" hidden accept=".svg,.png" onChange={handleFile} />
          </Button>
          {has && (
            <Tooltip title="Delete background">
              <span>
                <IconButton size="small" color="error" disabled={busy} onClick={() => setConfirmDel(true)}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>

        <Dialog open={confirmDel} onClose={() => !busy && setConfirmDel(false)}>
          <DialogTitle>Delete background?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              The background for <strong>Zone {zone.zone_no}</strong> will be deleted. The
              spawn data is left untouched.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</Button>
            <Button color="error" variant="contained" onClick={handleDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogActions>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}

// Per-server expandable body listing every data-zone + its background status.
// Fetches lazily on first expand via listZoneMaps and refetches after mutations.
function BackgroundsServerRow({ server }) {
  const [open, setOpen]       = useState(false);
  const [zones, setZones]     = useState(null);   // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.listZoneMaps(server.id);
      setZones(res?.data || []);
    } catch (err) {
      setError(err.data?.error || err.message || 'Load failed');
      setZones([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && zones === null) load();
  };

  const missing = zones ? zones.filter((z) => !z.has_image).length : null;

  return (
    <>
      <TableRow hover sx={{ cursor: 'pointer' }} onClick={toggle}>
        <TableCell padding="checkbox">
          <IconButton size="small">
            {open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell>{server.id}</TableCell>
        <TableCell>{server.display_name || <Typography variant="caption" fontFamily="monospace">{server.ip}</Typography>}</TableCell>
        <TableCell align="right">
          {missing == null ? '—' : (missing === 0
            ? <Chip label="all present" size="small" color="success" variant="outlined" />
            : <Chip label={`${missing} missing`} size="small" color="warning" variant="outlined" />)}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={4} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 1.5 }}>
              {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
              {loading && <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={20} /></Box>}
              {!loading && zones && zones.length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ p: 1, display: 'block' }}>
                  No framed zones (zone_bounds) for this server.
                </Typography>
              )}
              {!loading && zones && zones.length > 0 && (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Zone</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell align="right"></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {zones.map((z) => (
                      <ZoneMapRow key={z.zone_no} serverId={server.id} zone={z} onMutated={load} />
                    ))}
                  </TableBody>
                </Table>
              )}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

// Per-(server, zone) background map images (super-admin). Lists every tracked
// server; expand one to manage the background image of each of its data-zones.
function BackgroundsPanel() {
  const { data, loading } = useApi(() => adminApi.getWorldServers(), []);
  const rows = data?.data || [];

  return (
    <Box sx={{ mb: 5 }}>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>Monster Map — Background images</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Upload <strong>one background image</strong> per server and zone (SVG preferred, otherwise
        PNG). It is drawn on the user map beneath the spawn points and aligned exactly to the
        <code> zone_bounds</code>. Expand a server to see missing backgrounds and upload or
        replace images.
      </Typography>

      <Paper variant="outlined">
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>ID</TableCell>
                <TableCell>Server</TableCell>
                <TableCell align="right">Backgrounds</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && <TableRow><TableCell colSpan={4}>Loading…</TableCell></TableRow>}
              {!loading && rows.length === 0 && (
                <TableRow><TableCell colSpan={4}><Typography variant="caption" color="text.disabled">No servers tracked yet.</Typography></TableCell></TableRow>
              )}
              {rows.map((r) => <BackgroundsServerRow key={r.id} server={r} />)}
            </TableBody>
          </Table>
        </Box>
      </Paper>
    </Box>
  );
}

// Monster-map ingest-token administration (PLAN_v2 §3.9). Super-admin only:
// mint an authoritative scope:'ingest' token a Debug bot can paste to push
// spawns to the ingest route, list issued tokens, and per-token revoke.
export default function World() {
  const { user } = useAuth();
  const { showSnackbar } = useSnackbar();
  const isSuperAdmin = user?.role === 'super_admin';

  const { data, loading, refetch } = useApi(() => adminApi.getIngestTokens(), []);
  const [licenseKey, setLicenseKey] = useState('');
  const [durationHours, setDurationHours] = useState('6');   // seeding window, default 6h (max 72)
  const [minting, setMinting]       = useState(false);
  const [minted, setMinted]         = useState(null);   // { token, jti, expires_at, duration_hours }
  const [error, setError]           = useState('');

  if (!isSuperAdmin) {
    return <Alert severity="warning">Ingest-token administration is super-admin only.</Alert>;
  }

  const handleMint = async () => {
    setError('');
    setMinted(null);
    setMinting(true);
    try {
      const body = {};
      if (licenseKey) body.license_key = licenseKey;
      else { setError('Pick a license first'); setMinting(false); return; }
      // Seeding window: clamp to [1, 72]h, default 6h if left blank/invalid.
      const h = Math.min(72, Math.max(1, Math.floor(Number(durationHours)) || 6));
      body.duration_hours = h;
      const res = await adminApi.mintIngestToken(body);
      setMinted(res);
      showSnackbar('Ingest token minted');
      refetch();
    } catch (err) {
      setError(err.data?.error || err.message || 'Mint failed');
    } finally {
      setMinting(false);
    }
  };

  const handleRevoke = async (jti) => {
    try {
      await adminApi.revokeIngestToken(jti);
      showSnackbar('Token revoked');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Revoke failed', 'error');
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text);
    showSnackbar('Copied to clipboard');
  };

  const fmtTime = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—';
  const rows = data?.data || [];
  const now = Math.floor(Date.now() / 1000);

  return (
    <Box>
      {/* Server management (additive) */}
      <ServersPanel />

      {/* Per-(server, zone) background images (additive) */}
      <BackgroundsPanel />

      <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>Monster Map — Ingest Tokens</Typography>

      {/* Mint */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Issue ingest token</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Signs a short-lived <code>scope:ingest</code> token against a real active license — the
          seeding window defaults to <strong>6&nbsp;hours</strong> (max 72&nbsp;h). Paste it into a
          Debug bot's Scan tab to enable spawn upload. Scope-limited, expiring, per-token revocable.
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 260 }}>
            <LicensePicker active={isSuperAdmin} value={licenseKey} onPick={setLicenseKey} disabled={minting} />
          </Box>
          <TextField
            label="Window (hours)" size="small" type="number" value={durationHours}
            onChange={(e) => setDurationHours(e.target.value)}
            inputProps={{ min: 1, max: 72 }}
            helperText="default 6, max 72"
            sx={{ minWidth: 130 }}
          />
          <Button variant="contained" startIcon={<KeyIcon />} onClick={handleMint} disabled={minting}>
            {minting ? 'Minting…' : 'Mint'}
          </Button>
        </Box>

        {minted && (
          <Alert severity="success" sx={{ mt: 2 }}>
            <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
              jti <code>{minted.jti}</code> · expires {fmtTime(minted.expires_at)}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                value={minted.token} size="small" fullWidth
                InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: '0.7rem' } }}
              />
              <Tooltip title="Copy token">
                <IconButton size="small" onClick={() => copy(minted.token)}><ContentCopyIcon fontSize="small" /></IconButton>
              </Tooltip>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Copy now — the token is not retrievable later, only revocable.
            </Typography>
          </Alert>
        )}
      </Paper>

      {/* Issued list */}
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>jti</TableCell>
              <TableCell>User</TableCell>
              <TableCell>License</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Expires</TableCell>
              <TableCell>Created</TableCell>
              <TableCell align="right"></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={7}>Loading…</TableCell></TableRow>}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={7}><Typography variant="caption" color="text.disabled">No ingest tokens issued.</Typography></TableCell></TableRow>
            )}
            {rows.map((r) => {
              const expired = r.expires_at <= now;
              const state = r.revoked ? 'revoked' : expired ? 'expired' : 'active';
              const color = state === 'active' ? 'success' : state === 'revoked' ? 'error' : 'default';
              return (
                <TableRow key={r.jti}>
                  <TableCell><Typography variant="caption" fontFamily="monospace">{r.jti.slice(0, 12)}…</Typography></TableCell>
                  <TableCell>{r.user_name || r.user_email || (r.user_id != null ? `#${r.user_id}` : '—')}</TableCell>
                  <TableCell><Typography variant="caption" fontFamily="monospace">{r.license_key || '—'}</Typography></TableCell>
                  <TableCell><Chip label={state} size="small" color={color} variant="outlined" /></TableCell>
                  <TableCell>{fmtTime(r.expires_at)}</TableCell>
                  <TableCell>{fmtTime(r.created_at)}</TableCell>
                  <TableCell align="right">
                    {!r.revoked && !expired && (
                      <Button size="small" color="error" onClick={() => handleRevoke(r.jti)}>Revoke</Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
