import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Box, Stack, Paper, Typography, Button, Chip, IconButton, Tooltip, Skeleton, Alert,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, TextField,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LockIcon from '@mui/icons-material/Lock';
import MemoryIcon from '@mui/icons-material/Memory';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import ContentPasteGoIcon from '@mui/icons-material/ContentPasteGo';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import OffsetFieldTable, { parseIntFlexible, hasInvalidOverride, fieldHex } from './OffsetFieldTable.jsx';

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Collect a working-copy override map ({ field_name -> rawString }) into the numeric
// { field_name -> int } shape the export / copy / save paths all use: empty and
// unparseable entries are dropped (identical to what handleSave writes).
function collectFields(overrides) {
  const fields = {};
  for (const [name, raw] of Object.entries(overrides || {})) {
    if (raw === '' || raw == null) continue;
    const p = parseIntFlexible(raw);
    if (!p.ok || p.value == null) continue;
    fields[name] = p.value;
  }
  return fields;
}

// Parse a pasted C++-style "field = value;" block into overrides. Each line may carry
// a trailing ';' and an inline '// comment' (both stripped); blank and full-comment
// lines are ignored. RHS accepts hex (0x…) or decimal. Returns:
//   values  — { field_name -> int } for keys present in the catalog (`knownNames`)
//   unknown — keys that parsed but aren't in the catalog (reported, not applied)
//   bad     — source lines that looked like an assignment but didn't parse
function parseQuickOverrides(text, knownNames) {
  const values = {};
  const unknown = [];
  const bad = [];
  const known = knownNames instanceof Set ? knownNames : new Set(knownNames || []);
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const c = line.indexOf('//');
    if (c >= 0) line = line.slice(0, c).trim();          // strip inline comment
    if (line.endsWith(';')) line = line.slice(0, -1).trim(); // strip trailing ';'
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) { bad.push(rawLine.trim()); continue; }
    const key = line.slice(0, eq).trim();
    const p = parseIntFlexible(line.slice(eq + 1).trim());
    if (!key || !p.ok || p.value == null) { bad.push(rawLine.trim()); continue; }
    if (!known.has(key)) { unknown.push(key); continue; }
    values[key] = p.value;
  }
  return { values, unknown, bad };
}

