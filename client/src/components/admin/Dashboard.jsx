import {
  Grid, Typography, Paper, Box, Chip,
} from '@mui/material';
import PeopleIcon from '@mui/icons-material/People';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import SensorsIcon from '@mui/icons-material/Sensors';
import StatCard from '../common/StatCard.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { getChannelColor } from '../../utils/format.js';

export default function Dashboard() {
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
                  <Typography variant="caption" fontFamily="monospace" color="text.disabled" sx={{ display: 'block', mt: 0.5 }}>
                    SHA-256: {activeReleases[type].sha256?.slice(0, 20)}...
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
                  <td><Typography variant="caption" fontFamily="monospace">{s.session_id.slice(0, 12)}...</Typography></td>
                  <td><Typography variant="caption" fontFamily="monospace" color="text.secondary">{s.hwid ? s.hwid.slice(0, 12) + '...' : 'N/A'}</Typography></td>
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
