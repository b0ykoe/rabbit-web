import { useState, useEffect } from 'react';
import {
  Grid, Box, Typography, Paper, Chip, Button, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Tabs, Tab, Select, MenuItem, FormControl, InputLabel, LinearProgress,
} from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import DownloadIcon from '@mui/icons-material/Download';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { adminApi, portalApi, worldApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getChannelColor } from '../../utils/format.js';

// Live countdown label for a recording key. remaining_seconds is a snapshot from
// the server; we tick it down locally each second. Revoked/expired states win.
function keyCountdown(status, remainingBase, tick) {
  if (status === 'revoked') return { label: 'revoked', color: 'error.main' };
  const remaining = Math.max(0, (remainingBase ?? 0) - tick);
  if (status === 'expired' || remaining <= 0) return { label: 'expired', color: 'text.disabled' };
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const s = remaining % 60;
  const label = h > 0 ? `${h}h ${m}m ${s}s` : (m > 0 ? `${m}m ${s}s` : `${s}s`);
  return { label, color: 'success.main' };
}

function RecordingCard() {
  const { data: rec } = useApi(() => worldApi.myRecordingStatus(), []);
  const { data: tokens } = useApi(() => worldApi.myTokens(), []);
  const [tick, setTick] = useState(0);

  // One shared 1s ticker drives every key's live countdown.
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const enabled = !!rec?.spawn_tracking;
  const keys = tokens?.data || [];

  // Only surface the Recording card to users with spawn_tracking on
  // (super_admins read true). Otherwise render nothing at all.
  if (!enabled) return null;

  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Recording
      </Typography>
      <Paper sx={{ p: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FiberManualRecordIcon sx={{ fontSize: 10, color: 'success.main' }} />
          <Typography variant="body2" color="success.main" fontWeight={600}>Recording: Enabled</Typography>
        </Box>

        {keys.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
              My recording keys
            </Typography>
            {keys.map((k) => {
              const cd = keyCountdown(k.status, k.remaining_seconds, tick);
              return (
                <Box key={k.jti} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 0.5, flexWrap: 'wrap' }}>
                  <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                    {k.jti}
                  </Typography>
                  {k.scope && (
                    <Chip label={k.scope} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                  )}
                  <Chip
                    label={k.revoked ? 'revoked' : (k.status || 'active')}
                    size="small"
                    variant="outlined"
                    color={k.revoked ? 'error' : (k.status === 'active' ? 'success' : 'default')}
                    sx={{ height: 18, fontSize: '0.65rem' }}
                  />
                  <Typography variant="caption" fontWeight={600} sx={{ ml: 'auto', color: cd.color }}>
                    {cd.label}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        )}
      </Paper>
    </Box>
  );
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && amount >= 1024; ++i) {
    amount /= 1024; unit = units[i];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

function NavigationCacheUploadCard() {
  const { data, error: loadError, refetch } = useApi(() => adminApi.getNavigationCaches(), []);
  const [serverId, setServerId] = useState('');
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const servers = data?.data || [];
  const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);

  useEffect(() => {
    if (!serverId && servers.length) setServerId(String(servers[0].server_id));
  }, [serverId, servers]);

  const chooseFiles = (event) => {
    const selected = Array.from(event.target.files || [])
      .filter((file) => file.name.toLowerCase().endsWith('.mvnav'));
    setFiles(selected);
    setProgress(0);
    setMessage(selected.length ? null : { severity: 'warning', text: 'No .mvnav files selected.' });
  };
  const publish = async () => {
    if (!serverId || files.length === 0) return;
    setUploading(true); setProgress(0); setMessage(null);
    try {
      const result = await adminApi.uploadNavigationCaches(serverId, files,
        (loaded, total) => setProgress(total ? (loaded / total) * 100 : 0));
      setProgress(100);
      setMessage({ severity: 'success', text: result.message });
      setFiles([]);
      await refetch();
    } catch (error) {
      setMessage({ severity: 'error', text: error.message });
    } finally { setUploading(false); }
  };

  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Navigation cache publishing
      </Typography>
      <Paper sx={{ p: 2.5 }}>
        {loadError && <Alert severity="error" sx={{ mb: 2 }}>{loadError.message}</Alert>}
        {message && <Alert severity={message.severity} sx={{ mb: 2 }}>{message.text}</Alert>}
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 220 }}>
            <InputLabel>Game server</InputLabel>
            <Select value={serverId} label="Game server" onChange={(e) => setServerId(e.target.value)} disabled={uploading}>
              {servers.map((server) => (
                <MenuItem key={server.server_id} value={String(server.server_id)}>
                  {server.server_name || server.variant || `Server ${server.server_id}`}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} disabled={uploading}>
            Select cache folder
            <input hidden type="file" multiple accept=".mvnav" onChange={chooseFiles}
              {...{ webkitdirectory: '', directory: '' }} />
          </Button>
          <Button variant="contained" onClick={publish}
            disabled={uploading || !serverId || files.length === 0}>
            Upload cache
          </Button>
          <Typography variant="body2" color="text.secondary">
            {files.length > 0 ? `${files.length} files · ${formatBytes(selectedBytes)}` : 'No package selected'}
          </Typography>
        </Box>
        {uploading && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress variant="determinate" value={progress} />
            <Typography variant="caption" color="text.secondary">
              Uploading {progress.toFixed(0)}% · {formatBytes(selectedBytes)}
            </Typography>
          </Box>
        )}
        {servers.length > 0 && (
          <Table size="small" sx={{ mt: 2 }}>
            <TableHead><TableRow><TableCell>Server</TableCell><TableCell>Schema</TableCell><TableCell>Files</TableCell><TableCell>Size</TableCell><TableCell>Published</TableCell></TableRow></TableHead>
            <TableBody>{servers.map((server) => (
              <TableRow key={server.server_id}>
                <TableCell>{server.server_name || server.variant}</TableCell>
                <TableCell>{server.schema_version || '—'}</TableCell>
                <TableCell>{server.file_count || '—'}</TableCell>
                <TableCell>{server.total_bytes ? formatBytes(server.total_bytes) : '—'}</TableCell>
                <TableCell>{server.uploaded_at ? new Date(server.uploaded_at).toLocaleString() : 'Not published'}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </Paper>
    </Box>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading } = useApi(() => portalApi.getDashboard(), []);
  const { data: statuses } = useApi(() => portalApi.getStatuses(), []);
  const [changelogTab, setChangelogTab] = useState(0);

  if (loading || !data) return null;

  const { licenses, loaderReleases, dllChangelog, loaderChangelog, activeSession } = data;
  const now = Math.floor(Date.now() / 1000);
  const activeChangelog = changelogTab === 0 ? (dllChangelog || []) : (loaderChangelog || []);

  return (
    <Box>
      {/* Global Status Banners */}
      {(statuses || []).map((s) => (
        <Alert key={s.id} severity={s.color} sx={{ mb: 1.5 }}>{s.message}</Alert>
      ))}

      <Box sx={{ mb: 4 }}>
        <Typography variant="h6" fontWeight={600}>
          Welcome back, {user?.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Overview of your bot licenses and activity.
        </Typography>
        {user?.status && (
          <Chip label={user.status} size="small" variant="outlined" sx={{ mt: 1 }} />
        )}
      </Box>

      {/* Status Cards */}
      <Grid container spacing={2} sx={{ mb: 4, '& .MuiGrid-item': { display: 'flex' } }}>
        <Grid item xs={12} sm={4}>
          <Paper sx={{ p: 2.5, flex: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
              Bot Status
            </Typography>
            {activeSession ? (
              <>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <FiberManualRecordIcon sx={{ fontSize: 10, color: 'success.main' }} />
                  <Typography variant="body2" color="success.main" fontWeight={600}>Running</Typography>
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
                  Idle {now - activeSession.last_heartbeat}s
                </Typography>
                {activeSession.hwid && (
                  <Typography variant="caption" fontFamily="monospace" color="text.disabled" sx={{ display: 'block', wordBreak: 'break-all' }}>
                    {activeSession.hwid}
                  </Typography>
                )}
              </>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <FiberManualRecordIcon sx={{ fontSize: 10, color: 'text.disabled' }} />
                <Typography variant="body2" color="text.secondary">Offline</Typography>
              </Box>
            )}
          </Paper>
        </Grid>

        <Grid item xs={12} sm={4}>
          <Paper sx={{ p: 2.5, flex: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
              Licenses
            </Typography>
            <Typography variant="h5" fontWeight={700}>{licenses.length}</Typography>
            <Typography variant="caption" color="text.disabled">
              {licenses.filter(l => l.active).length} active
              {licenses.filter(l => !l.active).length > 0 && ` · ${licenses.filter(l => !l.active).length} revoked`}
            </Typography>
          </Paper>
        </Grid>

        <Grid item xs={12} sm={4}>
          <Paper sx={{ p: 2.5, flex: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
              Last Login
            </Typography>
            {user?.last_login_at ? (
              <>
                <Typography variant="body2" fontWeight={600}>
                  {new Date(user.last_login_at).toLocaleDateString()}
                </Typography>
                <Typography variant="caption" color="text.disabled">
                  {new Date(user.last_login_at).toLocaleTimeString()}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.disabled">First login</Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Recording status + own ingest keys (live countdown) */}
      <RecordingCard />

      {user?.role === 'super_admin' && <NavigationCacheUploadCard />}

      {/* Downloads — compact table */}
      {loaderReleases?.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Downloads
          </Typography>
          <Paper>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Type</TableCell>
                    <TableCell>Channel</TableCell>
                    <TableCell>Version</TableCell>
                    <TableCell align="right"></TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {loaderReleases.map((lr) => (
                    <TableRow key={lr.channel} hover>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>Loader</Typography>
                      </TableCell>
                      <TableCell>
                        <Chip label={lr.channel} size="small" color={getChannelColor(lr.channel)} variant="outlined" />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontFamily="monospace">v{lr.version}</Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Button size="small" variant="contained" startIcon={<DownloadIcon />}
                          component="a" href={`/api/portal/download/loader?channel=${lr.channel}`}>
                          Download
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Box>
      )}

      {/* Recent Updates — DLL / Loader tabs, table layout */}
      {((dllChangelog || []).length > 0 || (loaderChangelog || []).length > 0) && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Recent Updates
          </Typography>
          <Paper sx={{ overflow: 'hidden' }}>
            <Tabs value={changelogTab} onChange={(_, v) => setChangelogTab(v)}
              sx={{ borderBottom: '1px solid', borderColor: 'divider', minHeight: 40,
                '& .MuiTab-root': { minHeight: 40, textTransform: 'uppercase', fontSize: '0.75rem', fontWeight: 600, letterSpacing: '0.05em' } }}>
              <Tab label="DLL" />
              <Tab label="Loader" />
            </Tabs>
            {activeChangelog.length === 0 ? (
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="caption" color="text.disabled">No updates for this type.</Typography>
              </Box>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Version</TableCell>
                      <TableCell>Channel</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Date</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {activeChangelog.map((rel, i) => (
                      <>
                        <TableRow key={`row-${i}`} hover sx={{ '& td': { borderBottom: rel.changelog ? 'none' : undefined } }}>
                          <TableCell>
                            <Typography variant="body2" fontWeight={600}>v{rel.version}</Typography>
                          </TableCell>
                          <TableCell>
                            <Chip label={rel.channel} size="small" color={getChannelColor(rel.channel)} variant="outlined" />
                          </TableCell>
                          <TableCell>
                            {(rel.active === true || rel.active === 1)
                              ? <Chip label="CURRENT" size="small" color="success" variant="outlined" />
                              : <Typography variant="caption" color="text.disabled">—</Typography>
                            }
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.disabled">
                              {new Date(rel.created_at).toLocaleDateString()}
                            </Typography>
                          </TableCell>
                        </TableRow>
                        {rel.changelog && (
                          <TableRow key={`log-${i}`}>
                            <TableCell colSpan={4} sx={{ pt: 0, pb: 1.5 }}>
                              <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
                                {rel.changelog}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>
        </Box>
      )}
    </Box>
  );
}
