import { useState, useEffect } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, Alert, MenuItem } from '@mui/material';

export default function ChangelogEditDialog({ open, onClose, onSubmit, release }) {
  const [changelog, setChangelog] = useState('');
  const [channel, setChannel]     = useState('release');
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  useEffect(() => {
    if (release) {
      setChangelog(release.changelog || '');
      setChannel(release.channel || 'release');
    }
    setError('');
  }, [release, open]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = {};
      if (changelog !== release?.changelog) data.changelog = changelog;
      if (channel !== release?.channel) data.channel = channel;
      if (Object.keys(data).length === 0) { onClose(); return; }
      await onSubmit(release.id, data);
      onClose();
    } catch (err) {
      setError(err.data?.error || err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>
          Edit Release — {release?.type} v{release?.version}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Channel" select size="small" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <MenuItem value="release">Release</MenuItem>
            <MenuItem value="beta">Beta</MenuItem>
            <MenuItem value="alpha">Alpha</MenuItem>
          </TextField>
          <TextField
            label="Changelog"
            multiline
            rows={8}
            fullWidth
            size="small"
            required
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
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
