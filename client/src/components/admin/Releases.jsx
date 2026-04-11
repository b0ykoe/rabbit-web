import { useState } from 'react';
import { Box, Typography, Button, Paper, Chip } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import EditIcon from '@mui/icons-material/Edit';
import StatusBadge from '../common/StatusBadge.jsx';
import { getChannelColor } from '../../utils/format.js';
import CopyableText from '../common/CopyableText.jsx';
import ReleaseUploadDialog from './ReleaseUploadDialog.jsx';
import ChangelogEditDialog from './ChangelogEditDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Releases() {
  const { data, loading, refetch } = useApi(() => adminApi.getReleases(), []);
  const { showSnackbar } = useSnackbar();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editRelease, setEditRelease] = useState(null);

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

  const handleDeactivate = async (id) => {
    await adminApi.deactivateRelease(id);
    showSnackbar('Release deactivated');
    refetch();
  };

  const handleEditChangelog = async (id, data) => {
    await adminApi.updateRelease(id, data);
    showSnackbar('Changelog updated');
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
                    <th align="left">Channel</th>
                    <th align="left">Hashes</th>
                    <th align="left">Status</th>
                    <th align="left">Date</th>
                    <th align="right"></th>
                  </tr>
                </thead>
                <tbody>
                  {data[type].map((r) => (
                    <tr key={r.id}>
                      <td><Typography fontWeight={600} variant="body2">v{r.version}</Typography></td>
                      <td><Chip label={r.channel || 'release'} size="small" color={getChannelColor(r.channel)} variant="outlined" sx={{ fontSize: '0.65rem' }} /></td>
                      <td>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem', minWidth: 36 }}>SHA-256</Typography>
                            <CopyableText text={r.sha256} />
                          </Box>
                          {r.md5 && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.6rem', minWidth: 36 }}>MD5</Typography>
                              <CopyableText text={r.md5} />
                            </Box>
                          )}
                        </Box>
                      </td>
                      <td>{r.active ? <StatusBadge status="active" /> : <Chip label="Inactive" size="small" variant="outlined" />}</td>
                      <td><Typography variant="caption" color="text.secondary">{new Date(r.created_at).toLocaleDateString()}</Typography></td>
                      <td align="right">
                        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
                          <Button size="small" startIcon={<EditIcon />} onClick={() => setEditRelease(r)}>Edit</Button>
                          {!r.active && (
                            <Button size="small" onClick={() => handleActivate(r.id)}>Activate</Button>
                          )}
                          {r.active && (
                            <Button size="small" color="warning" onClick={() => handleDeactivate(r.id)}>Deactivate</Button>
                          )}
                        </Box>
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
      <ChangelogEditDialog open={!!editRelease} onClose={() => setEditRelease(null)} onSubmit={handleEditChangelog} release={editRelease} />
    </Box>
  );
}
