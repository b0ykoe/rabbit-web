import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, Alert, Paper, Chip, Tooltip, IconButton,
  Table, TableHead, TableRow, TableCell, TableBody, Link,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/VpnKey';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { adminApi } from '../../../api/endpoints.js';
import { useApi } from '../../../hooks/useApi.js';
import { useAuth } from '../../../context/AuthContext.jsx';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';

// Monster-map ingest-token administration (PLAN_v2 §3.9). Super-admin only:
// mint an authoritative scope:'ingest' token a Debug bot can paste to push
// spawns to the ingest route, list issued tokens, and per-token revoke.
export default function IngestTokensPage() {
  const { user } = useAuth();
  const { showSnackbar } = useSnackbar();
  const isSuperAdmin = user?.role === 'super_admin';

  const { data, loading, refetch } = useApi(() => adminApi.getIngestTokens(), []);
  const [durationHours, setDurationHours] = useState('6');   // seeding window, default 6h (max 72)
  const [minting, setMinting]       = useState(false);
  const [minted, setMinted]         = useState(null);   // { token, jti, expires_at, duration_hours }
  const [error, setError]           = useState('');

  const handleMint = async () => {
    setError('');
    setMinted(null);
    setMinting(true);
    try {
      // Seeding window: clamp to [1, 72]h, default 6h if left blank/invalid.
      const h = Math.min(72, Math.max(1, Math.floor(Number(durationHours)) || 6));
      const res = await adminApi.mintIngestToken({ self: true, duration_hours: h });
      setMinted(res);
      showSnackbar('Ingest token minted');
      refetch();
    } catch (err) {
      setError(err.data?.error || err.message || 'Mint failed');
    } finally {
      setMinting(false);
    }
  };

  const handleRevoke = async (jti) => {
    try {
      await adminApi.revokeIngestToken(jti);
      showSnackbar('Token revoked');
      refetch();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Revoke failed', 'error');
    }
  };

  const copy = (text) => {
    navigator.clipboard?.writeText(text);
    showSnackbar('Copied to clipboard');
  };

  const fmtTime = (sec) => sec ? new Date(sec * 1000).toLocaleString() : '—';
  const rows = data?.data || [];
  const now = Math.floor(Date.now() / 1000);

  return (
    <Box>
      {/* Back link + title */}
      <Link
        component={RouterLink}
        to="/admin/world"
        underline="hover"
        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, mb: 1, fontSize: '0.8125rem' }}
      >
        <ArrowBackIcon fontSize="small" /> Back to servers
      </Link>

      {!isSuperAdmin ? (
        <Alert severity="warning">Ingest-token administration is super-admin only.</Alert>
      ) : (
        <>
          <Typography variant="h5" fontWeight={700} sx={{ mb: 3 }}>Servers — Ingest Tokens</Typography>

          {/* Mint */}
          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Issue ingest token</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Creates a time-limited recording key bound to you — hand it to a user. The seeding window
              defaults to <strong>6&nbsp;hours</strong> (max 72&nbsp;h). Paste it into a Debug bot's Scan
              tab to enable spawn upload. Scope-limited, expiring, per-token revocable.
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <TextField
                label="Window (hours)" size="small" type="number" value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
                inputProps={{ min: 1, max: 72 }}
                helperText="default 6, max 72"
                sx={{ minWidth: 130 }}
              />
              <Button variant="contained" startIcon={<KeyIcon />} onClick={handleMint} disabled={minting}>
                {minting ? 'Minting…' : 'Create key'}
              </Button>
            </Box>

            {minted && (
              <Alert severity="success" sx={{ mt: 2 }}>
                <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
                  jti <code>{minted.jti}</code> · expires {fmtTime(minted.expires_at)}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    value={minted.token} size="small" fullWidth
                    InputProps={{ readOnly: true, sx: { fontFamily: 'monospace', fontSize: '0.7rem' } }}
                  />
                  <Tooltip title="Copy token">
                    <IconButton size="small" onClick={() => copy(minted.token)}><ContentCopyIcon fontSize="small" /></IconButton>
                  </Tooltip>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  Copy now — the token is not retrievable later, only revocable.
                </Typography>
              </Alert>
            )}
          </Paper>

          {/* Issued list */}
          <Paper variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>jti</TableCell>
                  <TableCell>User</TableCell>
                  <TableCell>License</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right"></TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading && <TableRow><TableCell colSpan={7}>Loading…</TableCell></TableRow>}
                {!loading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={7}><Typography variant="caption" color="text.disabled">No ingest tokens issued.</Typography></TableCell></TableRow>
                )}
                {rows.map((r) => {
                  const expired = r.expires_at <= now;
                  const state = r.revoked ? 'revoked' : expired ? 'expired' : 'active';
                  const color = state === 'active' ? 'success' : state === 'revoked' ? 'error' : 'default';
                  return (
                    <TableRow key={r.jti}>
                      <TableCell><Typography variant="caption" fontFamily="monospace">{r.jti.slice(0, 12)}…</Typography></TableCell>
                      <TableCell>{r.user_name || r.user_email || (r.user_id != null ? `#${r.user_id}` : '—')}</TableCell>
                      <TableCell><Typography variant="caption" fontFamily="monospace">{r.license_key || '—'}</Typography></TableCell>
                      <TableCell><Chip label={state} size="small" color={color} variant="outlined" /></TableCell>
                      <TableCell>{fmtTime(r.expires_at)}</TableCell>
                      <TableCell>{fmtTime(r.created_at)}</TableCell>
                      <TableCell align="right">
                        {!r.revoked && !expired && (
                          <Button size="small" color="error" onClick={() => handleRevoke(r.jti)}>Revoke</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Paper>
        </>
      )}
    </Box>
  );
}
