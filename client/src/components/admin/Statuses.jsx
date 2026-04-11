import { useState } from 'react';
import {
  Box, Typography, Paper, Button, TextField, MenuItem, Alert, Divider,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

const COLOR_OPTIONS = [
  { value: 'info',    label: 'INFO' },
  { value: 'warning', label: 'WARNING' },
  { value: 'error',   label: 'ERROR' },
  { value: 'success', label: 'SUCCESS' },
];

export default function Statuses() {
  const { data: statuses, refetch } = useApi(() => adminApi.getStatuses(), []);
  const { showSnackbar } = useSnackbar();

  const [newMsg, setNewMsg]       = useState('');
  const [newColor, setNewColor]   = useState('info');
  const [newEndsAt, setNewEndsAt] = useState('');

  const activeStatuses   = (statuses || []).filter(s => s.active);
  const archivedStatuses = (statuses || []).filter(s => !s.active);

  const handleCreate = async () => {
    if (!newMsg.trim()) return;
    await adminApi.createStatus({
      message: newMsg.trim(),
      color: newColor,
      ends_at: newEndsAt || null,
    });
    setNewMsg(''); setNewEndsAt('');
    showSnackbar('Status created');
    refetch();
  };

  const handleToggle = async (id, active) => {
    await adminApi.updateStatus(id, { active: !active });
    showSnackbar(active ? 'Status archived' : 'Status reactivated');
    refetch();
  };

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>Global Status Banners</Typography>

      {/* Create */}
      <Paper sx={{ p: 2.5, mb: 4 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Create New
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <TextField size="small" placeholder="Status message..." value={newMsg}
            onChange={(e) => setNewMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            sx={{ flex: 1, minWidth: 200 }} />
          <TextField size="small" select value={newColor} onChange={(e) => setNewColor(e.target.value)} sx={{ width: 130 }}>
            {COLOR_OPTIONS.map(o => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
          <TextField size="small" type="datetime-local" label="Ends at (optional)" InputLabelProps={{ shrink: true }}
            value={newEndsAt} onChange={(e) => setNewEndsAt(e.target.value)} sx={{ width: 220 }} />
          <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate} disabled={!newMsg.trim()}>
            Add
          </Button>
        </Box>
      </Paper>

      {/* Active */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Active ({activeStatuses.length})
      </Typography>
      {activeStatuses.length === 0 ? (
        <Paper sx={{ p: 3, mb: 4, textAlign: 'center' }}>
          <Typography variant="caption" color="text.disabled">No active banners. Users see nothing.</Typography>
        </Paper>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 4 }}>
          {activeStatuses.map((s) => (
            <Alert key={s.id} severity={s.color} sx={{ py: 0.25 }}
              action={<Button size="small" onClick={() => handleToggle(s.id, s.active)}>ARCHIVE</Button>}>
              <Box>
                {s.message}
                {s.ends_at && (
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                    Ends {new Date(s.ends_at).toLocaleString()}
                  </Typography>
                )}
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                  Created {new Date(s.created_at).toLocaleString()}
                </Typography>
              </Box>
            </Alert>
          ))}
        </Box>
      )}

      {/* History */}
      {archivedStatuses.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            History ({archivedStatuses.length})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {archivedStatuses.map((s) => (
              <Alert key={s.id} severity={s.color} sx={{ py: 0.25, opacity: 0.4 }}
                action={<Button size="small" onClick={() => handleToggle(s.id, s.active)}>REACTIVATE</Button>}>
                <Box>
                  {s.message}
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                    Created {new Date(s.created_at).toLocaleString()}
                    {s.ends_at && ` · Ended ${new Date(s.ends_at).toLocaleString()}`}
                  </Typography>
                </Box>
              </Alert>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}
