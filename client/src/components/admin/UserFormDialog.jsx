import { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  TextField, Button, MenuItem, Alert, FormControl, InputLabel,
  Select, OutlinedInput, Checkbox, ListItemText, Chip, Box,
  FormControlLabel, Switch, Typography,
} from '@mui/material';

const CHANNELS = ['release', 'beta', 'alpha'];

// Feature flag definitions — add new ones here and they appear in the UI automatically
const FEATURE_FLAG_GROUPS = [
  { label: 'User Features', flags: [
    { key: 'training',   label: 'Training' },
    { key: 'skills',     label: 'Skills' },
    { key: 'monsters',   label: 'Monsters' },
    { key: 'statistics', label: 'Statistics' },
    { key: 'combo',      label: 'Combo' },
    { key: 'hwid_spoof', label: 'HWID Spoof' },
  ]},
  { label: 'Developer', flags: [
    { key: 'dev',            label: 'Dev (Master)' },
    { key: 'dev_movement',   label: 'Movement' },
    { key: 'dev_entities',   label: 'Entities' },
    { key: 'dev_drops',      label: 'Drops' },
    { key: 'dev_skills',     label: 'Skills (Dev)' },
    { key: 'dev_advanced',   label: 'Advanced' },
    { key: 'dev_blacklist',  label: 'Blacklist' },
    { key: 'dev_obstacles',  label: 'Obstacles' },
    { key: 'dev_npc',        label: 'NPC' },
    { key: 'dev_combo',      label: 'Combo (Dev)' },
  ]},
];

const DEFAULT_FLAGS = Object.fromEntries(
  FEATURE_FLAG_GROUPS.flatMap(g => g.flags).map(f => [f.key, f.key.startsWith('dev') ? false : true])
);

export default function UserFormDialog({ open, onClose, onSubmit, user = null }) {
  const isEdit = !!user;
  const [form, setForm]   = useState({ name: '', email: '', password: '', role: 'user', allowed_channels: ['release'], status: '', hwid_reset_enabled: true, feature_flags: { ...DEFAULT_FLAGS } });
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
        feature_flags: { ...DEFAULT_FLAGS, ...(user.feature_flags || {}) },
      });
    } else {
      setForm({ name: '', email: '', password: '', role: 'user', allowed_channels: ['release'], status: '', hwid_reset_enabled: true, feature_flags: { ...DEFAULT_FLAGS } });
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

          {/* Feature Flags */}
          {FEATURE_FLAG_GROUPS.map((group) => (
            <Box key={group.label}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {group.label}
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0, ml: -1 }}>
                {group.flags.map((flag) => {
                  const disabled = flag.key.startsWith('dev_') && flag.key !== 'dev' && !form.feature_flags?.dev;
                  return (
                    <FormControlLabel
                      key={flag.key}
                      sx={{ minWidth: 130 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={!!form.feature_flags?.[flag.key]}
                          disabled={disabled}
                          onChange={(e) => {
                            const updated = { ...form.feature_flags, [flag.key]: e.target.checked };
                            // If dev master toggled off, disable all dev sub-flags
                            if (flag.key === 'dev' && !e.target.checked) {
                              for (const f of group.flags) {
                                if (f.key.startsWith('dev_')) updated[f.key] = false;
                              }
                            }
                            setForm({ ...form, feature_flags: updated });
                          }}
                        />
                      }
                      label={<Typography variant="body2">{flag.label}</Typography>}
                    />
                  );
                })}
              </Box>
            </Box>
          ))}
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
