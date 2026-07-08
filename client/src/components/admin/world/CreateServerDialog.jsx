import { useState, useEffect } from 'react';
import {
  Box, Button, Alert, MenuItem, TextField, FormControlLabel, Switch,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import { useVariantOptions } from './useVariantOptions.js';
import KnownIpsEditor from './KnownIpsEditor.jsx';

// VARIANT_OPTIONS (the legacy offline-fallback trio) now lives in useVariantOptions
// so this module doesn't form an import cycle with the hook. Re-exported from here
// for backwards compatibility with any caller still importing it from this path.
export { VARIANT_OPTIONS } from './useVariantOptions.js';

// Sentinel Select value that reveals the free-text variant field. Variant is free
// text on the server (VARCHAR 32); a custom value self-registers into game_variants
// on server save (C1 auto-upsert).
const CUSTOM_VARIANT = '__custom__';

// Create a named game server. CREATE-ONLY: collects name, variant, visible
// (DEFAULT OFF per product decision) + an initial known-IPs list, then POSTs.
// The POST returns the created row; onCreated(newRow) hands it back so the caller
// can navigate straight into the new server's detail. Servers are ADMIN-DEFINED —
// identity is the name, not the ip/variant.
export default function CreateServerDialog({ open, onClose, onCreated }) {
  const { showSnackbar } = useSnackbar();
  const { options: variantOptions } = useVariantOptions();

  const [variantSel, setVariantSel]       = useState('');   // Select value: a name or CUSTOM_VARIANT
  const [variantCustom, setVariantCustom] = useState('');   // free-text when Custom…
  const [name, setName]       = useState('');
  const [visible, setVisible] = useState(false);   // new servers default hidden
  const [ips, setIps]         = useState([]);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  // (Re)seed the form whenever it opens. Default the variant to the first managed
  // option (falls back to the legacy trio's first entry via the hook).
  useEffect(() => {
    if (!open) return;
    setName('');
    setVariantSel(variantOptions[0]?.name || '');
    setVariantCustom('');
    setVisible(false);
    setIps([]);
    setError('');
    setSaving(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve the effective variant string the server will store/join on.
  const effectiveVariant = variantSel === CUSTOM_VARIANT ? variantCustom.trim() : variantSel;

  const handleCreate = async () => {
    const nm = name.trim();
    if (!nm) { setError('Name is required.'); return; }
    if (!effectiveVariant) { setError('Variant is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await adminApi.createWorldServer({ name: nm, variant: effectiveVariant, visible, known_ips: ips });
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
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            select label="Variant" size="small" value={variantSel} disabled={saving}
            onChange={(e) => setVariantSel(e.target.value)} sx={{ minWidth: 200, flex: 1 }}
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
              label="Custom variant" size="small" value={variantCustom} disabled={saving}
              autoFocus inputProps={{ maxLength: 32 }} sx={{ minWidth: 200, flex: 1 }}
              onChange={(e) => setVariantCustom(e.target.value)}
              helperText="Registers on save"
            />
          )}
        </Box>
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
        <Button variant="contained" onClick={handleCreate} disabled={saving || !name.trim() || !effectiveVariant}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
