import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Stack, Typography, Breadcrumbs, Link, IconButton, Tooltip, Alert,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Link as RouterLink } from 'react-router-dom';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import OffsetKeyCatalogPanel from './OffsetKeyCatalogPanel.jsx';
import TemplatesSection from './TemplatesSection.jsx';

// Portal-wide "Offset signing" page (super_admin). The signing key + the field
// catalog are SHARED across every server (one key signs them all), so they live
// here at the Servers level rather than inside a per-server Offsets tab. Each
// server's own fingerprint + overrides + Sign button stay on its Offsets tab.
export default function OffsetSigningPage() {
  const navigate = useNavigate();
  const { showSnackbar } = useSnackbar();
  const [keyState, setKeyState] = useState(null);   // { exists, public_key_hex } | null
  const [tplNonce, setTplNonce] = useState(0);      // bump to reload the templates list

  const reloadKey = useCallback(async () => {
    try { setKeyState(await adminApi.getOffsetKey()); }
    catch (err) { showSnackbar(err?.data?.error || err?.message || 'Failed to load signing key', 'error'); }
  }, [showSnackbar]);

  useEffect(() => { reloadKey(); }, [reloadKey]);

  return (
    <Box>
      {/* Header: back + breadcrumbs */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Tooltip title="Back to servers">
          <IconButton size="small" onClick={() => navigate('/admin/world')}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Breadcrumbs aria-label="breadcrumb">
          <Link component={RouterLink} to="/admin/world" underline="hover" color="inherit">
            Servers
          </Link>
          <Typography color="text.primary">Offset signing</Typography>
        </Breadcrumbs>
      </Box>

      <Box sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>Offset signing</Typography>
        <Typography variant="caption" color="text.secondary">
          The signing key and field catalog are shared across every server. Set them
          up once here, then sign each server's overrides on its own Offsets tab.
        </Typography>
      </Box>

      <Alert severity="info" sx={{ mb: 2 }}>
        Generate the signing key <strong>once</strong> (keep the password safe — it
        cannot be recovered), then paste the public key into the bot's
        <code> OFFSET_ED25519_PUBLIC_KEY_HEX</code> and rebuild. Import the field
        catalog exported from the bot's Dev &gt; Exporter tab.
      </Alert>

      <Stack spacing={2.5}>
        <OffsetKeyCatalogPanel
          keyState={keyState}
          onKeyChanged={reloadKey}
          onCatalogChanged={(result) => {
            // The import upserts a build template (+ maybe derives a server's
            // overrides). Reload the list + surface what happened.
            setTplNonce((n) => n + 1);
            if (result?.applied_server_id) {
              showSnackbar(
                `Imported ${result.count} fields → template "${result.template_name}", ` +
                `plus ${result.override_count} override(s) auto-set on server #${result.applied_server_id}.`,
              );
            } else {
              showSnackbar(`Imported ${result?.count ?? 0} fields → template "${result?.template_name ?? 'Stock EP4'}".`);
            }
          }}
        />
        <TemplatesSection reloadNonce={tplNonce} />
      </Stack>
    </Box>
  );
}
