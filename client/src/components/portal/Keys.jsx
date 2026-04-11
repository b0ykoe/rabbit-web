import { Box, Typography, Paper, Chip } from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';

function timeAgo(timestamp) {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Keys() {
  const { data, loading } = useApi(() => portalApi.getKeys(), []);
  const now = Math.floor(Date.now() / 1000);

  if (loading) return null;

  const licenses = data?.licenses || [];

  if (licenses.length === 0) {
    return (
      <Box>
        <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>My License Keys</Typography>
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <Typography color="text.disabled">No license keys assigned to your account.</Typography>
          <Typography variant="caption" color="text.disabled">Contact support to get a key.</Typography>
        </Paper>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>My License Keys</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        All keys assigned to your account with session details.
      </Typography>

      {licenses.map((lic) => (
        <Paper key={lic.license_key} sx={{ mb: 3 }}>
          {/* Key Header */}
          <Box sx={{ px: 2, py: 2, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <StatusBadge status={lic.active ? 'active' : 'revoked'} />
                <CopyableText text={lic.license_key} />
              </Box>
              {lic.note && <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5 }}>{lic.note}</Typography>}
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="caption" color="text.secondary">Max Sessions</Typography>
              <Typography variant="body2" fontWeight={600}>
                {lic.liveSessions?.length || 0} / {lic.max_sessions}
              </Typography>
            </Box>
          </Box>

          {/* Live Sessions */}
          {lic.liveSessions?.length > 0 && (
            <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                <FiberManualRecordIcon sx={{ fontSize: 8, color: 'success.main' }} />
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                  Live Sessions
                </Typography>
              </Box>
              {lic.liveSessions.map((s) => (
                <Box key={s.session_id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.5 }}>
                  <Typography variant="caption" fontFamily="monospace" color="text.disabled">
                    {s.session_id.slice(0, 24)}...
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    started {timeAgo(s.started_at)}
                  </Typography>
                  <Chip
                    label={`idle ${now - s.last_heartbeat}s`}
                    size="small"
                    color="success"
                    variant="outlined"
                    sx={{ ml: 'auto' }}
                  />
                </Box>
              ))}
            </Box>
          )}

          {/* Stale Sessions */}
          {lic.staleSessions?.length > 0 && (
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mb: 1 }}>
                Recent Sessions
              </Typography>
              {lic.staleSessions.slice(0, 5).map((s) => (
                <Box key={s.session_id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.5 }}>
                  <Typography variant="caption" fontFamily="monospace" color="text.disabled">
                    {s.session_id.slice(0, 24)}...
                  </Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ ml: 'auto' }}>
                    {timeAgo(s.last_heartbeat)}
                  </Typography>
                </Box>
              ))}
              {lic.staleSessions.length > 5 && (
                <Typography variant="caption" color="text.disabled">
                  + {lic.staleSessions.length - 5} older session(s)
                </Typography>
              )}
            </Box>
          )}

          {/* Empty state */}
          {(!lic.liveSessions?.length && !lic.staleSessions?.length) && (
            <Box sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="caption" color="text.disabled">No sessions recorded yet for this key.</Typography>
            </Box>
          )}
        </Paper>
      ))}
    </Box>
  );
}
