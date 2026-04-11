import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Typography, Paper, Chip, TextField, Button, Divider } from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import RedeemIcon from '@mui/icons-material/Redeem';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import StatusBadge from '../common/StatusBadge.jsx';
import ExpiryBadge from '../common/ExpiryBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatDuration } from '../../utils/format.js';

function timeAgo(timestamp) {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function Keys() {
  const { data, loading, refetch } = useApi(() => portalApi.getKeys(), []);
  const { showSnackbar } = useSnackbar();
  const { user } = useAuth();
  const navigate = useNavigate();
  const now = Math.floor(Date.now() / 1000);

  const [redeemKey, setRedeemKey]       = useState('');
  const [redeeming, setRedeeming]       = useState(false);
  const [resetHwidKey, setResetHwidKey] = useState(null);

  const handleRedeem = async () => {
    if (!redeemKey.trim()) return;
    setRedeeming(true);
    try {
      await portalApi.redeemKey({ key: redeemKey.trim() });
      showSnackbar('Key redeemed successfully!');
      setRedeemKey('');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to redeem key', 'error');
    } finally {
      setRedeeming(false);
    }
  };

  const handleResetHwid = async () => {
    try {
      await portalApi.resetHwid({ license_key: resetHwidKey });
      showSnackbar('HWID reset successfully');
      setResetHwidKey(null);
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to reset HWID', 'error');
    }
  };

  if (loading) return null;

  const licenses = data?.licenses || [];

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>My Keys</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        All keys assigned to your account with session details.
      </Typography>

      {/* Redeem Key */}
      <Paper sx={{ p: 2, mb: 3, display: 'flex', gap: 2, alignItems: 'center' }}>
        <TextField
          size="small"
          placeholder="Enter license key to redeem..."
          value={redeemKey}
          onChange={(e) => setRedeemKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleRedeem()}
          sx={{ flex: 1 }}
        />
        <Button variant="contained" startIcon={<RedeemIcon />} onClick={handleRedeem} disabled={redeeming || !redeemKey.trim()}>
          {redeeming ? 'Redeeming...' : 'Redeem'}
        </Button>
      </Paper>

      {licenses.length === 0 && (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <Typography color="text.disabled">No license keys assigned to your account.</Typography>
          <Typography variant="caption" color="text.disabled">Redeem a key above or visit the shop.</Typography>
        </Paper>
      )}

      {licenses.map((lic) => (
        <Paper key={lic.license_key} sx={{ mb: 3 }}>
          {/* Key Header — spacious layout */}
          <Box sx={{ p: 2.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1.5 }}>
              <CopyableText text={lic.license_key} />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <StatusBadge status={lic.active ? 'active' : 'revoked'} />
                <ExpiryBadge expiresAt={lic.expires_at} />
              </Box>
            </Box>

            {/* Meta row */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 1.5, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Sessions: <strong>{lic.liveSessions?.length || 0}</strong> / {lic.max_sessions}
              </Typography>
              {lic.bound_hwid && (
                <Typography variant="caption" fontFamily="monospace" color="text.disabled">
                  HWID: {lic.bound_hwid.slice(0, 20)}...
                </Typography>
              )}
              {lic.note && (
                <Typography variant="caption" color="text.disabled">{lic.note}</Typography>
              )}

              <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
                {lic.bound_hwid && user?.hwid_reset_enabled && (
                  <Button size="small" variant="outlined" color="warning" startIcon={<RestartAltIcon />}
                    onClick={() => setResetHwidKey(lic.license_key)}>
                    Reset HWID
                  </Button>
                )}
                {lic.active && lic.expires_at && (
                  <Button size="small" variant="outlined" onClick={() => navigate(`/portal/shop?extend=${lic.license_key}`)}>
                    Extend
                  </Button>
                )}
              </Box>
            </Box>
          </Box>

          {/* Live Sessions */}
          {lic.liveSessions?.length > 0 && (
            <>
              <Divider />
              <Box sx={{ px: 2.5, py: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                  <FiberManualRecordIcon sx={{ fontSize: 8, color: 'success.main' }} />
                  <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                    Live Sessions
                  </Typography>
                </Box>
                {lic.liveSessions.map((s) => (
                  <Box key={s.session_id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.5, flexWrap: 'wrap' }}>
                    <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                      HWID: {s.hwid || 'N/A'}
                    </Typography>
                    <Typography variant="caption" color="text.disabled">
                      started {timeAgo(s.started_at)} · runtime {formatDuration(now - s.started_at)}
                    </Typography>
                    <Chip label={`idle ${now - s.last_heartbeat}s`} size="small" color="success" variant="outlined" sx={{ ml: 'auto' }} />
                  </Box>
                ))}
              </Box>
            </>
          )}

          {/* Stale Sessions */}
          {lic.staleSessions?.length > 0 && (
            <>
              <Divider />
              <Box sx={{ px: 2.5, py: 1.5 }}>
                <Typography variant="caption" color="text.disabled" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, mb: 0.5, display: 'block' }}>
                  Recent Sessions
                </Typography>
                {lic.staleSessions.slice(0, 5).map((s) => (
                  <Box key={s.session_id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 0.5 }}>
                    <Typography variant="caption" fontFamily="monospace" color="text.disabled">
                      {s.hwid || s.session_id.slice(0, 24) + '...'}
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
            </>
          )}

          {(!lic.liveSessions?.length && !lic.staleSessions?.length) && (
            <>
              <Divider />
              <Box sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="caption" color="text.disabled">No sessions recorded yet for this key.</Typography>
              </Box>
            </>
          )}
        </Paper>
      ))}

      <ConfirmDialog
        open={!!resetHwidKey}
        title="Reset HWID"
        message="This will unbind the hardware ID from this key and terminate active sessions. You can then use the key on a different machine."
        onConfirm={handleResetHwid}
        onCancel={() => setResetHwidKey(null)}
        confirmText="Reset HWID"
        color="warning"
      />
    </Box>
  );
}
