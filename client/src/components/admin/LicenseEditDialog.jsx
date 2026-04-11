import { useState, useEffect } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert } from '@mui/material';

export default function LicenseEditDialog({ open, onClose, onSubmit, license }) {
  const [form, setForm]   = useState({ max_sessions: 1, note: '', expires_at: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (license) {
      setForm({
        max_sessions: license.max_sessions || 1,
        note:         license.note || '',
        expires_at:   license.expires_at ? new Date(license.expires_at).toISOString().slice(0, 16) : '',
      });
    }
    setError('');
  }, [license, open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSubmit(license.license_key, {
        max_sessions: form.max_sessions,
        note:         form.note || null,
        expires_at:   form.expires_at ? new Date(form.expires_at).toISOString() : null,
      });
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
        <DialogTitle>Edit License</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Max Sessions"
            type="number"
            size="small"
            inputProps={{ min: 1, max: 100 }}
            value={form.max_sessions}
            onChange={(e) => setForm({ ...form, max_sessions: parseInt(e.target.value, 10) || 1 })}
          />
          <TextField
            label="Expires At (leave empty for Lifetime)"
            type="datetime-local"
            size="small"
            InputLabelProps={{ shrink: true }}
            value={form.expires_at}
            onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
          />
          <TextField
            label="Note"
            size="small"
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={loading}>
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
