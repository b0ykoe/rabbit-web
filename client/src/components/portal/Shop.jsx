import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Paper, Grid, Button, Chip, Divider, MenuItem, TextField, Alert,
} from '@mui/material';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import ExpiryBadge from '../common/ExpiryBadge.jsx';
import { portalApi } from '../../api/endpoints.js';
import { useApi } from '../../hooks/useApi.js';
import { useSnackbar } from '../../context/SnackbarContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

export default function Shop() {
  const [searchParams] = useSearchParams();
  const preSelectedKey = searchParams.get('extend') || '';

  const { data, loading, refetch } = useApi(() => portalApi.getShop(), []);
  const { showSnackbar } = useSnackbar();
  const { refreshUser } = useAuth();

  const [confirmProduct, setConfirmProduct] = useState(null);
  const [selectedKey, setSelectedKey]       = useState(preSelectedKey);
  const [purchasing, setPurchasing]         = useState(false);

  if (loading || !data) return null;

  const { products, credits, licenses } = data;
  const newProducts    = products.filter(p => p.type === 'new_license');
  const extendProducts = products.filter(p => p.type === 'extend_license');

  const handlePurchase = async () => {
    setPurchasing(true);
    try {
      const payload = { product_id: confirmProduct.id };
      if (confirmProduct.type === 'extend_license') {
        if (!selectedKey) {
          showSnackbar('Select a license to extend', 'error');
          return;
        }
        payload.license_key = selectedKey;
      }
      const result = await portalApi.purchase(payload);
      showSnackbar(result.message);
      setConfirmProduct(null);
      await refreshUser();
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Purchase failed', 'error');
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h6" fontWeight={600}>Shop</Typography>
        <Chip
          icon={<AccountBalanceWalletIcon />}
          label={`${credits} Credits`}
          color="primary"
          variant="outlined"
          sx={{ fontWeight: 600 }}
        />
      </Box>

      {/* New Licenses */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Purchase License
      </Typography>
      <Grid container spacing={2} sx={{ mb: 4 }}>
        {newProducts.map((p) => (
          <Grid item xs={12} sm={4} key={p.id}>
            <Paper sx={{ p: 2.5, display: 'flex', flexDirection: 'column', height: '100%' }}>
              <Typography variant="body1" fontWeight={600}>{p.name}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                {p.duration_days ? `${p.duration_days} days` : 'No expiration'} · {p.max_sessions} session{p.max_sessions > 1 ? 's' : ''}
              </Typography>
              <Box sx={{ mt: 'auto', pt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body1" fontWeight={700} color="primary.light">
                  {p.credits_cost} Credits
                </Typography>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<ShoppingCartIcon />}
                  disabled={credits < p.credits_cost}
                  onClick={() => setConfirmProduct(p)}
                >
                  Buy
                </Button>
              </Box>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {/* Extend License */}
      {licenses.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Extend License
          </Typography>

          <Paper sx={{ p: 2, mb: 2 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="Select license to extend"
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value)}
            >
              {licenses.map((lic) => (
                <MenuItem key={lic.license_key} value={lic.license_key}>
                  {lic.license_key} — <ExpiryBadge expiresAt={lic.expires_at} />
                </MenuItem>
              ))}
            </TextField>
          </Paper>

          <Grid container spacing={2} sx={{ mb: 4 }}>
            {extendProducts.map((p) => (
              <Grid item xs={12} sm={4} key={p.id}>
                <Paper sx={{ p: 2.5, display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <Typography variant="body1" fontWeight={600}>{p.name}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                    {p.duration_days ? `+${p.duration_days} days` : 'Set to lifetime'}
                  </Typography>
                  <Box sx={{ mt: 'auto', pt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="body1" fontWeight={700} color="primary.light">
                      {p.credits_cost} Credits
                    </Typography>
                    <Button
                      variant="contained"
                      size="small"
                      startIcon={<ShoppingCartIcon />}
                      disabled={credits < p.credits_cost || !selectedKey}
                      onClick={() => setConfirmProduct(p)}
                    >
                      Buy
                    </Button>
                  </Box>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </>
      )}

      {credits === 0 && (
        <Alert severity="info">
          You have no credits. Contact an admin to get credits added to your account.
        </Alert>
      )}

      <ConfirmDialog
        open={!!confirmProduct}
        title="Confirm Purchase"
        message={confirmProduct ? `Purchase "${confirmProduct.name}" for ${confirmProduct.credits_cost} credits?` : ''}
        onConfirm={handlePurchase}
        onCancel={() => setConfirmProduct(null)}
        confirmText={purchasing ? 'Processing...' : 'Purchase'}
        color="primary"
      />
    </Box>
  );
}
