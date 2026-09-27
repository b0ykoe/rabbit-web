import {
  Grid, Typography, Paper, Box, Chip, Button,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import PeopleIcon from '@mui/icons-material/People';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import SensorsIcon from '@mui/icons-material/Sensors';
import StorageIcon from '@mui/icons-material/Storage';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import StatCard from '../common/StatCard.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getChannelColor } from '../../utils/format.js';

export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading } = useApi(() => adminApi.getDashboard(), []);
  const now = Math.floor(Date.now() / 1000);

  if (loading || !data) return null;

  const { stats, activeReleases, recentSessions } = data;

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>Dashboard</Typography>

      {/* Stat Cards */}
      <Grid container spacing={2} sx={{ mb: 4, '& .MuiGrid-item': { display: 'flex' } }}>
        <Grid item xs={12} sm={4}>
          <StatCard label="Users" value={stats.users} icon={<PeopleIcon />} />
        </Grid>
        <Grid item xs={12} sm={4}>
          <StatCard label="Active Licenses" value={`${stats.activeLicenses} / ${stats.licenses}`} icon={<VpnKeyIcon />} />
        </Grid>
        <Grid item xs={12} sm={4}>
          <StatCard label="Live Sessions" value={stats.liveSessions} icon={<SensorsIcon />} color="primary.main" />
        </Grid>
      </Grid>

      {user?.role === 'super_admin' && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Navigation cache publishing
          </Typography>
          <Paper sx={{ p: 2.5 }}>
            <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
              <StorageIcon color="primary" sx={{ mt: 0.25 }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.75 }}>
                  Generate Cloudflare-safe 64 MiB upload parts
                </Typography>
                <Box component="code" sx={{ display: 'block', p: 1.25, mb: 1.25,
                  bgcolor: 'background.default', border: '1px solid', borderColor: 'divider',
                  borderRadius: 1, fontSize: '0.75rem', overflowX: 'auto', userSelect: 'all' }}>
                  .\scripts\New-NavigationCacheParts.ps1 -PackageName Nemesis
                </Box>
                <Box component="ol" sx={{ mt: 0, mb: 1.5, pl: 2.5, color: 'text.secondary',
                  '& li': { pl: 0.5, mb: 0.35, fontSize: '0.8125rem' } }}>
                  <li>Run the command in the portal-v2 repository.</li>
                  <li>Select the generated timestamped parts folder.</li>
                  <li>Upload all parts sequentially.</li>
                  <li>Press Analyze &amp; publish after every part is present.</li>
                </Box>
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
                  The currently published package remains active until reassembly, SHA-256 checks
                  and all `.mvnav` validations have completed successfully.
                </Typography>
                <Button component={RouterLink} to="/admin/navigation-caches" size="small"
                  variant="contained" endIcon={<ArrowForwardIcon />}>
                  Open Navigation Caches
                </Button>
              </Box>
            </Box>
          </Paper>
        </Box>
      )}

      {/* Active Releases */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Active Releases
      </Typography>
      <Grid container spacing={2} sx={{ mb: 4, '& .MuiGrid-item': { display: 'flex' } }}>
        {['dll', 'loader'].map((type) => (
          <Grid item xs={12} sm={6} key={type}>
            <Paper sx={{ p: 2.5, flex: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {type}
              </Typography>
              {activeReleases[type] ? (
                <Box sx={{ mt: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body1" fontWeight={700}>v{activeReleases[type].version}</Typography>
                    {activeReleases[type].channel && (
                      <Chip label={activeReleases[type].channel} size="small" color={getChannelColor(activeReleases[type].channel)} variant="outlined" />
                    )}
                  </Box>
                  <Typography variant="caption" fontFamily="monospace" color="text.disabled" sx={{ display: 'block', mt: 0.5, wordBreak: 'break-all' }}>
                    SHA-256: {activeReleases[type].sha256}
                  </Typography>
                </Box>
              ) : (
                <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>No active release</Typography>
              )}
            </Paper>
          </Grid>
        ))}
      </Grid>

      {/* Live Sessions */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Live Sessions ({recentSessions.length})
      </Typography>
      <Paper>
        {recentSessions.length === 0 ? (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Typography color="text.disabled">No active sessions</Typography>
          </Box>
        ) : (
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& td, & th': { p: 1.5, borderBottom: '1px solid', borderColor: 'divider', fontSize: '0.8125rem' }, '& th': { color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em' } }}>
            <thead>
              <tr>
                <th align="left">Session</th>
                <th align="left">HWID</th>
                <th align="left">Key</th>
                <th align="left">User</th>
                <th align="right">Idle</th>
              </tr>
            </thead>
            <tbody>
              {recentSessions.map((s) => (
                <tr key={s.session_id}>
                  <td><CopyableText text={s.session_id} /></td>
                  <td>{s.hwid ? <CopyableText text={s.hwid} /> : <Typography variant="caption" color="text.disabled">N/A</Typography>}</td>
                  <td><CopyableText text={s.license_key} /></td>
                  <td>{s.user_name || <Typography variant="caption" color="text.disabled">—</Typography>}</td>
                  <td align="right">
                    <Chip label={`${now - s.last_heartbeat}S`} size="small" variant="outlined"
                      color={now - s.last_heartbeat < 30 ? 'success' : now - s.last_heartbeat < 60 ? 'warning' : 'error'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Box>
        )}
      </Paper>
    </Box>
  );
}
