import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Alert, ToggleButtonGroup, ToggleButton, TextField, Typography } from '@mui/material';

const PRESETS = [
  { label: '30 Days', days: 30 },
  { label: '90 Days', days: 90 },
  { label: '365 Days', days: 365 },
  { label: 'Lifetime', days: null },
];

export default function ExtendDialog({ open, onClose, onSubmit, licenseKey }) {
  const [mode, setMode]             = useState('preset');
  const [selectedPreset, setPreset] = useState(30);
  const [customDate, setCustomDate] = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      if (mode === 'preset') {
        if (selectedPreset === null) {
          await onSubmit(licenseKey, { expires_at: null });
        } else {
          await onSubmit(licenseKey, { days: selectedPreset });
        }
      } else {
        if (!customDate) { setError('Select a date'); setLoading(false); return; }
        await onSubmit(licenseKey, { expires_at: new Date(customDate).toISOString() });
      }
      onClose();
    } catch (err) {
      setError(err.data?.error || err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Extend License</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
          {licenseKey}
        </Typography>

        <ToggleButtonGroup
          value={mode}
          exclusive
          onChange={(_, v) => v && setMode(v)}
          size="small"
          sx={{ mb: 2 }}
        >
          <ToggleButton value="preset">Preset</ToggleButton>
          <ToggleButton value="custom">Custom Date</ToggleButton>
        </ToggleButtonGroup>

        {mode === 'preset' ? (
          <ToggleButtonGroup
            value={selectedPreset}
            exclusive
            onChange={(_, v) => v !== undefined && setPreset(v)}
            size="small"
            fullWidth
            sx={{ flexWrap: 'wrap', gap: 1, '& .MuiToggleButton-root': { flex: '1 0 auto' } }}
          >
            {PRESETS.map((p) => (
              <ToggleButton key={p.label} value={p.days}>
                {p.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : (
          <TextField
            type="datetime-local"
            fullWidth
            size="small"
            InputLabelProps={{ shrink: true }}
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={loading}>
          {loading ? 'Extending...' : 'Extend'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
