import { useState, useEffect } from 'react';
import {
  Box, Button, Alert, MenuItem, TextField, FormControlLabel, Switch,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import KnownIpsEditor from './KnownIpsEditor.jsx';

// Known variant labels for the server form's variant picker. Free-text on the
// server (VARCHAR 32) — this list is just the curated set of common values.
export const VARIANT_OPTIONS = ['EP4 Stock', 'Nemesis', 'Unknown'];

// Create a named game server. CREATE-ONLY: collects name, variant, visible
// (DEFAULT OFF per product decision) + an initial known-IPs list, then POSTs.
// The POST returns the created row; onCreated(newRow) hands it back so the caller
// can navigate straight into the new server's detail. Servers are ADMIN-DEFINED —
// identity is the name, not the ip/variant.
export default function CreateServerDialog({ open, onClose, onCreated }) {
  const { showSnackbar } = useSnackbar();

  const [name, setName]       = useState('');
  const [variant, setVariant] = useState(VARIANT_OPTIONS[0]);
  const [visible, setVisible] = useState(false);   // new servers default hidden
  const [ips, setIps]         = useState([]);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  // (Re)seed the form whenever it opens.
  useEffect(() => {
    if (!open) return;
    setName('');
    setVariant(VARIANT_OPTIONS[0]);
    setVisible(false);
    setIps([]);
    setError('');
    setSaving(false);
  }, [open]);

  const handleCreate = async () => {
    const nm = name.trim();
    if (!nm) { setError('Name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await adminApi.createWorldServer({ name: nm, variant, visible, known_ips: ips });
      showSnackbar('Server created');
      // The POST returns the created row (possibly wrapped in { data }).
      const row = res?.data || res;
      onCreated?.(row);
      onClose();
    } catch (err) {
      const msg = err.data?.error || err.message || 'Create failed';
      setError(msg);
      showSnackbar(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>New server</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          Servers are admin-defined. The bot preselects one by matching a known IP;
          spawn data is keyed by this server.
        </DialogContentText>
        {error && <Alert severity="error">{error}</Alert>}

        <TextField
          label="Name" size="small" value={name} disabled={saving} autoFocus
          onChange={(e) => setName(e.target.value)}
          inputProps={{ maxLength: 128 }} fullWidth
        />
        <TextField
          select label="Variant" size="small" value={variant} disabled={saving}
          onChange={(e) => setVariant(e.target.value)} fullWidth
        >
          {VARIANT_OPTIONS.map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
        </TextField>
        <FormControlLabel
          control={<Switch checked={visible} disabled={saving} onChange={(e) => setVisible(e.target.checked)} />}
          label="Visible on user map"
        />

        <Box>
          <KnownIpsEditor value={ips} onChange={setIps} disabled={saving} />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={saving || !name.trim()}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
