import { useState, useEffect } from 'react';
import {
  Box, Typography, Paper, Switch, FormControlLabel, CircularProgress,
} from '@mui/material';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';

export default function Settings() {
  const { data, loading, refetch } = useApi(() => adminApi.getSettings(), []);
  const { showSnackbar } = useSnackbar();
  const [updating, setUpdating] = useState(null);

  const handleToggle = async (key, currentValue) => {
    const newValue = currentValue === 'true' ? 'false' : 'true';
    setUpdating(key);
    try {
      await adminApi.updateSetting(key, { value: newValue });
      showSnackbar(`${key} set to ${newValue}`);
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to update setting', 'error');
    } finally {
      setUpdating(null);
    }
  };

  if (loading || !data) return null;

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 3 }}>Settings</Typography>

      <Paper sx={{ p: 3 }}>
        <FormControlLabel
          control={
            <Switch
              checked={data.shop_enabled === 'true'}
              onChange={() => handleToggle('shop_enabled', data.shop_enabled)}
              disabled={updating === 'shop_enabled'}
            />
          }
          label={
            <Box>
              <Typography variant="body1" fontWeight={600}>Shop</Typography>
              <Typography variant="caption" color="text.secondary">
                Enable or disable the shop for all users. When disabled, users cannot purchase licenses or modules but can still view and redeem bought keys.
              </Typography>
            </Box>
          }
          sx={{ alignItems: 'flex-start', ml: 0 }}
        />
      </Paper>
    </Box>
  );
}
