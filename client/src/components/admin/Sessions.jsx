import { useState, useEffect } from 'react';
import { Box, Typography, Chip, IconButton, Tooltip, ToggleButtonGroup, ToggleButton } from '@mui/material';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatDuration } from '../../utils/format.js';

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function Sessions() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('active');
  const { data, loading, refetch } = useApi(() => adminApi.getSessions(page, statusFilter), [page, statusFilter]);
  const { showSnackbar } = useSnackbar();
  const { user: me } = useAuth();
  // IP addresses are only exposed to super-admins (server strips them
  // from the response for plain admins, so this is also a display gate).
  const canSeeIp = me?.role === 'super_admin';
  const [killTarget, setKillTarget] = useState(null);

  useEffect(() => {
    const interval = setInterval(refetch, 5000);
    return () => clearInterval(interval);
  }, [refetch]);

  const handleKill = async () => {
    if (!killTarget) return;
    try {
      await adminApi.killSession(killTarget);
      showSnackbar('Session terminated');
      setKillTarget(null);
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to kill session', 'error');
    }
  };

  const now = Math.floor(Date.now() / 1000);

  const columns = [
    {
      id: 'session_id', label: 'Session ID',
      render: (row) => <CopyableText text={row.session_id} />,
    },
    { id: 'license_key', label: 'Key', render: (row) => <CopyableText text={row.license_key} /> },
    {
      id: 'hwid', label: 'HWID',
      render: (row) => (
        <Typography variant="caption" fontFamily="monospace" color="text.secondary">
          {row.hwid || 'N/A'}
        </Typography>
      ),
    },
    {
      id: 'user', label: 'User',
      render: (row) => row.user_name
        ? <Tooltip title={row.user_email}><Typography variant="body2">{row.user_name}</Typography></Tooltip>
        : <Typography variant="caption" color="text.disabled">unassigned</Typography>,
    },
    // Game-server column — which LC server the bot client is connected to.
    // Visible to every admin (a game-server endpoint is a public address,
    // unlike the client IP below which is super-admin-only).
    {
      id: 'game_server', label: 'Game Server',
      render: (row) => {
        const ip      = row.game_server_ip;
        const port    = row.game_server_port;
        const variant = row.game_server_variant;
        if (!ip && !variant) return <Typography variant="caption" color="text.disabled">—</Typography>;
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            {ip && (
              <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                {port ? `${ip}:${port}` : ip}
              </Typography>
            )}
            {variant && (
              <Chip
                label={variant}
                size="small"
                variant="outlined"
                color={variant === 'Nemesis' ? 'secondary' : variant === 'EP4 Stock' ? 'primary' : 'default'}
                sx={{ alignSelf: 'flex-start', height: 18, fontSize: '0.7rem' }}
              />
            )}
          </Box>
        );
      },
    },
    // IP column — super-admin only. The server side also redacts these
    // fields for non-super-admin viewers (belt-and-braces).
    ...(canSeeIp ? [{
      id: 'ip', label: 'IP',
      render: (row) => {
        const primary = row.ip_address;
        const last    = row.last_ip_address;
        if (!primary && !last) return <Typography variant="caption" color="text.disabled">—</Typography>;
        const drifted = primary && last && primary !== last;
        return (
          <Tooltip title={drifted ? `start: ${primary}` : ''}>
            <Typography variant="caption" fontFamily="monospace"
                        color={drifted ? 'warning.main' : 'text.secondary'}>
              {last || primary}
            </Typography>
          </Tooltip>
        );
      },
    }] : []),
    {
      id: 'runtime', label: 'Runtime',
      render: (row) => (
        <Typography variant="caption" color="text.secondary">
          {formatDuration((row.ended_at || now) - row.started_at)}
        </Typography>
      ),
    },
    {
      id: 'status', label: 'Status',
      render: (row) => {
        if (!row.active) {
          const reasonColors = { admin_kill: 'error', user_kill: 'warning', user_end: 'info', heartbeat_timeout: 'default', hwid_reset: 'warning' };
          return <Chip label={row.end_reason || 'ended'} size="small" variant="outlined" color={reasonColors[row.end_reason] || 'default'} />;
        }
        return <StatusBadge status={row.is_alive ? 'live' : 'stale'} />;
      },
    },
    {
      id: 'stats', label: 'Stats',
      render: (row) => {
        const s = row.stats;
        if (!s) return <Typography variant="caption" color="text.disabled">-</Typography>;
        return (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {s.kills > 0 && <Chip label={`${s.kills} kills`} size="small" variant="outlined" />}
            {s.xp_earned > 0 && <Chip label={`${(s.xp_earned / 1000).toFixed(1)}k XP`} size="small" variant="outlined" color="primary" />}
            {s.items_looted > 0 && <Chip label={`${s.items_looted} items`} size="small" variant="outlined" />}
            {s.deaths > 0 && <Chip label={`${s.deaths} deaths`} size="small" variant="outlined" color="error" />}
          </Box>
        );
      },
    },
    {
      id: 'idle', label: 'Idle / Ended', align: 'right',
      render: (row) => {
        if (!row.active) {
          return <Typography variant="caption" color="text.disabled">{timeAgo(row.ended_at)}</Typography>;
        }
        return (
          <Chip
            label={`${row.idle_seconds}s`}
            size="small"
            variant="outlined"
            color={row.idle_seconds < 30 ? 'success' : row.idle_seconds < 60 ? 'warning' : 'error'}
          />
        );
      },
    },
    {
      id: 'actions', label: '', align: 'right',
      render: (row) => row.active ? (
        <Tooltip title="Kill session">
          <IconButton size="small" color="error" onClick={() => setKillTarget(row.session_id)}>
            <StopCircleIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null,
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Bot Sessions</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <ToggleButtonGroup size="small" value={statusFilter} exclusive onChange={(_, v) => { if (v) { setStatusFilter(v); setPage(1); } }}>
            <ToggleButton value="active">Active</ToggleButton>
            <ToggleButton value="archived">Archived</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.disabled">
            {data?.total || 0} session(s) &middot; auto-refresh 5s
          </Typography>
        </Box>
      </Box>

      <DataTable
        columns={columns}
        rows={data?.data || []}
        loading={loading}
        page={page}
        totalPages={data?.totalPages || 1}
        total={data?.total || 0}
        onPageChange={setPage}
        rowsPerPage={50}
        rowKey="session_id"
      />

      <ConfirmDialog
        open={!!killTarget}
        title="Kill Session"
        message={`Terminate session ${killTarget}? The bot will disconnect on the next heartbeat.`}
        onConfirm={handleKill}
        onCancel={() => setKillTarget(null)}
        confirmText="Kill"
        color="error"
      />
    </Box>
  );
}
