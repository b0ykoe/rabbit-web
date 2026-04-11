import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert } from '@mui/material';

export default function LicenseFormDialog({ open, onClose, onSubmit }) {
  const [maxSessions, setMaxSessions] = useState(1);
  const [note, setNote]               = useState('');
  const [error, setError]             = useState('');
  const [loading, setLoading]         = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSubmit({ max_sessions: maxSessions, note: note || undefined });
      setMaxSessions(1);
      setNote('');
      onClose();
    } catch (err) {
      setError(err.data?.error || err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Create License Key</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Max Sessions"
            type="number"
            size="small"
            inputProps={{ min: 1, max: 100 }}
            value={maxSessions}
            onChange={(e) => setMaxSessions(parseInt(e.target.value, 10) || 1)}
          />
          <TextField label="Note (optional)" size="small" value={note} onChange={(e) => setNote(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={loading}>
            {loading ? 'Generating...' : 'Generate Key'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
