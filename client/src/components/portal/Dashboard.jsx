import { Grid, Box, Typography, Paper, Chip } from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import StatCard from '../common/StatCard.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';

export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading } = useApi(() => portalApi.getDashboard(), []);

  if (loading || !data) return null;

  const { licenses, dllRelease, changelog, activeSession } = data;
  const now = Math.floor(Date.now() / 1000);

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>
        Welcome back, {user?.name}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Here's an overview of your bot licenses and activity.
      </Typography>

      {/* Status Row */}
      <Grid container spacing={2} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Bot Status
            </Typography>
            {activeSession ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                <FiberManualRecordIcon sx={{ fontSize: 10, color: 'success.main', animation: 'pulse 2s infinite' }} />
                <Typography variant="body2" color="success.main" fontWeight={600}>Running</Typography>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                <FiberManualRecordIcon sx={{ fontSize: 10, color: 'text.disabled' }} />
                <Typography variant="body2" color="text.secondary">Offline</Typography>
              </Box>
            )}
            {activeSession && (
              <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5 }}>
                Idle {now - activeSession.last_heartbeat}s
              </Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Current DLL Version
            </Typography>
            {dllRelease ? (
              <>
                <Typography variant="body1" fontWeight={600} sx={{ mt: 0.5 }}>v{dllRelease.version}</Typography>
                <Typography variant="caption" fontFamily="monospace" color="text.disabled">
                  {dllRelease.sha256?.slice(0, 16)}...
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>No release</Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={4}>
          <StatCard
            label="Licenses"
            value={licenses.length}
            subtitle={`${licenses.filter(l => l.active).length} active`}
          />
        </Grid>
      </Grid>

      {/* Keys Summary */}
      {licenses.length > 0 ? (
        <Box sx={{ mb: 4 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Your Keys
          </Typography>
          <Paper>
            {licenses.map((lic) => (
              <Box key={lic.license_key} sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 'none' } }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                  <StatusBadge status={lic.active ? 'active' : 'revoked'} />
                  <CopyableText text={lic.license_key} />
                </Box>
                <Chip
                  label={`${lic.sessions?.length || 0} / ${lic.max_sessions}`}
                  size="small"
                  color={(lic.sessions?.length || 0) > 0 ? 'success' : 'default'}
                  variant="outlined"
                />
              </Box>
            ))}
          </Paper>
        </Box>
      ) : (
        <Paper sx={{ p: 4, textAlign: 'center', mb: 4 }}>
          <Typography color="text.disabled">No license keys assigned to your account.</Typography>
          <Typography variant="caption" color="text.disabled">Contact support to get a key.</Typography>
        </Paper>
      )}

      {/* Changelog */}
      {changelog.length > 0 && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Recent Updates
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {changelog.map((rel) => (
              <Paper key={rel.version} sx={{ px: 2, py: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="body2" fontWeight={600}>v{rel.version}</Typography>
                  {rel.active && <StatusBadge status="active" label="Current" />}
                  <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }}>
                    {new Date(rel.created_at).toLocaleDateString()}
                  </Typography>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'pre-line' }}>
                  {rel.changelog}
                </Typography>
              </Paper>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}