// Fixed-width stamp hex (0x%08X). Null → em dash. Mirrors ServerOffsetsTab.toHex.
function toHex(n) {
  return n == null ? '—' : '0x' + (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// Relative "time ago" from epoch seconds — matches ServerOffsetsTab.fmtRelative.
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

// ── Quick paste ───────────────────────────────────────────────────────────────
// Paste a C++ "field = 0x…;" block (straight from engine_variant_*.cpp / an IDA
// note) and apply the recognised fields as overrides in one shot. Parsing is live
// so the admin sees the apply/skip counts before committing. Only fields present in
// `knownNames` (this server's offset catalog) are applied.
// Props: { open, onClose, knownNames:Set, onApply(valuesMap) }
function QuickPasteDialog({ open, onClose, knownNames, onApply }) {
  const [text, setText] = useState('');

  useEffect(() => { if (open) setText(''); }, [open]);

  const result = useMemo(() => parseQuickOverrides(text, knownNames), [text, knownNames]);
  const applyCount = Object.keys(result.values).length;
  const touched = text.trim() !== '';

  const handleApply = () => {
    if (!applyCount) return;
    onApply(result.values);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Quick paste overrides</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem', mb: 1.5 }}>
          Paste lines like <code>off_entity_container = 0x1A58;</code> — one field per line.
          A trailing <code>;</code> and <code>// comments</code> are ignored; values accept{' '}
          <code>0x…</code> or decimal. Only fields in this server's offset catalog are applied.
        </DialogContentText>
        <TextField
          multiline
          minRows={8}
          maxRows={20}
          fullWidth
          autoFocus
          value={text}
          placeholder={'off_entity_container  = 0x1A58;\noff_my_slot_item      = 0x1B30;\noff_my_character_info = 0x3CF80; // IDA note'}
          onChange={(e) => setText(e.target.value)}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.78rem' }, spellCheck: false }}
        />
        {touched && (
          <Stack spacing={0.25} sx={{ mt: 1.5 }}>
            <Typography variant="caption" color={applyCount ? 'success.main' : 'text.secondary'}>
              {applyCount} field(s) will be applied.
            </Typography>
            {result.unknown.length > 0 && (
              <Typography variant="caption" color="warning.main">
                Not in catalog — skipped: {[...new Set(result.unknown)].join(', ')}
              </Typography>
            )}
            {result.bad.length > 0 && (
              <Typography variant="caption" color="error.main">
                Couldn't parse {result.bad.length} line(s) — check they read <code>name = value</code>.
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<ContentPasteGoIcon />}
          onClick={handleApply}
          disabled={!applyCount}
        >
          {applyCount ? `Apply ${applyCount}` : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Per-build value editor ────────────────────────────────────────────────────
// Opens ONE build's per-build overrides. The Base column is the build's INHERITED
// effective (per the getServerBuildOffsets effective[] — general override ?? template
// base), the Override column is the per-build delta. Reuses OffsetFieldTable, whose
// "Effective" column then resolves per-build override ?? inherited-base. Save REPLACES
// the per-build overrides; a field left empty drops that per-build delta.
// Props: { open, onClose, serverId, build, onSaved, onCopyToNew }
function BuildOffsetsDialog({ open, onClose, serverId, build, onSaved, onCopyToNew }) {
  const { showSnackbar } = useSnackbar();
  const buildId = build?.id;

  const [data, setData]       = useState(null);   // getServerBuildOffsets payload | null
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [overrides, setOverrides] = useState({}); // field_name -> rawString
  const [dirty, setDirty]     = useState(false);
  const [saving, setSaving]   = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  // The set of numeric catalog field names paste/import validate against.
  const knownNames = useMemo(
    () => new Set((data?.catalog || []).map((c) => c.field_name)),
    [data],
  );

  // Seed the working copy from a freshly-loaded payload.
  const seedFrom = useCallback((payload) => {
    const map = {};
    for (const o of (payload?.overrides || [])) {
      map[o.field_name] = '0x' + (Number(o.value) >>> 0).toString(16);
    }
    setOverrides(map);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (serverId == null || buildId == null) return;
    setLoading(true);
    setError(null);
    // Clear any stale working copy so a failed load can't leave Save enabled over
    // the previous build's values.
    setDirty(false);
    setOverrides({});
    try {
      const res = await adminApi.getServerBuildOffsets(serverId, buildId);
      setData(res);
      seedFrom(res);
    } catch (err) {
      setError(err);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [serverId, buildId, seedFrom]);

  useEffect(() => { if (open) load(); }, [open, load]);
  // Don't leave the paste sub-dialog open across a close/reopen of the editor.
  useEffect(() => { if (!open) setPasteOpen(false); }, [open]);

  const onFieldChange = useCallback((fieldName, raw) => {
    setOverrides((prev) => ({ ...prev, [fieldName]: raw }));
    setDirty(true);
  }, []);

  const invalid = hasInvalidOverride(overrides);
  // How many per-build deltas a "Copy to new build" would carry (drops empty + invalid).
  const fieldCount = useMemo(() => Object.keys(collectFields(overrides)).length, [overrides]);

  // Merge a paste result into the working copy (normalised to lowercase 0x hex, so it
  // reads like every other row) and mark dirty.
  const applyQuickOverrides = useCallback((values) => {
    const n = Object.keys(values).length;
    if (!n) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(values)) next[k] = '0x' + (Number(v) >>> 0).toString(16);
      return next;
    });
    setDirty(true);
    showSnackbar(`Applied ${n} override(s) from paste — review, then Save.`);
  }, [showSnackbar]);

  // Trigger a browser download of `text` as `name` (application/json).
  const downloadJson = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Download this build's EFFECTIVE profile as an offset_overrides.json a dev drops
  // into %APPDATA%/<DATA_DIR_NAME>/ to bootstrap a Debug bot on this Engine.dll. The
  // server merges the general effective set with the WORKING per-build overrides sent
  // here (unsaved edits included), so it's WYSIWYG and can't mis-handle VAs the way a
  // client-side reconstruction would (compiled-Stock fallbacks stay excluded).
  const handleExportDevFile = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const dev = await adminApi.getServerBuildDevFile(serverId, buildId, collectFields(overrides));
      downloadJson('offset_overrides.json', JSON.stringify(dev, null, 2));
      showSnackbar(`Exported offset_overrides.json — ${Object.keys(dev?.fields || {}).length} effective field(s).`);
    } catch (err) {
      showSnackbar(errMsg(err, 'Export failed'), 'error');
    } finally {
      setExporting(false);
    }
  };

  // Download JUST this build's per-build deltas as the bot's build_overrides.json
  // shape ({ kind:"rabbit-build-overrides", builds:[…] }) — round-trips through the
  // "Import overrides" button and matches the Dev > Exporter format. Client-side only
  // (the deltas are the working copy); empty + invalid entries are dropped.
  const handleExportOverrides = () => {
    const fields = collectFields(overrides);
    const stamp = data?.stamp ?? build?.stamp ?? null;
    const outBuild = { stamp, size: data?.size ?? build?.size ?? null, fields };
    const lbl = (data?.label ?? build?.label) || '';
    if (lbl) outBuild.label = lbl;
    const out = { kind: 'rabbit-build-overrides', builds: [outBuild] };
    const name = `build_overrides_${toHex(stamp)}.json`;
    downloadJson(name, JSON.stringify(out, null, 2));
    showSnackbar(`Exported ${Object.keys(fields).length} override(s) — ${name}`);
  };

  // Hand the current values up to the parent, which opens the Add-build flow seeded
  // with them (new Engine.dll stamp, same deltas — tweak the few that moved).
  const handleCopyToNew = () => {
    onCopyToNew?.(collectFields(overrides));
  };

  // The Base column = this build's inherited effective (general ?? template base).
  // OffsetFieldTable reads base from effective[].base_value first, then catalog.
  const catalog   = data?.catalog || [];
  const effective = data?.effective || [];

  const handleSave = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    try {
      const out = [];
      for (const [field_name, raw] of Object.entries(overrides)) {
        if (raw === '' || raw == null) continue;
        const p = parseIntFlexible(raw);
        if (!p.ok || p.value == null) continue; // guarded by `invalid`, belt-and-braces
        out.push({ field_name, value: p.value });
      }
      const res = await adminApi.putServerBuildOffsets(serverId, buildId, { overrides: out });
      showSnackbar(`Per-build overrides saved — ${res?.count ?? out.length} field(s). The build's signed blob is now invalidated; re-sign to apply.`);
      onSaved?.();
      onClose();
    } catch (err) {
      // A rejected unknown field_name comes back with err.data.fields.
      const fields = err?.data?.fields;
      const suffix = Array.isArray(fields) && fields.length ? ` (${fields.join(', ')})` : '';
      showSnackbar(errMsg(err, 'Save failed') + suffix, 'error');
    } finally {
      setSaving(false);
    }
  };

  const label = build?.label ? `${build.label} · ${toHex(build?.stamp)}` : toHex(build?.stamp);

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="md" fullWidth>
      <DialogTitle>Per-build overrides — {label}</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        {loading ? (
          <Stack spacing={2}>
            <Skeleton variant="rectangular" height={40} sx={{ borderRadius: 1 }} />
            <Skeleton variant="rectangular" height={320} sx={{ borderRadius: 1 }} />
          </Stack>
        ) : error ? (
          <Alert severity="error">{errMsg(error, 'Failed to load build offsets.')}</Alert>
        ) : (
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Base = this build's <strong>inherited effective</strong> (server general override, else
              template base). Set an override to shift a field for this Engine.dll only — these are the
              deltas that move per game patch. Saving REPLACES the per-build overrides; a field left
              empty drops its per-build delta.
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentPasteIcon fontSize="small" />}
                onClick={() => setPasteOpen(true)}
              >
                Quick paste
              </Button>
              <Tooltip title={invalid ? 'Fix invalid values first' : (fieldCount ? '' : 'Set at least one override first')}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ContentCopyIcon fontSize="small" />}
                    onClick={handleCopyToNew}
                    disabled={invalid || fieldCount === 0}
                  >
                    Copy to new build…
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={invalid ? 'Fix invalid values first' : 'offset_overrides.json — this build\'s full effective set; drop into %APPDATA% for a Debug bot'}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<FileDownloadOutlinedIcon fontSize="small" />}
                    onClick={handleExportDevFile}
                    disabled={invalid || exporting}
                  >
                    {exporting ? 'Exporting…' : 'Export dev .json'}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={invalid ? 'Fix invalid values first' : (fieldCount ? 'build_overrides.json — just this build\'s per-build deltas; round-trips through Import overrides' : 'Set at least one override first')}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<FileDownloadOutlinedIcon fontSize="small" />}
                    onClick={handleExportOverrides}
                    disabled={invalid || fieldCount === 0}
                  >
                    Export overrides
                  </Button>
                </span>
              </Tooltip>
            </Stack>
            <OffsetFieldTable
              catalog={catalog}
              effective={effective}
              value={overrides}
              onChange={onFieldChange}
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!dirty || invalid || saving || loading || !!error || !data}
        >
          {saving ? 'Saving…' : 'Save overrides'}
        </Button>
      </DialogActions>

      <QuickPasteDialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        knownNames={knownNames}
        onApply={applyQuickOverrides}
      />
    </Dialog>
  );
}

