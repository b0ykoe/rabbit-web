import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Paper, Typography, TextField, Button, Alert } from '@mui/material';
import LockResetIcon from '@mui/icons-material/LockReset';
import { authApi } from '../../api/endpoints.js';
import { useAuth } from '../../context/AuthContext.jsx';

export default function ChangePassword() {
  const navigate = useNavigate();
  const { user, refreshUser, logout } = useAuth();
  const [password, setPassword]     = useState('');
  const [confirm, setConfirm]       = useState('');
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await authApi.changePassword({ password, password_confirmation: confirm });
      await refreshUser();
      navigate(user?.role === 'admin' ? '/admin' : '/portal', { replace: true });
    } catch (err) {
      const errors = err.data?.errors;
      if (errors) {
        setError(Object.values(errors).flat().join('. '));
      } else {
        setError(err.data?.error || 'Failed to change password');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', bgcolor: 'background.default' }}>
      <Paper sx={{ p: 4, width: 380, maxWidth: '90vw' }}>
        <Box sx={{ textAlign: 'center', mb: 3 }}>
          <LockResetIcon sx={{ fontSize: 40, color: 'warning.main', mb: 1 }} />
          <Typography variant="h6" fontWeight={600}>Set Your Password</Typography>
          <Typography variant="caption" color="text.secondary">
            You're using the default password. Choose a new one to continue.
          </Typography>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <form onSubmit={handleSubmit}>
          <TextField
            label="New Password"
            type="password"
            fullWidth
            required
            autoFocus
            size="small"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            helperText="Min 10 chars, uppercase, number, special character"
            sx={{ mb: 2 }}
          />
          <TextField
            label="Confirm Password"
            type="password"
            fullWidth
            required
            size="small"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            sx={{ mb: 3 }}
          />
          <Button type="submit" variant="contained" fullWidth disabled={loading}>
            {loading ? 'Setting...' : 'Set Password & Continue'}
          </Button>
        </form>

        <Box sx={{ textAlign: 'center', mt: 2 }}>
          <Button size="small" sx={{ color: 'text.disabled' }} onClick={handleLogout}>
            Log out
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
