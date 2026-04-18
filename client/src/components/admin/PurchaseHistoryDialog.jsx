import { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Chip, Box,
} from '@mui/material';
import DataTable from '../common/DataTable.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';

const actionLabels = {
  'shop.purchase':        'Purchase',
  'shop.extend':          'Extend',
  'shop.purchase_module': 'Module',
};

export default function PurchaseHistoryDialog({ open, onClose, user }) {
  const [page, setPage] = useState(1);
  const { data, loading } = useApi(
    () => user ? adminApi.getUserPurchases(user.id, page) : null,
    [user?.id, page],
  );

  const columns = [
    {
      id: 'created_at', label: 'Date',
      render: (row) => (
        <Typography variant="caption" color="text.secondary">
          {new Date(row.created_at).toLocaleString()}
        </Typography>
      ),
    },
    {
      id: 'action', label: 'Type',
      render: (row) => (
        <Chip
          label={actionLabels[row.action] || row.action}
          size="small"
          variant="outlined"
          color={row.action === 'shop.purchase_module' ? 'secondary' : row.action === 'shop.extend' ? 'info' : 'primary'}
        />
      ),
    },
    { id: 'product_name', label: 'Product' },
    {
      id: 'credits_cost', label: 'Credits', align: 'center',
      render: (row) => (
        <Chip label={`-${row.credits_cost}`} size="small" variant="outlined" color="warning" />
      ),
    },
    {
      id: 'subject_id', label: 'Key',
      render: (row) => (
        <Typography variant="caption" fontFamily="monospace" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
          {row.subject_id || '-'}
        </Typography>
      ),
    },
  ];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Purchase History — {user?.name}</DialogTitle>
      <DialogContent>
        <DataTable
          columns={columns}
          rows={data?.data || []}
          loading={loading}
          page={page}
          totalPages={data?.totalPages || 1}
          total={data?.total || 0}
          onPageChange={setPage}
          rowsPerPage={25}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
