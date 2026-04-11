import { useState } from 'react';
import {
  Box, Typography, TextField, MenuItem, Paper, Collapse, IconButton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DataTable from '../common/DataTable.jsx';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';

const ACTION_COLORS = {
  user:    'info',
  license: 'warning',
  release: 'success',
};

function ActionChip({ action }) {
  const prefix = action.split('.')[0];
  const color = ACTION_COLORS[prefix] || 'default';
  return (
    <Typography
      variant="caption"
      sx={{
        px: 1, py: 0.25, borderRadius: 1,
        bgcolor: `${color}.main`,
        color: 'white',
        fontWeight: 500,
        fontSize: '0.6875rem',
      }}
    >
      {action}
    </Typography>
  );
}

function JsonDetails({ data: jsonData }) {
  const [open, setOpen] = useState(false);
  if (!jsonData) return null;
  return (
    <Box>
      <IconButton size="small" onClick={() => setOpen(!open)}>
        {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
      </IconButton>
      <Collapse in={open}>
        <Typography
          variant="caption"
          component="pre"
          sx={{ fontFamily: 'monospace', fontSize: '0.6875rem', color: 'text.secondary', mt: 0.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        >
          {JSON.stringify(jsonData, null, 2)}
        </Typography>
      </Collapse>
    </Box>
  );
}

export default function AuditLog() {
  const [page, setPage]     = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');

  const params = { page, ...(search && { search }), ...(action && { action }) };
  const { data, loading } = useApi(() => adminApi.getAuditLog(params), [page, search, action]);

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>Audit Log</Typography>

      {/* Filters */}
      <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
        <TextField
          size="small"
          placeholder="Search action, user, subject..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          sx={{ flex: 1, maxWidth: 400 }}
        />
        <TextField
          size="small"
          select
          label="Action"
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All</MenuItem>
          {(data?.actionPrefixes || []).map((p) => (
            <MenuItem key={p} value={p}>{p}</MenuItem>
          ))}
        </TextField>
      </Box>

      <DataTable
        columns={[
          {
            id: 'created_at', label: 'Time',
            render: (row) => <Typography variant="caption" color="text.secondary">{new Date(row.created_at).toLocaleString()}</Typography>,
          },
          { id: 'action', label: 'Action', render: (row) => <ActionChip action={row.action} /> },
          { id: 'user_name', label: 'Actor', render: (row) => row.user_name || <Typography variant="caption" color="text.disabled">system</Typography> },
          { id: 'subject', label: 'Subject', render: (row) => (
            <Typography variant="caption" color="text.secondary">
              {row.subject_type ? `${row.subject_type}:${row.subject_id}` : '—'}
            </Typography>
          )},
          { id: 'details', label: 'Details', render: (row) => (
            <Box sx={{ display: 'flex', gap: 1 }}>
              {row.old_values && <JsonDetails data={row.old_values} />}
              {row.new_values && <JsonDetails data={row.new_values} />}
            </Box>
          )},
          { id: 'ip', label: 'IP', render: (row) => <Typography variant="caption" fontFamily="monospace" color="text.disabled">{row.ip_address}</Typography> },
        ]}
        rows={data?.data || []}
        loading={loading}
        page={page}
        totalPages={data?.totalPages || 1}
        total={data?.total || 0}
        onPageChange={setPage}
        rowsPerPage={50}
      />
    </Box>
  );
}
