import { useState } from 'react';
import { Box, Typography, Button, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import ExpiryBadge from '../common/ExpiryBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import LicenseFormDialog from './LicenseFormDialog.jsx';
import LicenseEditDialog from './LicenseEditDialog.jsx';
import ExtendDialog from './ExtendDialog.jsx';
import AssignDialog from './AssignDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Licenses() {
  const [page, setPage] = useState(1);
  const { data, loading, refetch } = useApi(() => adminApi.getLicenses(page), [page]);
  const { showSnackbar } = useSnackbar();

  const [createOpen, setCreateOpen]   = useState(false);
  const [editLic, setEditLic]         = useState(null);
  const [extendLic, setExtendLic]     = useState(null);
  const [assignLic, setAssignLic]     = useState(null);
  const [revokeLic, setRevokeLic]     = useState(null);

  const handleCreate = async (formData) => {
    const result = await adminApi.createLicense(formData);
    showSnackbar(`Key created: ${result.license_key}`);
    refetch();
  };

  const handleEdit = async (key, formData) => {
    await adminApi.updateLicense(key, formData);
    showSnackbar('License updated');
    setEditLic(null);
    refetch();
  };

  const handleExtend = async (key, formData) => {
    await adminApi.extendLicense(key, formData);
    showSnackbar('License extended');
    setExtendLic(null);
    refetch();
  };

  const handleAssign = async (key, formData) => {
    await adminApi.assignLicense(key, formData);
    showSnackbar('License assigned');
    setAssignLic(null);
    refetch();
  };

  const handleResetHwid = async (key) => {
    try {
      await adminApi.resetLicenseHwid(key);
      showSnackbar('HWID reset');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed', 'error');
    }
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
    { id: 'expiry', label: 'Expiry', render: (row) => <ExpiryBadge expiresAt={row.expires_at} /> },
    { id: 'user', label: 'User', render: (row) => row.user_name || <Typography variant="caption" color="text.disabled">unassigned</Typography> },
    { id: 'purchased_by', label: 'Purchased By', render: (row) => row.purchased_by_name || <Typography variant="caption" color="text.disabled">—</Typography> },
    { id: 'hwid', label: 'HWID', render: (row) => row.bound_hwid ? <CopyableText text={row.bound_hwid} /> : <Typography variant="caption" color="text.disabled">—</Typography> },
    {
      id: 'sessions', label: 'Sessions', align: 'center',
      render: (row) => (
        <Chip label={`${row.live_sessions} / ${row.max_sessions}`} size="small" color={row.live_sessions > 0 ? 'success' : 'default'} variant="outlined" />
      ),
    },
    {
      id: 'actions', label: '', align: 'right',
      render: (row) => (
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => setEditLic(row)}>Edit</Button>
          {row.active && row.expires_at && <Button size="small" onClick={() => setExtendLic(row)}>Extend</Button>}
          {row.bound_hwid && <Button size="small" color="warning" onClick={() => handleResetHwid(row.license_key)}>Reset HWID</Button>}
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
      <LicenseEditDialog open={!!editLic} onClose={() => setEditLic(null)} onSubmit={handleEdit} license={editLic} />
      <ExtendDialog open={!!extendLic} onClose={() => setExtendLic(null)} onSubmit={handleExtend} licenseKey={extendLic?.license_key} />
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
        message={`Revoke key "${revokeLic?.license_key}"?`}
        onConfirm={handleRevoke}
        onCancel={() => setRevokeLic(null)}
        confirmText="Revoke"
      />
    </Box>
  );
}
