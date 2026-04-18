import { useState } from 'react';
import {
  Box, Typography, Grid, Paper, Chip, ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
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
  const [statusFilter, setStatusFilter] = useState('all');
  const { data, loading } = useApi(() => portalApi.getSessions(page, statusFilter), [page, statusFilter]);

  const now = Math.floor(Date.now() / 1000);
  const agg = data?.aggregates || {};

  const reasonColors = { admin_kill: 'error', user_kill: 'warning', user_end: 'info', heartbeat_timeout: 'default', hwid_reset: 'warning' };

  const columns = [
    { id: 'session_id', label: 'Session ID', render: (row) => <CopyableText text={row.session_id} /> },
    { id: 'license_key', label: 'Key', render: (row) => <CopyableText text={row.license_key} /> },
    {
      id: 'hwid', label: 'HWID',
      render: (row) => row.hwid
        ? <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ wordBreak: 'break-all' }}>{row.hwid}</Typography>
        : <Typography variant="caption" color="text.disabled">N/A</Typography>,
    },
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
      id: 'time', label: 'Time', align: 'right',
      render: (row) => (
        <Typography variant="caption" color="text.disabled">
          {row.active ? `started ${timeAgo(row.started_at)}` : timeAgo(row.ended_at)}
        </Typography>
      ),
    },
  ];

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>My Sessions</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Session history and aggregated statistics across all your keys.
      </Typography>

      {/* Aggregated Stats */}
      <Grid container spacing={2} sx={{ mb: 4, '& .MuiGrid-item': { display: 'flex' } }}>
        {[
          { label: 'Total Sessions', value: agg.sessions || 0 },
          { label: 'Total Kills', value: agg.kills || 0 },
          { label: 'Total XP', value: agg.xp_earned ? `${(agg.xp_earned / 1000).toFixed(1)}k` : '0' },
          { label: 'Total Items', value: agg.items_looted || 0 },
          { label: 'Total Deaths', value: agg.deaths || 0 },
          { label: 'Total Runtime', value: agg.runtime_ms ? formatDuration(Math.floor(agg.runtime_ms / 1000)) : '0s' },
        ].map((stat) => (
          <Grid item xs={6} sm={2} key={stat.label}>
            <Paper sx={{ p: 2, flex: 1, textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block' }}>
                {stat.label}
              </Typography>
              <Typography variant="h6" fontWeight={700} sx={{ mt: 0.5 }}>{stat.value}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {/* Filter + Table */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <ToggleButtonGroup size="small" value={statusFilter} exclusive onChange={(_, v) => { if (v) { setStatusFilter(v); setPage(1); } }}>
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="active">Active</ToggleButton>
          <ToggleButton value="archived">Archived</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.disabled">
          {data?.total || 0} session(s)
        </Typography>
      </Box>

      <DataTable
        columns={columns}
        rows={data?.data || []}
        loading={loading}
        page={page}
        totalPages={data?.totalPages || 1}
        total={data?.total || 0}
        onPageChange={setPage}
        rowsPerPage={25}
        rowKey="session_id"
      />
    </Box>
  );
}
