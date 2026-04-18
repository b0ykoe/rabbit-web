import { useState } from 'react';
import {
  Grid, Box, Typography, Paper, Chip, Button, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Tabs, Tab,
} from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import DownloadIcon from '@mui/icons-material/Download';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getChannelColor } from '../../utils/format.js';

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