// ── Add-build dialog ──────────────────────────────────────────────────────────
// Creates a build row from an Engine.dll stamp + size (hex-or-decimal) + optional
// label. Both stamp and size are required and parsed via parseIntFlexible.
function AddBuildDialog({ open, onClose, serverId, onCreated, seedOverrides }) {
  const { showSnackbar } = useSnackbar();
  const [stampStr, setStampStr] = useState('');
  const [sizeStr, setSizeStr]   = useState('');
  const [label, setLabel]       = useState('');
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    if (open) { setStampStr(''); setSizeStr(''); setLabel(''); setSaving(false); }
  }, [open]);

  // Copy mode: this build is created pre-filled with another build's override values
  // (a new Engine.dll stamp, same deltas). seedCount is frozen for the dialog's life.
  const seedCount = useMemo(() => Object.keys(seedOverrides || {}).length, [seedOverrides]);
  const copyMode = seedCount > 0;

  const stampParsed = parseIntFlexible(stampStr);
  const sizeParsed  = parseIntFlexible(sizeStr);
  const canCreate = stampParsed.ok && stampParsed.value != null
    && sizeParsed.ok && sizeParsed.value != null;

  const handleCreate = async () => {
    if (!canCreate || saving) return;
    setSaving(true);
    try {
      const body = { stamp: stampParsed.value, size: sizeParsed.value };
      const nm = label.trim();
      if (nm) body.label = nm;
      const created = await adminApi.createServerBuild(serverId, body);
      // Copy the seeded overrides onto the freshly-created build (REPLACE-ALL, same as
      // the per-build Save). Field names come from an existing build so they're already
      // catalog-valid.
      if (copyMode && created?.id != null) {
        const outOverrides = Object.entries(seedOverrides).map(([field_name, value]) => ({ field_name, value }));
        await adminApi.putServerBuildOffsets(serverId, created.id, { overrides: outOverrides });
      }
      showSnackbar(copyMode ? `Build added with ${seedCount} copied override(s) — re-sign to apply.` : 'Build added');
      onCreated?.(created, copyMode);
      onClose();
    } catch (err) {
      showSnackbar(errMsg(err, 'Create failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !saving && onClose()} maxWidth="xs" fullWidth>
      <DialogTitle>{copyMode ? 'Copy to new build' : 'Add build'}</DialogTitle>
      <DialogContent sx={{ pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem', mb: 2 }}>
          One build = one Engine.dll (a game patch). Enter its PE fingerprint — export it
          from the bot's <strong>Dev &gt; Exporter</strong> tab. Values accept <code>0x…</code> or decimal.
          {copyMode && (
            <> <strong>{seedCount} override(s)</strong> will be copied into the new build — edit the few
            that moved after it opens.</>
          )}
        </DialogContentText>
        <Stack spacing={2}>
          <TextField
            label="TimeDateStamp"
            size="small"
            fullWidth
            autoFocus
            value={stampStr}
            disabled={saving}
            error={stampStr !== '' && !stampParsed.ok}
            placeholder="0x00000000"
            helperText={stampStr !== '' && !stampParsed.ok ? 'Enter hex (0x…) or a decimal integer' : undefined}
            onChange={(e) => setStampStr(e.target.value)}
            inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
          />
          <TextField
            label="SizeOfImage"
            size="small"
            fullWidth
            value={sizeStr}
            disabled={saving}
            error={sizeStr !== '' && !sizeParsed.ok}
            placeholder="0x00000000"
            helperText={sizeStr !== '' && !sizeParsed.ok ? 'Enter hex (0x…) or a decimal integer' : undefined}
            onChange={(e) => setSizeStr(e.target.value)}
            inputProps={{ style: { fontFamily: 'monospace' }, spellCheck: false }}
          />
          <TextField
            label="Label (optional)"
            size="small"
            fullWidth
            value={label}
            disabled={saving}
            inputProps={{ maxLength: 64 }}
            placeholder="e.g. 2026-07 patch"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={!canCreate || saving}>
          {saving ? (copyMode ? 'Copying…' : 'Adding…') : (copyMode ? 'Create & copy' : 'Add build')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Sign dialog (single build OR re-sign all) ─────────────────────────────────
// Password-gates signServerBuild / signAllServerBuilds. Stays open on failure so
// the admin can retry (mirrors SignOffsetsDialog's inline error mapping). When
// `build` is null the dialog signs ALL of the server's builds.
function SignBuildDialog({ open, onClose, serverId, build, onSigned }) {
  const { showSnackbar } = useSnackbar();
  const [password, setPassword] = useState('');
  const [signing, setSigning]   = useState(false);
  const [error, setError]       = useState('');

  useEffect(() => {
    if (open) { setPassword(''); setSigning(false); setError(''); }
  }, [open]);

  const all = !build;

  const mapError = (err) => {
    const status = err?.status;
    if (status === 403) return 'Wrong signing password.';
    if (status === 409) return err?.data?.error || 'Generate a signing key first.';
    if (status === 400) return err?.data?.error || 'Set the build fingerprint first.';
    return err?.data?.error || err?.message || 'Signing failed.';
  };

  const handleSign = async () => {
    if (!password || signing) return;
    setError('');
    setSigning(true);
    try {
      if (all) {
        const res = await adminApi.signAllServerBuilds(serverId, password);
        showSnackbar(`Signed ${res?.signed ?? 0} build(s)`);
      } else {
        await adminApi.signServerBuild(serverId, build.id, password);
        showSnackbar('Build signed');
      }
      onSigned?.();
      onClose();
    } catch (err) {
      setError(mapError(err)); // stay open so the admin can retry
    } finally {
      setSigning(false);
    }
  };

  const label = build?.label ? `${build.label} · ${toHex(build?.stamp)}` : toHex(build?.stamp);

  return (
    <Dialog open={open} onClose={() => !signing && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{all ? 'Re-sign all builds' : 'Sign build'}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          {all
            ? <>Re-signs <strong>every</strong> build of this server with its own merged effective set. You'll need this password each time you sign; it is <strong>never stored</strong>.</>
            : <>Signs the merged effective set for build <strong>{label}</strong>. You'll need this password every time you sign; it is <strong>never stored</strong>.</>}
        </DialogContentText>

        {error && <Alert severity="error">{error}</Alert>}

        <TextField
          label="Signing password"
          type="password"
          size="small"
          fullWidth
          autoFocus
          value={password}
          disabled={signing}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && password && !signing) handleSign(); }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={signing}>Cancel</Button>
        <Button
          variant="contained"
          startIcon={<LockIcon />}
          onClick={handleSign}
          disabled={!password || signing}
        >
          {signing ? 'Signing…' : (all ? 'Re-sign all' : 'Sign')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// The per-server Builds section (P4 — the PER-PATCH tier). Lists one server's builds
// (one row per Engine.dll stamp) with per-build override counts + signed status, and
// lets an admin add builds, edit each build's per-build overrides (the deltas that
// shift per game patch), sign one build, re-sign all, and delete. Each build carries
// its OWN signed blob keyed to its stamp so a bot fetches the blob matching its dll.
// Props: { serverId, serverName }.
export default function BuildsSection({ serverId, serverName }) {
  const { showSnackbar } = useSnackbar();
  const [rows, setRows]   = useState(null);   // null = loading
  const [error, setError] = useState(null);

  const [addOpen, setAddOpen]       = useState(false);
  const [copySeed, setCopySeed]     = useState(null);   // { overrides } → Add-build in copy mode
  const [editTarget, setEditTarget] = useState(null);   // build open in the value editor
  const [signTarget, setSignTarget] = useState(null);   // { build } | { all:true } for sign dialog
  const [delTarget, setDelTarget]   = useState(null);   // build pending delete
  const [deleting, setDeleting]     = useState(false);
  const [importing, setImporting]   = useState(false);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    if (serverId == null) return;
    setError(null);
    try { setRows(await adminApi.getServerBuilds(serverId)); }
    catch (err) { setError(err); setRows([]); }
  }, [serverId]);

  useEffect(() => { load(); }, [load]);

  // Bulk-import the bot's build_overrides.json (Dev > Exporter). Upserts one build
  // per stamp + REPLACE-ALLs each build's overrides; the server responds with the
  // written counts. A 400 with err.data.fields means the offset catalog must be
  // imported first (unknown field names). Re-picking the same file is allowed
  // (value reset) so a fresh export re-imports without a page reload.
  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const res = await adminApi.importServerBuildOverrides(serverId, file);
      showSnackbar(
        `Imported ${res?.builds_written ?? 0} build(s), ${res?.overrides_written ?? 0} override(s). `
        + 'Each touched build\'s signed blob is invalidated — re-sign to apply.',
      );
      load();
    } catch (err) {
      const fields = err?.data?.fields;
      const suffix = Array.isArray(fields) && fields.length ? ` (${fields.join(', ')})` : '';
      showSnackbar(errMsg(err, 'Import failed') + suffix, 'error');
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await adminApi.deleteServerBuild(serverId, delTarget.id);
      showSnackbar(`Build ${toHex(delTarget.stamp)} deleted`);
      setDelTarget(null);
      load();
    } catch (err) {
      showSnackbar(errMsg(err, 'Delete failed'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <MemoryIcon fontSize="small" color="action" />
        <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
          Per-build overrides
        </Typography>
        <Tooltip title={rows && rows.length ? '' : 'Add a build first'}>
          <span>
            <Button
              size="small"
              variant="text"
              startIcon={<LockIcon fontSize="small" />}
              onClick={() => setSignTarget({ all: true })}
              disabled={!rows || rows.length === 0}
            >
              Re-sign all builds
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Import the bot's build_overrides.json (Dev > Exporter) — creates one build per Engine.dll stamp and fills its per-build overrides. Import the offset catalog first.">
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadFileIcon fontSize="small" />}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? 'Importing…' : 'Import overrides'}
            </Button>
          </span>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={handleImportFile}
        />
        <Button size="small" variant="outlined" startIcon={<AddIcon fontSize="small" />} onClick={() => setAddOpen(true)}>
          Add build
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        One build = one Engine.dll (a game patch). Its overrides are the per-patch deltas that
        layer ABOVE the server's general overrides (effective = per-build &gt; general &gt; template).
        Each build carries its OWN signed blob keyed to its stamp, so a bot fetches the blob
        matching its Engine.dll.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errMsg(error, 'Failed to load builds.')}</Alert>}

      {rows == null ? (
        <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 1 }} />
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No builds yet — add one per Engine.dll stamp you want to ship offsets for.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Stamp</TableCell>
                <TableCell>Label</TableCell>
                <TableCell align="right">SizeOfImage</TableCell>
                <TableCell align="right">Overrides</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600 }}>
                    {toHex(b.stamp)}
                  </TableCell>
                  <TableCell sx={{ color: b.label ? 'text.primary' : 'text.secondary', fontSize: '0.8rem' }}>
                    {b.label || '—'}
                  </TableCell>
                  <TableCell align="right" sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
                    {fieldHex(b.size)}
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      variant="outlined"
                      color={b.override_count ? 'primary' : 'default'}
                      label={b.override_count}
                      sx={{ height: 20 }}
                    />
                  </TableCell>
                  <TableCell>
                    {b.signed ? (
                      b.stale ? (
                        <Tooltip title="The signed blob no longer matches this build's current effective set (overrides/label/template changed) — re-sign to apply.">
                          <Chip
                            size="small" color="warning" variant="filled"
                            label="Out of date — re-sign"
                            sx={{ height: 22 }}
                          />
                        </Tooltip>
                      ) : (
                        <Chip
                          size="small" color="success" variant="filled"
                          label={`Signed ${fmtRelative(b.signed_at)}`}
                          sx={{ height: 22 }}
                        />
                      )
                    ) : (
                      <Chip size="small" color="default" variant="outlined" label="Not signed" sx={{ height: 22 }} />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit values">
                      <IconButton size="small" onClick={() => setEditTarget(b)}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Sign build">
                      <IconButton size="small" onClick={() => setSignTarget({ build: b })}>
                        <LockIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete build">
                      <IconButton size="small" onClick={() => setDelTarget(b)}>
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add build — plain, or seeded from another build ("Copy to new build") */}
      <AddBuildDialog
        open={addOpen || !!copySeed}
        onClose={() => { setAddOpen(false); setCopySeed(null); }}
        serverId={serverId}
        seedOverrides={copySeed?.overrides || null}
        onCreated={(created, wasCopy) => {
          setAddOpen(false);
          setCopySeed(null);
          load();
          // After a copy, jump straight into the new build's editor so the admin can
          // change the few offsets that moved between patches.
          if (wasCopy && created?.id != null) setEditTarget(created);
        }}
      />

      {/* Per-build value editor */}
      <BuildOffsetsDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        serverId={serverId}
        build={editTarget}
        onSaved={load}
        onCopyToNew={(overrides) => { setEditTarget(null); setCopySeed({ overrides }); }}
      />

      {/* Sign one build OR re-sign all */}
      <SignBuildDialog
        open={!!signTarget}
        onClose={() => setSignTarget(null)}
        serverId={serverId}
        build={signTarget?.build ?? null}
        onSigned={load}
      />

      {/* Delete confirm */}
      <Dialog open={!!delTarget} onClose={() => !deleting && setDelTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete build?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete build <strong>{toHex(delTarget?.stamp)}</strong>
            {delTarget?.label ? <> (<strong>{delTarget.label}</strong>)</> : null}? Its per-build
            overrides and signed blob are removed. Bots on this Engine.dll fall back to the
            server-level blob until you re-add + re-sign.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDelTarget(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
