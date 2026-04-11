import { useState } from 'react';
import { Box, Typography, Button, Chip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DataTable from '../common/DataTable.jsx';
import StatusBadge from '../common/StatusBadge.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import UserFormDialog from './UserFormDialog.jsx';
import CreditAdjustDialog from './CreditAdjustDialog.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Users() {
  const [page, setPage] = useState(1);
  const { data, loading, refetch } = useApi(() => adminApi.getUsers(page), [page]);
  const { showSnackbar } = useSnackbar();

  const [createOpen, setCreateOpen]   = useState(false);
  const [editUser, setEditUser]       = useState(null);
  const [deleteUser, setDeleteUser]   = useState(null);
  const [creditUser, setCreditUser]   = useState(null);

  const handleCreate = async (formData) => {
    await adminApi.createUser(formData);
    showSnackbar('User created');
    refetch();
  };

  const handleUpdate = async (formData) => {
    await adminApi.updateUser(editUser.id, formData);
    showSnackbar('User updated');
    setEditUser(null);
    refetch();
  };

  const handleDelete = async () => {
    await adminApi.deleteUser(deleteUser.id);
    showSnackbar('User deleted');
    setDeleteUser(null);
    refetch();
  };

  const handleAdjustCredits = async (id, data) => {
    await adminApi.adjustCredits(id, data);
    showSnackbar('Credits adjusted');
    setCreditUser(null);
    refetch();
  };

  const columns = [
    { id: 'id', label: 'ID' },
    { id: 'name', label: 'Name' },
    { id: 'email', label: 'Email', render: (row) => <Typography variant="body2" fontFamily="monospace" fontSize="0.75rem">{row.email}</Typography> },
    { id: 'role', label: 'Role', render: (row) => <StatusBadge status={row.role === 'admin' ? 'active' : 'offline'} label={row.role} /> },
    { id: 'credits', label: 'Credits', align: 'center', render: (row) => (
      <Chip label={row.credits} size="small" variant="outlined" color={row.credits > 0 ? 'primary' : 'default'} />
    )},
    { id: 'channels', label: 'Channels', render: (row) => (
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        {(row.allowed_channels || ['release']).map(ch => (
          <Chip key={ch} label={ch} size="small" variant="outlined" sx={{ fontSize: '0.65rem' }} />
        ))}
      </Box>
    )},
    { id: 'status', label: 'Status', render: (row) => row.status ? <Chip label={row.status} size="small" variant="outlined" sx={{ fontSize: '0.65rem' }} /> : <Typography variant="caption" color="text.disabled">—</Typography> },
    { id: 'license_count', label: 'Keys', align: 'center' },
    {
      id: 'actions', label: '', align: 'right',
      render: (row) => (
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={() => setCreditUser(row)}>Credits</Button>
          <Button size="small" onClick={() => setEditUser(row)}>Edit</Button>
          <Button size="small" color="error" onClick={() => setDeleteUser(row)}>Delete</Button>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Users</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          Create User
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
      />

      <UserFormDialog open={createOpen} onClose={() => setCreateOpen(false)} onSubmit={handleCreate} />
      <UserFormDialog open={!!editUser} onClose={() => setEditUser(null)} onSubmit={handleUpdate} user={editUser} />
      <CreditAdjustDialog open={!!creditUser} onClose={() => setCreditUser(null)} onSubmit={handleAdjustCredits} user={creditUser} />
      <ConfirmDialog
        open={!!deleteUser}
        title="Delete User"
        message={`Are you sure you want to delete "${deleteUser?.name}"? This cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setDeleteUser(null)}
        confirmText="Delete"
      />
    </Box>
  );
}
