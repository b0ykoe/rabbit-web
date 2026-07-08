import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box, Stack, Paper, Typography, TextField, MenuItem, Button, Chip, Alert, Skeleton, Tooltip, Link,
} from '@mui/material';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import OffsetFieldTable, { parseIntFlexible, hasInvalidOverride } from './OffsetFieldTable.jsx';
import SignOffsetsDialog from './SignOffsetsDialog.jsx';
import BuildsSection from './BuildsSection.jsx';

// ── Format helpers ────────────────────────────────────────────────────────────

// Fixed-width fingerprint hex (0x%08X). Null → em dash.
function toHex(n) {
  return n == null ? '—' : '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Relative "time ago" from epoch seconds — matches the sibling tabs' clock copy.
function fmtRelative(sec) {
  if (!sec) return 'never';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

// A titled outlined-Paper section (mirrors ServerSettingsTab's SettingsCard).
function Section({ title, caption, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {caption}
        </Typography>
      )}
      <Box sx={{ mt: caption ? 0 : 1.5 }}>{children}</Box>
    </Paper>
  );
}

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// The per-server Offsets tab (Phase F). Orchestrates the signed offset-override
// system for one server:
//   (a) portal-wide signing key + field catalog (OffsetKeyCatalogPanel)
//   (b) the engine fingerprint (TimeDateStamp / SizeOfImage)
//   (c) the base-vs-override field editor (OffsetFieldTable)
//   (d) Save overrides + Sign… actions with a signed/stale status chip
// Props: { server, refetch, ... } — mounted with the shared tab props bundle.
export default function ServerOffsetsTab({ server }) {
  const { showSnackbar } = useSnackbar();
  const serverId = server?.id;

  const [keyState, setKeyState] = useState(null);   // { exists, public_key_hex } | null
  const [data, setData]         = useState(null);   // getServerOffsets payload | null
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [notFound, setNotFound] = useState(false);

  // Fingerprint working copy (raw strings; hex or decimal accepted).
  const [stampStr, setStampStr] = useState('');
  const [sizeStr, setSizeStr]   = useState('');

  // Override working copy: field_name -> rawString ('' = no override).
  const [overrides, setOverrides] = useState({});

  // Which build template this server forks (its Base column comes from it).
  const [templateId, setTemplateId] = useState(null);

  // Tracks whether the working copy diverges from the last-loaded server state.
  const [dirty, setDirty] = useState(false);

  const [saving, setSaving]       = useState(false);
  const [signOpen, setSignOpen]   = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Seed the working copies from a freshly-loaded payload.
  const seedFrom = useCallback((payload) => {
    const stamp = payload?.fingerprint?.stamp ?? null;
    const size  = payload?.fingerprint?.size ?? null;
    setStampStr(stamp == null ? '' : toHex(stamp));
    setSizeStr(size == null ? '' : toHex(size));
    const map = {};
    for (const o of (payload?.overrides || [])) {
      map[o.field_name] = '0x' + (Number(o.value) >>> 0).toString(16);
    }
    setOverrides(map);
    setTemplateId(payload?.template_id ?? null);
    setDirty(false);
  }, []);

  // Load the portal-wide key + this server's offsets together.
  const loadOffsets = useCallback(async () => {
    if (!serverId) return;
    const res = await adminApi.getServerOffsets(serverId);
    setData(res);
    seedFrom(res);
    setNotFound(false);
  }, [serverId, seedFrom]);

  const load = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const [keyRes, offRes] = await Promise.all([
        adminApi.getOffsetKey().catch(() => null), // key is best-effort
        adminApi.getServerOffsets(serverId).catch((err) => {
          if (err?.status === 404) return { __notFound: true };
          throw err;
        }),
      ]);
      setKeyState(keyRes);
      if (offRes?.__notFound) {
        setNotFound(true);
        setData(null);
      } else {
        setData(offRes);
        seedFrom(offRes);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [serverId, seedFrom]);

  useEffect(() => { load(); }, [load]);

  // ── Field-table change → mark dirty ────────────────────────────────────────
  const onFieldChange = useCallback((fieldName, raw) => {
    setOverrides((prev) => ({ ...prev, [fieldName]: raw }));
    setDirty(true);
  }, []);

  const onStampChange = (v) => { setStampStr(v); setDirty(true); };
  const onSizeChange  = (v) => { setSizeStr(v);  setDirty(true); };

  // ── Validation ─────────────────────────────────────────────────────────────
  const stampParsed = parseIntFlexible(stampStr);
  const sizeParsed  = parseIntFlexible(sizeStr);
  const fpInvalid   = !stampParsed.ok || !sizeParsed.ok;
  const overridesInvalid = hasInvalidOverride(overrides);
  const anyInvalid  = fpInvalid || overridesInvalid;

  const catalog   = data?.catalog || [];
  const effective = data?.effective || [];

  // ── Save: PUT fingerprint + the non-empty, valid overrides ─────────────────
  const handleSave = async () => {
    if (anyInvalid || saving) return;
    // Build the override array from the working copy (skip empty = "removed").
    const outOverrides = [];
    for (const [field_name, raw] of Object.entries(overrides)) {
      if (raw === '' || raw == null) continue;
      const p = parseIntFlexible(raw);
      if (!p.ok || p.value == null) continue; // guarded by anyInvalid, belt-and-braces
      outOverrides.push({ field_name, value: p.value });
    }
    const body = { overrides: outOverrides, offset_template_id: templateId ?? null };
    if (stampParsed.value != null) body.stamp = stampParsed.value;
    if (sizeParsed.value != null)  body.size  = sizeParsed.value;

    setSaving(true);
    try {
      const res = await adminApi.putServerOffsets(serverId, body);
      showSnackbar(`Overrides saved — ${res?.count ?? outOverrides.length} field(s). The signed blob is now invalidated; re-sign to apply.`);
      await loadOffsets(); // refetch + re-seed (dirty cleared)
    } catch (err) {
      // A rejected unknown field_name comes back with err.data.fields.
      const fields = err?.data?.fields;
      const suffix = Array.isArray(fields) && fields.length ? ` (${fields.join(', ')})` : '';
      showSnackbar(errMsg(err, 'Save failed') + suffix, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Download dev .json ─────────────────────────────────────────────────────
  // Fetch the UNSIGNED effective profile and trigger a browser download of an
  // offset_overrides.json a dev machine can drop into %APPDATA%/<DATA_DIR_NAME>/
  // to bootstrap the Debug bot (no signing needed for the local apply-file path).
  const handleDownloadDevFile = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const data = await adminApi.getServerOffsetDevFile(serverId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'offset_overrides.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showSnackbar('Downloaded offset_overrides.json');
    } catch (err) {
      showSnackbar(errMsg(err, 'Download failed'), 'error');
    } finally {
      setDownloading(false);
    }
  };

  // ── Signed status ──────────────────────────────────────────────────────────
  // signed:false OR any unsaved edit ⇒ "needs signing".
  const signed = !!data?.signed && !dirty;
  const signedAt = data?.signed_at ?? null;

  const signedChip = useMemo(() => {
    if (signed) {
      return (
        <Chip
          size="small" color="success" variant="filled"
          label={`Signed ${fmtRelative(signedAt)}`}
          sx={{ height: 24 }}
        />
      );
    }
    const label = dirty
      ? 'Unsaved edits — needs signing'
      : (data?.signed ? 'Stale — needs signing' : 'Not signed');
    return <Chip size="small" color="default" variant="outlined" label={label} sx={{ height: 24 }} />;
  }, [signed, signedAt, dirty, data]);

  // Sign is only meaningful once edits are saved (the blob must match what's stored).
  const signDisabled = dirty || anyInvalid;

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Stack spacing={2.5}>
        <Skeleton variant="rectangular" height={160} sx={{ borderRadius: 1 }} />
        <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 1 }} />
        <Skeleton variant="rectangular" height={320} sx={{ borderRadius: 1 }} />
      </Stack>
    );
  }

  if (error) {
    return (
      <Alert severity="error">
        {errMsg(error, 'Failed to load offset overrides for this server.')}
      </Alert>
    );
  }

  return (
    <Stack spacing={2.5}>
      {/* The signing key + field catalog are portal-wide and live on the Offset
          signing page. Surface a hint here only when the key is missing, since
          Sign would 409 without it. */}
      {keyState && !keyState.exists && (
        <Alert severity="warning">
          No signing key yet — generate one on the{' '}
          <Link component={RouterLink} to="/admin/world/offsets">Offset signing</Link>{' '}
          page (and import the field catalog there) before you can sign this server's overrides.
        </Alert>
      )}

      {notFound ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            No offset set for this server yet
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Import the field catalog on the Offset signing page, then set the engine
            fingerprint and any per-field overrides. Nothing is stored until you Save.
          </Typography>
        </Paper>
      ) : (
        <>
          {/* (a2) Base template — the server forks this; its values fill the Base
              column. Overrides are this server's deltas on top. */}
          <Section
            title="Base template"
            caption="This server forks a build template (its base offset values). Your overrides below are the deltas on top. Templates are created by importing on the Offset signing page."
          >
            <TextField
              select
              label="Base template"
              size="small"
              value={templateId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setTemplateId(v === '' ? null : Number(v));
                setDirty(true);
              }}
              sx={{ minWidth: 260 }}
              helperText={(data?.templates || []).length ? undefined : 'No templates yet — import one on the Offset signing page.'}
            >
              <MenuItem value=""><em>None (compiled fallback)</em></MenuItem>
              {(data?.templates || []).map((t) => (
                <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
              ))}
            </TextField>
          </Section>

          {/* (b) Engine fingerprint. */}
          <Section
            title="Engine fingerprint"
            caption="The signed blob only applies to a bot whose Engine.dll matches this fingerprint. Export it from the bot's Dev > Exporter tab."
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="TimeDateStamp"
                size="small"
                value={stampStr}
                error={!stampParsed.ok}
                placeholder="0x00000000"
                onChange={(e) => onStampChange(e.target.value)}
                helperText={
                  !stampParsed.ok
                    ? 'Enter hex (0x…) or a decimal integer'
                    : `Current: ${toHex(data?.fingerprint?.stamp ?? null)}`
                }
                inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
                sx={{ minWidth: 220 }}
              />
              <TextField
                label="SizeOfImage"
                size="small"
                value={sizeStr}
                error={!sizeParsed.ok}
                placeholder="0x00000000"
                onChange={(e) => onSizeChange(e.target.value)}
                helperText={
                  !sizeParsed.ok
                    ? 'Enter hex (0x…) or a decimal integer'
                    : `Current: ${toHex(data?.fingerprint?.size ?? null)}`
                }
                inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
                sx={{ minWidth: 220 }}
              />
            </Stack>
          </Section>

          {/* (c) Base-vs-override field editor. */}
          <Section title="Offset overrides">
            <OffsetFieldTable
              catalog={catalog}
              effective={effective}
              value={overrides}
              onChange={onFieldChange}
            />
          </Section>

          {/* (d) Actions row + signed status. */}
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', rowGap: 1.5 }}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                {signedChip}
                {dirty && (
                  <Typography variant="caption" color="text.secondary">
                    Save your edits before signing.
                  </Typography>
                )}
              </Stack>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Button
                  variant="text"
                  onClick={handleDownloadDevFile}
                  disabled={downloading}
                >
                  {downloading ? 'Downloading…' : 'Download dev .json'}
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleSave}
                  disabled={!dirty || anyInvalid || saving}
                >
                  {saving ? 'Saving…' : 'Save overrides'}
                </Button>
                <Tooltip title={signDisabled ? 'Save your edits first' : ''}>
                  <span>
                    <Button
                      variant="contained"
                      onClick={() => setSignOpen(true)}
                      disabled={signDisabled}
                    >
                      Sign…
                    </Button>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
            {anyInvalid && (
              <Alert severity="warning" sx={{ mt: 2, py: 0.5 }}>
                Fix the highlighted {fpInvalid ? 'fingerprint' : 'override'} value(s) before saving.
              </Alert>
            )}
          </Paper>

          {/* (e) Per-build (per-patch) overrides. The overrides above are the server's
              GENERAL layer; per-build overrides are the deltas that shift per game patch
              (one build = one Engine.dll stamp). effective = per-build > general > template. */}
          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, mt: 0.5 }}>
            The overrides above apply to <strong>every</strong> build of this server. Per-build
            overrides below are the deltas that shift per game patch — each build (Engine.dll stamp)
            gets its own signed blob.
          </Typography>
          <BuildsSection serverId={serverId} serverName={server?.name} />
        </>
      )}

      {/* Sign dialog. */}
      <SignOffsetsDialog
        open={signOpen}
        onClose={() => setSignOpen(false)}
        serverId={serverId}
        serverName={server?.name}
        onSigned={() => { loadOffsets(); }}
      />
    </Stack>
  );
}
