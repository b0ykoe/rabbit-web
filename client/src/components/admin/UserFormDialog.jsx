import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Button, MenuItem, Alert,
} from '@mui/material';

export default function UserFormDialog({ open, onClose, onSubmit, user = null }) {
  const isEdit = !!user;
  const [form, setForm]   = useState({ name: '', email: '', password: '', role: 'user' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setForm({ name: user.name, email: user.email, password: '', role: user.role });
    } else {
      setForm({ name: '', email: '', password: '', role: 'user' });
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
