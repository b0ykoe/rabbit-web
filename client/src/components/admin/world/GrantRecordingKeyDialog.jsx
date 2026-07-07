import { useState, useEffect } from 'react';
import {
  Box, Typography, Button, TextField, Alert, Tooltip, IconButton,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/VpnKey';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';

// "Grant recording key" dialog — pick a user (id) or license key + a duration
// window (default 6h, max 72h) and mint a scope:ingest token. On success the raw
// token is shown ONCE with a copy button + expiry. A 409 ("user already has an
// active token") is handled cleanly: the existing jti is surfaced with an option
// to revoke it (via the existing revoke endpoint) and retry.
export default function GrantRecordingKeyDialog({ open, onClose }) {
  const { showSnackbar } = useSnackbar();
  const [durationHours, setDurationHours] = useState('6');
  const [minting, setMinting]           = useState(false);
  const [minted, setMinted]             = useState(null);   // { token, jti, expires_at }
  const [error, setError]               = useState('');
  const [conflict, setConflict]         = useState(null);   // existing active jti on 409
  const [revoking, setRevoking]         = useState(false);

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setDurationHours('6');
      setMinting(false); setMinted(null); setError(''); setConflict(null); setRevoking(false);
    }
  }, [open]);

  const buildBody = () => ({
    self: true,
    duration_hours: Math.min(72, Math.max(1, Math.floor(Number(durationHours)) || 6)),
  });

  const handleMint = async () => {
    setError(''); setMinted(null); setConflict(null);
    setMinting(true);
    try {
      const res = await adminApi.mintIngestToken(buildBody());
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
          Creates a time-limited recording key bound to you — hand it to a user.
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
            {minting ? 'Minting…' : 'Create key'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
