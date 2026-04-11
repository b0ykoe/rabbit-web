import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Button, MenuItem, Alert, FormControl, InputLabel,
  Select, OutlinedInput, Checkbox, ListItemText, Chip, Box,
  FormControlLabel, Switch,
} from '@mui/material';

const CHANNELS = ['release', 'beta', 'alpha'];

export default function UserFormDialog({ open, onClose, onSubmit, user = null }) {
  const isEdit = !!user;
  const [form, setForm]   = useState({ name: '', email: '', password: '', role: 'user', allowed_channels: ['release'], status: '', hwid_reset_enabled: true });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name,
        email: user.email,
        password: '',
        role: user.role,
        allowed_channels: user.allowed_channels || ['release'],
        status: user.status || '',
        hwid_reset_enabled: user.hwid_reset_enabled ?? true,
      });
    } else {
      setForm({ name: '', email: '', password: '', role: 'user', allowed_channels: ['release'], status: '', hwid_reset_enabled: true });
    }
    setError('');
  }, [user, open]);

  const handleChange = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = { ...form };
      if (isEdit && !data.password) delete data.password;
      await onSubmit(data);
      onClose();
    } catch (err) {
      const errors = err.data?.errors;
      setError(errors ? Object.values(errors).flat().join('. ') : (err.message || 'Failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>{isEdit ? 'Edit User' : 'Create User'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Name" required size="small" value={form.name} onChange={handleChange('name')} />
          <TextField label="Email" type="email" required size="small" value={form.email} onChange={handleChange('email')} />
          <TextField
            label={isEdit ? 'Password (leave blank to keep)' : 'Password'}
            type="password"
            required={!isEdit}
            size="small"
            value={form.password}
            onChange={handleChange('password')}
          />
          <TextField label="Role" select size="small" value={form.role} onChange={handleChange('role')}>
            <MenuItem value="admin">Admin</MenuItem>
            <MenuItem value="user">User</MenuItem>
          </TextField>
          <FormControl size="small">
            <InputLabel>Version Channels</InputLabel>
            <Select
              multiple
              value={form.allowed_channels}
              onChange={(e) => setForm({ ...form, allowed_channels: e.target.value })}
              input={<OutlinedInput label="Version Channels" />}
              renderValue={(selected) => (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {selected.map(ch => <Chip key={ch} label={ch} size="small" />)}
                </Box>
              )}
            >
              {CHANNELS.map((ch) => (
                <MenuItem key={ch} value={ch}>
                  <Checkbox checked={form.allowed_channels.includes(ch)} size="small" />
                  <ListItemText primary={ch} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Status (optional)"
            size="small"
            placeholder="e.g. VIP, Beta Tester, Banned..."
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.hwid_reset_enabled}
                onChange={(e) => setForm({ ...form, hwid_reset_enabled: e.target.checked })}
                size="small"
              />
            }
            label="Allow HWID Reset"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={loading}>
            {loading ? 'Saving...' : (isEdit ? 'Update' : 'Create')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
