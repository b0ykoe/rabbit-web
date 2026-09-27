import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControl, InputLabel, LinearProgress,
  MenuItem, Paper, Select, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && amount >= 1024; ++i) {
    amount /= 1024;
    unit = units[i];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

export default function NavigationCaches() {
  const { data, loading, error: loadError, refetch } = useApi(
    () => adminApi.getNavigationCaches(), []);
  const inputRef = useRef(null);
  const [serverId, setServerId] = useState('');
  const [archive, setArchive] = useState(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [message, setMessage] = useState(null);
  const servers = data?.data || [];
  const selectedBytes = archive?.size || 0;

  useEffect(() => {
    if (!serverId && servers.length) setServerId(String(servers[0].server_id));
  }, [serverId, servers]);

  const chooseArchive = (event) => {
    const selected = event.target.files?.[0] || null;
    const valid = selected && selected.name.toLowerCase().endsWith('.zip');
    setArchive(valid ? selected : null);
    setProgress(0);
    setMessage(valid
      ? null
      : { severity: 'warning', text: 'Select a .zip archive containing the v4 .mvnav files.' });
  };

  const publish = async () => {
    if (!serverId || !archive) return;
    setUploading(true);
    setProgress(0);
    setMessage(null);
    try {
      const result = await adminApi.uploadNavigationCacheArchive(serverId, archive,
        (loaded, total) => setProgress(total ? (loaded / total) * 100 : 0));
      setProgress(100);
      setMessage({ severity: 'success', text: result.message });
      setArchive(null);
      if (inputRef.current) inputRef.current.value = '';
      await refetch();
    } catch (error) {
      const text = error.status === 0
        ? `${error.message}. Check the Cloudflare/Nginx upload-size and timeout settings.`
        : error.message;
      setMessage({ severity: 'error', text });
    } finally {
      setUploading(false);
    }
  };

  const removePackage = async (server) => {
    const name = server.server_name || server.variant || `Server ${server.server_id}`;
    if (!window.confirm(`Delete the published navigation cache for ${name}?`)) return;
    setDeletingId(server.server_id);
    setMessage(null);
    try {
      const result = await adminApi.deleteNavigationCaches(server.server_id);
      setMessage({ severity: 'success', text: result.message });
      await refetch();
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Navigation Caches</Typography>
        <Typography variant="body2" color="text.secondary">
          Publish MapViewer schema-v4 cache packages for each game server. Uploading a new
          ZIP archive replaces that server&apos;s currently published package.
        </Typography>
      </Box>

      {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError.message}</Alert>}
      {message && <Alert severity={message.severity} sx={{ mb: 2 }}>{message.text}</Alert>}

      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 2 }}>Publish cache package</Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Create one ZIP from <code>%APPDATA%\chrome_143\mapviewer_nav_cache\v4</code>.
          The server extracts only .mvnav files, validates every cache and stores the verified
          files individually for the loader.
        </Alert>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>Game server</InputLabel>
            <Select value={serverId} label="Game server"
              onChange={(event) => setServerId(event.target.value)} disabled={uploading}>
              {servers.map((server) => (
                <MenuItem key={server.server_id} value={String(server.server_id)}>
                  {server.server_name || server.variant || `Server ${server.server_id}`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button component="label" variant="outlined" startIcon={<FolderOpenIcon />}
            disabled={uploading || loading}>
            Select cache ZIP
            <input ref={inputRef} hidden type="file" accept=".zip,application/zip"
              onChange={chooseArchive} />
          </Button>
          <Button variant="contained" startIcon={<UploadFileIcon />} onClick={publish}
            disabled={uploading || !serverId || !archive}>
            {uploading ? 'Uploading…' : 'Upload cache'}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {archive
              ? `${archive.name} · ${formatBytes(selectedBytes)}`
              : 'No cache ZIP selected'}
          </Typography>
        </Box>

        {uploading && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress variant="determinate" value={progress} />
            <Typography variant="caption" color="text.secondary">
              {progress >= 100
                ? 'Upload complete · server is extracting, validating and publishing the caches…'
                : `Uploading ${progress.toFixed(0)}% · ${formatBytes(selectedBytes)}`}
            </Typography>
          </Box>
        )}
      </Paper>

      <Paper>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Server</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Schema</TableCell>
                <TableCell>Files</TableCell>
                <TableCell>Size</TableCell>
                <TableCell>Published</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {servers.map((server) => {
                const published = !!server.package_id;
                return (
                  <TableRow key={server.server_id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {server.server_name || server.variant || `Server ${server.server_id}`}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" color={published ? 'success' : 'default'}
                        label={published ? 'Published' : 'Not published'} />
                    </TableCell>
                    <TableCell>{server.schema_version || '—'}</TableCell>
                    <TableCell>{published ? server.file_count : '—'}</TableCell>
                    <TableCell>{published ? formatBytes(server.total_bytes) : '—'}</TableCell>
                    <TableCell>
                      {server.uploaded_at ? new Date(server.uploaded_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" color="error" startIcon={<DeleteOutlineIcon />}
                        disabled={!published || deletingId !== null || uploading}
                        onClick={() => removePackage(server)}>
                        {deletingId === server.server_id ? 'Deleting…' : 'Delete'}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && servers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="text.disabled" sx={{ py: 2 }}>No game servers configured.</Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  );
}
