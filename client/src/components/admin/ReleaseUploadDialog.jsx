import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, MenuItem, Alert, Box, Typography } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

export default function ReleaseUploadDialog({ open, onClose, onSubmit }) {
  const [type, setType]           = useState('dll');
  const [version, setVersion]     = useState('');
  const [changelog, setChangelog] = useState('');
  const [file, setFile]           = useState(null);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) { setError('File is required'); return; }
    setError('');
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('type', type);
      formData.append('version', version);
      formData.append('changelog', changelog);
      formData.append('file', file);
      await onSubmit(formData);
      setType('dll'); setVersion(''); setChangelog(''); setFile(null);
      onClose();
    } catch (err) {
      const errors = err.data?.errors;
      setError(errors ? Object.values(errors).flat().join('. ') : (err.data?.error || err.message || 'Upload failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Upload Release</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Type" select size="small" value={type} onChange={(e) => setType(e.target.value)}>
            <MenuItem value="dll">DLL</MenuItem>
            <MenuItem value="loader">Loader</MenuItem>
          </TextField>
          <TextField
            label="Version"
            size="small"
            required
            placeholder="1.0.0"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            helperText="Format: X.Y.Z or X.Y.Z-tag"
          />
          <Box>
            <Button variant="outlined" component="label" startIcon={<CloudUploadIcon />} fullWidth>
              {file ? file.name : 'Choose File'}
              <input type="file" hidden onChange={(e) => setFile(e.target.files[0])} accept=".dll,.exe" />
            </Button>
            {file && <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>{(file.size / 1024 / 1024).toFixed(2)} MB</Typography>}
          </Box>
          <TextField
            label="Changelog"
            multiline
            rows={4}
            size="small"
            required
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            placeholder="What changed in this version..."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={loading}>
            {loading ? 'Uploading...' : 'Upload & Activate'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
