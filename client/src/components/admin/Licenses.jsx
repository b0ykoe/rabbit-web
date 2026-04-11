import { useState } from 'react';
import { Box, Typography, Button, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import LicenseFormDialog from './LicenseFormDialog.jsx';
import AssignDialog from './AssignDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Licenses() {
  const [page, setPage] = useState(1);
  const { data, loading, refetch } = useApi(() => adminApi.getLicenses(page), [page]);
  const { showSnackbar } = useSnackbar();

  const [createOpen, setCreateOpen]     = useState(false);
  const [assignLic, setAssignLic]       = useState(null);
  const [revokeLic, setRevokeLic]       = useState(null);

  const handleCreate = async (formData) => {
    const result = await adminApi.createLicense(formData);
    showSnackbar(`Key created: ${result.license_key}`);
    refetch();
  };

  const handleAssign = async (key, formData) => {
    await adminApi.assignLicense(key, formData);
    showSnackbar('License assigned');
    setAssignLic(null);
    refetch();
  };

  const handleRevoke = async () => {
    await adminApi.revokeLicense(revokeLic.license_key);
    showSnackbar('License revoked');
    setRevokeLic(null);
    refetch();
  };

  const columns = [
    { id: 'license_key', label: 'Key', render: (row) => <CopyableText text={row.license_key} /> },
    { id: 'status', label: 'Status', render: (row) => <StatusBadge status={row.active ? 'active' : 'revoked'} /> },
    { id: 'user', label: 'User', render: (row) => row.user_name || <Typography variant="caption" color="text.disabled">unassigned</Typography> },
    {
      id: 'sessions', label: 'Sessions', align: 'center',
      render: (row) => (
        <Chip
          label={`${row.live_sessions} / ${row.max_sessions}`}
          size="small"
          color={row.live_sessions > 0 ? 'success' : 'default'}
          variant="outlined"
        />
      ),
    },
    { id: 'note', label: 'Note', render: (row) => <Typography variant="caption" color="text.disabled">{row.note || ''}</Typography> },
    {
      id: 'actions', label: '', align: 'right',
      render: (row) => (
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => setAssignLic(row)}>Assign</Button>
          {row.active && <Button size="small" color="error" onClick={() => setRevokeLic(row)}>Revoke</Button>}
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Licenses</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          Create Key
        </Button>
      </Box>

      <DataTable
        columns={columns}
        rows={data?.data || []}
        loading={loading}
        page={page}
        totalPages={data?.totalPages || 1}
        total={data?.total || 0}
        onPageChange={setPage}
        rowKey="license_key"
      />

      <LicenseFormDialog open={createOpen} onClose={() => setCreateOpen(false)} onSubmit={handleCreate} />
      <AssignDialog
        open={!!assignLic}
        onClose={() => setAssignLic(null)}
        onSubmit={handleAssign}
        licenseKey={assignLic?.license_key}
        currentUserId={assignLic?.user_id}
        users={data?.users || []}
      />
      <ConfirmDialog
        open={!!revokeLic}
        title="Revoke License"
        message={`Revoke key "${revokeLic?.license_key}"? Active sessions will be rejected on next heartbeat.`}
        onConfirm={handleRevoke}
        onCancel={() => setRevokeLic(null)}
        confirmText="Revoke"
      />
    </Box>
  );
}
