import { useState, useEffect } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert, Typography } from '@mui/material';

export default function CreditAdjustDialog({ open, onClose, onSubmit, user }) {
  const [amount, setAmount]   = useState(0);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setAmount(0);
    setError('');
  }, [user, open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (amount === 0) { setError('Amount cannot be zero'); return; }
    setError('');
    setLoading(true);
    try {
      await onSubmit(user.id, { credits: amount });
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
        <DialogTitle>Adjust Credits — {user?.name}</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Current balance: <strong>{user?.credits ?? 0}</strong> credits
          </Typography>
          <TextField
            label="Amount (positive to add, negative to deduct)"
            type="number"
            fullWidth
            size="small"
            value={amount}
            onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
            helperText={amount > 0 ? `New balance: ${(user?.credits || 0) + amount}` : amount < 0 ? `New balance: ${Math.max(0, (user?.credits || 0) + amount)}` : ''}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={loading || amount === 0}>
            {loading ? 'Saving...' : (amount >= 0 ? `Add ${amount}` : `Deduct ${Math.abs(amount)}`)}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
