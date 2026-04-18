import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Paper, Grid, Button, Chip, Alert,
} from '@mui/material';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RedeemIcon from '@mui/icons-material/Redeem';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import ExpiryBadge from '../common/ExpiryBadge.jsx';
import CopyableText from '../common/CopyableText.jsx';
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
  const [redeeming, setRedeeming]          = useState(null);

  if (loading || !data) return null;

  const { shopEnabled, products, credits, featureFlags, licenses, boughtKeys } = data;
  const moduleProducts = products.filter(p => p.type === 'module');
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

  const handleRedeem = async (key) => {
    setRedeeming(key);
    try {
      await portalApi.redeemKey({ key });
      showSnackbar('Key redeemed successfully!');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || 'Failed to redeem key', 'error');
    } finally {
      setRedeeming(null);
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

      {!shopEnabled && (
        <Alert severity="info" sx={{ mb: 3 }}>
          The shop is currently disabled. You can still view and redeem your bought keys below.
        </Alert>
      )}

      {/* ── Modules ── */}
      {shopEnabled && moduleProducts.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Modules
          </Typography>
          <Grid container spacing={2} sx={{ mb: 4 }}>
            {moduleProducts.map((p) => {
              const owned = featureFlags[p.flag_key] === true;
              return (
                <Grid item xs={12} sm={4} key={p.id}>
                  <Paper sx={{ p: 2.5, display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <Typography variant="body1" fontWeight={600}>{p.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                      Feature module
                    </Typography>
                    <Box sx={{ mt: 'auto', pt: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      {owned ? (
                        <Chip icon={<CheckCircleIcon />} label="Owned" color="success" size="small" variant="outlined" />
                      ) : (
                        <>
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
                        </>
                      )}
                    </Box>
                  </Paper>
                </Grid>
              );
            })}
          </Grid>
        </>
      )}

      {/* ── New Licenses ── */}
      {shopEnabled && (
        <>
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
        </>
      )}

      {/* ── Extend License (key list, not dropdown) ── */}
      {shopEnabled && licenses.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Extend License
          </Typography>

          <Paper sx={{ mb: 2 }}>
            {licenses.map((lic) => {
              const isLifetime = lic.expires_at === null;
              const isSelected = !isLifetime && selectedKey === lic.license_key;
              return (
                <Box
                  key={lic.license_key}
                  onClick={isLifetime ? undefined : () => setSelectedKey(isSelected ? '' : lic.license_key)}
                  sx={{
                    p: 1.5,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    cursor: isLifetime ? 'default' : 'pointer',
                    opacity: isLifetime ? 0.5 : 1,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    borderLeft: isSelected ? '3px solid' : '3px solid transparent',
                    borderLeftColor: isSelected ? 'primary.main' : 'transparent',
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                    '&:hover': isLifetime ? {} : { bgcolor: 'action.hover' },
                    '&:last-child': { borderBottom: 'none' },
                  }}
                >
                  {isLifetime
                    ? <CheckBoxOutlineBlankIcon color="disabled" fontSize="small" />
                    : isSelected
                      ? <CheckBoxIcon color="primary" fontSize="small" />
                      : <CheckBoxOutlineBlankIcon color="disabled" fontSize="small" />
                  }
                  <CopyableText text={lic.license_key} />
                  <Box sx={{ ml: 'auto' }}>
                    <ExpiryBadge expiresAt={lic.expires_at} />
                  </Box>
                </Box>
              );
            })}
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

      {/* ── Bought Keys ── */}
      {boughtKeys.length > 0 && (
        <>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Bought Keys
          </Typography>
          <Paper sx={{ mb: 4 }}>
            {boughtKeys.map((k) => (
              <Box
                key={k.license_key}
                sx={{
                  p: 2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  flexWrap: 'wrap',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                  '&:last-child': { borderBottom: 'none' },
                }}
              >
                <CopyableText text={k.license_key} />
                {k.duration_days && !k.expires_at ? (
                  <Typography variant="caption" color="warning.main">
                    {k.duration_days}d banked — starts on redeem
                  </Typography>
                ) : (
                  <ExpiryBadge expiresAt={k.expires_at} />
                )}
                {k.note && (
                  <Typography variant="caption" color="text.disabled">{k.note}</Typography>
                )}
                <Box sx={{ ml: 'auto' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<RedeemIcon />}
                    disabled={redeeming === k.license_key}
                    onClick={() => handleRedeem(k.license_key)}
                  >
                    {redeeming === k.license_key ? 'Redeeming...' : 'Redeem'}
                  </Button>
                </Box>
              </Box>
            ))}
          </Paper>
        </>
      )}

      {shopEnabled && credits === 0 && (
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
