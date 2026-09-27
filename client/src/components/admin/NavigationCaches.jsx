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
  const [selection, setSelection] = useState(null);
  const [uploadSession, setUploadSession] = useState(null);
  const [uploadedIndexes, setUploadedIndexes] = useState(new Set());
  const [progress, setProgress] = useState(0);
  const [currentPart, setCurrentPart] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [message, setMessage] = useState(null);
  const servers = data?.data || [];
  const busy = uploading || analyzing;

  useEffect(() => {
    if (!serverId && servers.length) setServerId(String(servers[0].server_id));
  }, [serverId, servers]);

  const clearSelection = () => {
    setSelection(null);
    setUploadSession(null);
    setUploadedIndexes(new Set());
    setProgress(0);
    setCurrentPart(0);
    if (inputRef.current) inputRef.current.value = '';
  };

  const chooseParts = async (event) => {
    const files = Array.from(event.target.files || []);
    setSelection(null);
    setUploadSession(null);
    setUploadedIndexes(new Set());
    setProgress(0);
    setCurrentPart(0);
    const manifestFile = files.find((file) => file.name.toLowerCase() === 'navigation-cache-parts.json');
    if (!manifestFile) {
      setMessage({ severity: 'warning', text: 'The selected folder has no navigation-cache-parts.json.' });
      return;
    }
    try {
      const manifest = JSON.parse((await manifestFile.text()).replace(/^\uFEFF/, ''));
      if (manifest.format !== 'rabbit-navigation-cache-parts' || manifest.version !== 1 ||
          !Array.isArray(manifest.parts) || manifest.parts.length !== manifest.part_count)
        throw new Error('Unsupported or incomplete part manifest');
      const byName = new Map(files.map((file) => [file.name.toLowerCase(), file]));
      const parts = [...manifest.parts].sort((a, b) => a.index - b.index).map((part) => {
        const file = byName.get(String(part.file_name).toLowerCase());
        if (!file) throw new Error(`Missing ${part.file_name}`);
        if (file.size !== part.byte_size) throw new Error(`${part.file_name} has the wrong size`);
        return { manifest: part, file };
      });
      setSelection({ manifest, parts });
      setMessage({ severity: 'success', text: `Ready to upload ${parts.length} verified parts.` });
    } catch (error) {
      setMessage({ severity: 'error', text: `Cannot use part folder: ${error.message}` });
    }
  };

  const uploadParts = async () => {
    if (!serverId || !selection) return;
    setUploading(true);
    setMessage(null);
    let session = uploadSession;
    const completedIndexes = new Set(uploadedIndexes);
    try {
      if (!session) {
        session = await adminApi.startNavigationCachePartUpload(serverId, selection.manifest);
        setUploadSession(session);
      }
      let completedBytes = selection.parts
        .filter(({ manifest }) => completedIndexes.has(manifest.index))
        .reduce((sum, { manifest }) => sum + manifest.byte_size, 0);
      for (const { manifest, file } of selection.parts) {
        if (completedIndexes.has(manifest.index)) continue;
        setCurrentPart(manifest.index);
        await adminApi.uploadNavigationCachePart(serverId, session.upload_id, manifest.index, file,
          (loaded) => setProgress(Math.min(100,
            ((completedBytes + Math.min(loaded, manifest.byte_size)) /
              selection.manifest.archive_size) * 100)));
        completedBytes += manifest.byte_size;
        completedIndexes.add(manifest.index);
        setUploadedIndexes(new Set(completedIndexes));
        setProgress((completedBytes / selection.manifest.archive_size) * 100);
      }
      setProgress(100);
      setCurrentPart(0);
      setMessage({ severity: 'success', text: 'All parts are uploaded. Analyze and publish the package when ready.' });
    } catch (error) {
      const text = error.status === 0
        ? `${error.message}. Retry to continue with the remaining parts.`
        : error.message;
      setMessage({ severity: 'error', text });
    } finally {
      setUploading(false);
    }
  };

  const analyzeAndPublish = async () => {
    if (!serverId || !selection || !uploadSession ||
        uploadedIndexes.size !== selection.parts.length) return;
    setAnalyzing(true);
    setMessage(null);
    try {
      const result = await adminApi.finalizeNavigationCachePartUpload(serverId, uploadSession.upload_id);
      setMessage({ severity: 'success', text: result.message });
      clearSelection();
      await refetch();
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally {
      setAnalyzing(false);
    }
  };

  const discardUpload = async () => {
    if (uploadSession && serverId) {
      try { await adminApi.cancelNavigationCachePartUpload(serverId, uploadSession.upload_id); }
      catch (_) { /* an expired session is already discarded */ }
    }
    clearSelection();
    setMessage(null);
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
          Upload a MapViewer schema-v4 package in Cloudflare-safe parts, then analyze and
          publish it for the selected game server.
        </Typography>
      </Box>

      {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError.message}</Alert>}
      {message && <Alert severity={message.severity} sx={{ mb: 2 }}>{message.text}</Alert>}

      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 2 }}>Publish cache package</Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Run <code>.\scripts\New-NavigationCacheParts.ps1 -PackageName Nemesis</code>, then
          select the generated folder. Its 64 MiB parts are uploaded sequentially below
          Cloudflare&apos;s 100 MB request limit. Publishing starts only when you press
          Analyze &amp; publish.
        </Alert>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel>Game server</InputLabel>
            <Select value={serverId} label="Game server"
              onChange={(event) => setServerId(event.target.value)}
              disabled={busy || !!uploadSession}>
              {servers.map((server) => (
                <MenuItem key={server.server_id} value={String(server.server_id)}>
                  {server.server_name || server.variant || `Server ${server.server_id}`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Button component="label" variant="outlined" startIcon={<FolderOpenIcon />}
            disabled={busy || loading || !!uploadSession}>
            Select parts folder
            <input ref={inputRef} hidden type="file" multiple onChange={chooseParts}
              {...{ webkitdirectory: '', directory: '' }} />
          </Button>
          <Button variant="contained" startIcon={<UploadFileIcon />} onClick={uploadParts}
            disabled={busy || !serverId || !selection ||
              uploadedIndexes.size === selection?.parts.length}>
            {uploading ? `Uploading part ${currentPart}/${selection?.parts.length || 0}…` :
              (uploadSession ? 'Continue upload' : 'Upload parts')}
          </Button>
          <Button variant="contained" color="success" onClick={analyzeAndPublish}
            disabled={busy || !selection || !uploadSession ||
              uploadedIndexes.size !== selection.parts.length}>
            {analyzing ? 'Analyzing…' : 'Analyze & publish'}
          </Button>
          {(selection || uploadSession) && (
            <Button variant="text" color="inherit" onClick={discardUpload} disabled={busy}>
              Reset
            </Button>
          )}
          <Typography variant="body2" color="text.secondary">
            {selection
              ? `${selection.parts.length} parts · ${formatBytes(selection.manifest.archive_size)} compressed`
              : 'No parts folder selected'}
          </Typography>
        </Box>

        {(uploading || progress > 0) && selection && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress variant="determinate" value={progress} />
            <Typography variant="caption" color="text.secondary">
              {progress >= 100
                ? `All ${selection.parts.length} parts uploaded · ready for analysis`
                : `Part ${currentPart}/${selection.parts.length} · ${progress.toFixed(0)}% total`}
            </Typography>
          </Box>
        )}
        {analyzing && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress />
            <Typography variant="caption" color="text.secondary">
              Reassembling ZIP, verifying hashes, inspecting caches and publishing package…
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
                        disabled={!published || deletingId !== null || busy}
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
