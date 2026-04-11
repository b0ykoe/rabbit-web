import { useState, useEffect } from 'react';
import { Box, Typography, Chip } from '@mui/material';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';

export default function Sessions() {
  const [page, setPage] = useState(1);
  const { data, loading, refetch } = useApi(() => adminApi.getSessions(page), [page]);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    const interval = setInterval(refetch, 5000);
    return () => clearInterval(interval);
  }, [refetch]);

  const columns = [
    {
      id: 'session_id', label: 'Session',
      render: (row) => <Typography variant="caption" fontFamily="monospace">{row.session_id.slice(0, 20)}...</Typography>,
    },
    { id: 'license_key', label: 'Key', render: (row) => <CopyableText text={row.license_key} /> },
    { id: 'user', label: 'User', render: (row) => row.user_name || <Typography variant="caption" color="text.disabled">unassigned</Typography> },
    {
      id: 'status', label: 'Status',
      render: (row) => <StatusBadge status={row.is_alive ? 'live' : 'stale'} />,
    },
    {
      id: 'idle', label: 'Idle', align: 'right',
      render: (row) => (
        <Chip
          label={`${row.idle_seconds}s`}
          size="small"
          variant="outlined"
          color={row.idle_seconds < 30 ? 'success' : row.idle_seconds < 60 ? 'warning' : 'error'}
        />
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Bot Sessions</Typography>
        <Typography variant="caption" color="text.disabled">Auto-refreshing every 5s</Typography>
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
    </Box>
  );
}
