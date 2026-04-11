import { useState } from 'react';
import { Box, Typography, Button, Paper, Chip } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import StatusBadge from '../common/StatusBadge.jsx';
import ReleaseUploadDialog from './ReleaseUploadDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Releases() {
  const { data, loading, refetch } = useApi(() => adminApi.getReleases(), []);
  const { showSnackbar } = useSnackbar();
  const [uploadOpen, setUploadOpen] = useState(false);

  const handleUpload = async (formData) => {
    await adminApi.uploadRelease(formData);
    showSnackbar('Release uploaded and activated');
    refetch();
  };

  const handleActivate = async (id) => {
    await adminApi.activateRelease(id);
    showSnackbar('Release activated');
    refetch();
  };

  if (loading) return null;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Releases</Typography>
        <Button variant="contained" startIcon={<CloudUploadIcon />} onClick={() => setUploadOpen(true)}>
          Upload
        </Button>
      </Box>

      {['dll', 'loader'].map((type) => (
        <Box key={type} sx={{ mb: 4 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {type}
          </Typography>
          <Paper>
            {(!data?.[type] || data[type].length === 0) ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography color="text.disabled">No {type} releases</Typography>
              </Box>
            ) : (
              <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& td, & th': { p: 1.5, borderBottom: '1px solid', borderColor: 'divider', fontSize: '0.8125rem' }, '& th': { color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em' } }}>
                <thead>
                  <tr>
                    <th align="left">Version</th>
                    <th align="left">SHA-256</th>
                    <th align="left">Status</th>
                    <th align="left">Date</th>
                    <th align="right"></th>
                  </tr>
                </thead>
                <tbody>
                  {data[type].map((r) => (
                    <tr key={r.id}>
                      <td><Typography fontWeight={600} variant="body2">v{r.version}</Typography></td>
                      <td><Typography variant="caption" fontFamily="monospace" color="text.secondary">{r.sha256.slice(0, 16)}...</Typography></td>
                      <td>{r.active ? <StatusBadge status="active" /> : <Chip label="Inactive" size="small" variant="outlined" />}</td>
                      <td><Typography variant="caption" color="text.secondary">{new Date(r.created_at).toLocaleDateString()}</Typography></td>
                      <td align="right">
                        {!r.active && (
                          <Button size="small" onClick={() => handleActivate(r.id)}>Activate</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Box>
            )}
          </Paper>
        </Box>
      ))}

      <ReleaseUploadDialog open={uploadOpen} onClose={() => setUploadOpen(false)} onSubmit={handleUpload} />
    </Box>
  );
}
