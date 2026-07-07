import { useState, useEffect } from 'react';
import {
  Button, Alert, TextField,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';

// "Sign offsets" dialog — password-gates a call to signServerOffsets, which signs
// the current fingerprint + overrides so the bot will accept the blob. Error
// mapping (kept inline; the dialog stays open on failure):
//   403 → "Wrong signing password"
//   409 → "Generate a signing key first"
//   400 → "Set the engine fingerprint first"
// Props: { open, onClose, serverId, serverName, onSigned }.
export default function SignOffsetsDialog({ open, onClose, serverId, serverName, onSigned }) {
  const { showSnackbar } = useSnackbar();
  const [password, setPassword] = useState('');
  const [signing, setSigning]   = useState(false);
  const [error, setError]       = useState('');

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) { setPassword(''); setSigning(false); setError(''); }
  }, [open]);

  const mapError = (err) => {
    const status = err?.status;
    if (status === 403) return 'Wrong signing password.';
    if (status === 409) return err?.data?.error || 'Generate a signing key first.';
    if (status === 400) return err?.data?.error || 'Set the engine fingerprint first.';
    return err?.data?.error || err?.message || 'Signing failed.';
  };

  const handleSign = async () => {
    if (!password || signing) return;
    setError('');
    setSigning(true);
    try {
      const res = await adminApi.signServerOffsets(serverId, password);
      showSnackbar('Offsets signed');
      onSigned?.(res);
      onClose();
    } catch (err) {
      setError(mapError(err)); // stay open so the admin can retry
    } finally {
      setSigning(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !signing && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>Sign offsets</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          Signs the current fingerprint + overrides for{' '}
          <strong>{serverName || `#${serverId}`}</strong>. You'll need this password every
          time you sign; it is <strong>never stored</strong>.
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
          {signing ? 'Signing…' : 'Sign'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
