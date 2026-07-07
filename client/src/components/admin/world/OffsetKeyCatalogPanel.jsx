import { useState, useEffect } from 'react';
import {
  Box, Stack, Paper, Typography, Button, Chip, TextField, Tooltip, IconButton,
  Divider, Alert,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import KeyIcon from '@mui/icons-material/VpnKey';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import UploadDropZone from './UploadDropZone.jsx';

// Truncate a long hex public key for compact mono display (head…tail).
function truncMid(hex, head = 10, tail = 8) {
  if (!hex) return '';
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

// Portal-wide signing key + field catalog management. NOT per-server: the single
// Ed25519 signing key authenticates every server's offset blob, and the field
// catalog is the shared Stock-EP4 base list. Props:
//   keyState        — { exists, public_key_hex } | null (parent-loaded)
//   onKeyChanged    — reload key state after a successful generate
//   onCatalogChanged— reload the server offsets (so the table shows the new catalog)
export default function OffsetKeyCatalogPanel({ keyState, onKeyChanged, onCatalogChanged }) {
  const { showSnackbar } = useSnackbar();

  // ── Generate-key dialog ─────────────────────────────────────────────────────
  const [genOpen, setGenOpen]   = useState(false);
  const [pw, setPw]             = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  // ── Catalog import ──────────────────────────────────────────────────────────
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (genOpen) { setPw(''); setPwConfirm(''); setGenerating(false); setGenError(''); }
  }, [genOpen]);

  const hasKey = !!keyState?.exists;
  const pubKey = keyState?.public_key_hex || '';

  const copyKey = () => {
    if (!pubKey) return;
    navigator.clipboard?.writeText(pubKey);
    showSnackbar('Public key copied');
  };

  // ── Generate the one-time signing key ──────────────────────────────────────
  const pwValid = pw.length >= 8 && pw === pwConfirm;
  const handleGenerate = async () => {
    if (!pwValid || generating) return;
    setGenError('');
    setGenerating(true);
    try {
      await adminApi.generateOffsetKey(pw);
      showSnackbar('Signing key generated');
      setGenOpen(false);
      onKeyChanged?.();
    } catch (err) {
      // 409 = a key already exists (rotation is out of scope).
      setGenError(err?.data?.error || err?.message || 'Key generation failed');
    } finally {
      setGenerating(false);
    }
  };

  // ── Import the bot-exported field catalog ──────────────────────────────────
  const onCatalogFiles = async (fileList) => {
    const file = fileList?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const res = await adminApi.importOffsetCatalog(file);
      showSnackbar(`Imported ${res?.count ?? 0} fields`);
      onCatalogChanged?.();
    } catch (err) {
      showSnackbar(err?.data?.error || err?.message || 'Catalog import failed', 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <KeyIcon fontSize="small" color="action" />
        <Typography variant="subtitle1" fontWeight={700}>
          Signing key &amp; field catalog (portal-wide)
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Shared across every server — the key signs each server's blob and the catalog is
        the Stock EP4 base list.
      </Typography>

      {/* ── Signing key ── */}
      <Box sx={{ mb: 2 }}>
        {hasKey ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" color="success" variant="filled" label="Key present" sx={{ height: 22 }} />
            <Tooltip title={pubKey || ''}>
              <Box component="span" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                {truncMid(pubKey)}
              </Box>
            </Tooltip>
            {pubKey && (
              <Tooltip title="Copy public key">
                <IconButton size="small" onClick={copyKey}><ContentCopyIcon fontSize="small" /></IconButton>
              </Tooltip>
            )}
          </Stack>
        ) : (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Chip size="small" color="default" variant="outlined" label="No signing key yet" sx={{ height: 22 }} />
            <Button size="small" variant="outlined" startIcon={<KeyIcon />} onClick={() => setGenOpen(true)}>
              Generate signing key
            </Button>
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
          {hasKey
            ? 'Generating is one-time — the key cannot be regenerated here.'
            : 'Generating is one-time; keep the password safe — it cannot be recovered.'}
        </Typography>
      </Box>

      <Divider sx={{ my: 2 }} />

      {/* ── Field catalog import ── */}
      <Box>
        <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 0.5 }}>
          Import field catalog (JSON)
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          Export <strong>offsets_catalog.json</strong> from the bot's Dev &gt; Exporter tab,
          then import it here.
        </Typography>
        <UploadDropZone
          accept=".json"
          busy={importing}
          onFiles={onCatalogFiles}
          label="Drop offsets_catalog.json, or click to browse"
          hint="Replaces the shared Stock-EP4 base field list"
        />
      </Box>

      {/* ── Generate-key password dialog ── */}
      <Dialog open={genOpen} onClose={() => !generating && setGenOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Generate signing key</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <DialogContentText sx={{ fontSize: '0.8rem' }}>
            Mints a one-time Ed25519 signing key wrapped with this password. You'll need it
            every time you sign; it is <strong>never stored</strong> and cannot be recovered.
          </DialogContentText>

          {genError && <Alert severity="error">{genError}</Alert>}

          <TextField
            label="Password" type="password" size="small" fullWidth autoFocus
            value={pw} disabled={generating}
            onChange={(e) => setPw(e.target.value)}
            error={pw.length > 0 && pw.length < 8}
            helperText={pw.length > 0 && pw.length < 8 ? 'At least 8 characters' : ' '}
          />
          <TextField
            label="Confirm password" type="password" size="small" fullWidth
            value={pwConfirm} disabled={generating}
            onChange={(e) => setPwConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && pwValid) handleGenerate(); }}
            error={pwConfirm.length > 0 && pwConfirm !== pw}
            helperText={pwConfirm.length > 0 && pwConfirm !== pw ? 'Passwords do not match' : ' '}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGenOpen(false)} disabled={generating}>Cancel</Button>
          <Button variant="contained" startIcon={<KeyIcon />} onClick={handleGenerate} disabled={!pwValid || generating}>
            {generating ? 'Generating…' : 'Generate'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
