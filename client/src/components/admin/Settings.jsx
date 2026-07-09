import { useState, useEffect } from 'react';
import {
  Box, Typography, Paper, Switch, FormControlLabel, CircularProgress,
  Chip, Divider,
} from '@mui/material';
import { adminApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

export default function Settings() {
  const { data, loading, refetch } = useApi(() => adminApi.getSettings(), []);
  const { showSnackbar } = useSnackbar();
  const { user: me } = useAuth();
  const isSuperAdmin = me?.role === 'super_admin';
  const [updating, setUpdating] = useState(null);

  // Feature-flag catalog (042). Each flag has a GLOBAL kill-switch:
  // effective bot value = enabled_globally && (super_admin || per-user flag).
  const {
    data: flagData, loading: flagsLoading, refetch: refetchFlags,
  } = useApi(() => adminApi.getFeatureFlagCatalog(), []);
  const [flagUpdating, setFlagUpdating] = useState(null);

  const handleFlagToggle = async (flag) => {
    setFlagUpdating(flag.flag_key);
    try {
      await adminApi.updateFeatureFlag(flag.flag_key, {
        enabled_globally: !flag.enabled_globally,
      });
      showSnackbar(`${flag.label} ${flag.enabled_globally ? 'disabled' : 'enabled'} globally`);
      refetchFlags();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to update flag', 'error');
    } finally {
      setFlagUpdating(null);
    }
  };

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

      {/* Feature-flag kill-switches (catalog 042) */}
      <Typography variant="h6" fontWeight={600} sx={{ mt: 4, mb: 1 }}>
        Feature Flags
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Global kill-switch per flag. A disabled flag is OFF for every user —
        including super-admins — regardless of per-user grants. Per-user
        grants are edited in the user editor and are preserved while a flag
        is globally off.
      </Typography>
      <Paper sx={{ p: 3 }}>
        {flagsLoading || !flagData ? (
          <CircularProgress size={24} />
        ) : (
          (() => {
            const groups = new Map();
            for (const f of flagData.flags || []) {
              if (!groups.has(f.group_label)) groups.set(f.group_label, []);
              groups.get(f.group_label).push(f);
            }
            return [...groups.entries()].map(([label, flags], gi) => (
              <Box key={label}>
                {gi > 0 && <Divider sx={{ my: 2 }} />}
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {label}
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0, mt: 0.5 }}>
                  {flags.map((flag) => (
                    <FormControlLabel
                      key={flag.flag_key}
                      sx={{ minWidth: 220, ml: 0 }}
                      control={
                        <Switch
                          size="small"
                          checked={flag.enabled_globally}
                          onChange={() => handleFlagToggle(flag)}
                          disabled={!isSuperAdmin || flagUpdating === flag.flag_key}
                        />
                      }
                      label={
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Typography variant="body2">{flag.label}</Typography>
                          {flag.is_shop && <Chip label="shop" size="small" variant="outlined" />}
                        </Box>
                      }
                    />
                  ))}
                </Box>
              </Box>
            ));
          })()
        )}
        {!isSuperAdmin && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
            Only super-admins can change global flags.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
