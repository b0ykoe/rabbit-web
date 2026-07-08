import { useState, useEffect, useCallback } from 'react';
import {
  Box, Stack, Paper, Typography, Button, Chip, IconButton, Tooltip, Skeleton, Alert, Link,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, TextField,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import LayersIcon from '@mui/icons-material/Layers';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import TemplateEditorDialog from './TemplateEditorDialog.jsx';

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Portal-wide build-template list (Phase 1). Templates are the per-edition BASE
// value-sets (Stock EP4, Stock EP2, …) that servers fork. Most are created by
// importing a bot offset catalog (see OffsetKeyCatalogPanel); this section lists
// them with their field/server counts and allows creating an empty one + deleting.
// Reloads when `reloadNonce` changes (an import elsewhere just made/updated one).
export default function TemplatesSection({ reloadNonce }) {
  const { showSnackbar } = useSnackbar();
  const [rows, setRows]       = useState(null);   // null = loading
  const [error, setError]     = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName]       = useState('');
  const [saving, setSaving]   = useState(false);
  const [delTarget, setDelTarget] = useState(null);   // row pending delete
  const [deleting, setDeleting]   = useState(false);
  const [editTarget, setEditTarget] = useState(null); // row open in the editor

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await adminApi.getOffsetTemplates()); }
    catch (err) { setError(err); setRows([]); }
  }, []);

  useEffect(() => { load(); }, [load, reloadNonce]);

  const handleCreate = async () => {
    const nm = name.trim();
    if (!nm || saving) return;
    setSaving(true);
    try {
      await adminApi.createOffsetTemplate({ name: nm });
      showSnackbar('Template created');
      setCreateOpen(false);
      setName('');
      load();
    } catch (err) {
      showSnackbar(errMsg(err, 'Create failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!delTarget) return;
    setDeleting(true);
    try {
      await adminApi.deleteOffsetTemplate(delTarget.id);
      showSnackbar(`Template "${delTarget.name}" deleted`);
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
        <LayersIcon fontSize="small" color="action" />
        <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>
          Build templates
        </Typography>
        <Button size="small" variant="outlined" startIcon={<AddIcon fontSize="small" />} onClick={() => setCreateOpen(true)}>
          New template
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        Per-edition base value-sets (Stock EP4, Stock EP2, …). Servers fork one and override
        individual fields. Importing a bot catalog creates/updates a template automatically.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{errMsg(error, 'Failed to load templates.')}</Alert>}

      {rows == null ? (
        <Skeleton variant="rectangular" height={120} sx={{ borderRadius: 1 }} />
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No templates yet — import a bot offset catalog below, or create an empty one.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell align="right">Fields</TableCell>
                <TableCell align="right">Servers</TableCell>
                <TableCell>Notes</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id} hover>
                  <TableCell sx={{ fontWeight: 600 }}>
                    <Link
                      component="button"
                      type="button"
                      underline="hover"
                      color="inherit"
                      onClick={() => setEditTarget(t)}
                      sx={{ fontWeight: 600, textAlign: 'left' }}
                    >
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell align="right">
                    <Chip size="small" variant="outlined" label={t.field_count} sx={{ height: 20 }} />
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      variant="outlined"
                      color={t.servers_using ? 'primary' : 'default'}
                      label={t.servers_using}
                      sx={{ height: 20 }}
                    />
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: '0.8rem' }}>{t.notes || '—'}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit values">
                      <IconButton size="small" onClick={() => setEditTarget(t)}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t.servers_using ? 'In use — deleting unlinks those servers' : 'Delete template'}>
                      <IconButton size="small" onClick={() => setDelTarget(t)}>
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

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => !saving && setCreateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New template</DialogTitle>
        <DialogContent sx={{ pt: '8px !important' }}>
          <DialogContentText sx={{ fontSize: '0.8rem', mb: 2 }}>
            Creates an empty template. Usually you'd instead <strong>import</strong> a bot
            catalog below, which fills a template's base values for you.
          </DialogContentText>
          <TextField
            label="Name" size="small" fullWidth autoFocus value={name}
            disabled={saving} inputProps={{ maxLength: 64 }}
            placeholder="e.g. Stock EP2"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) handleCreate(); }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!delTarget} onClose={() => !deleting && setDelTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete template?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Delete <strong>{delTarget?.name}</strong>? Its base values are removed and the{' '}
            <strong>{delTarget?.servers_using || 0}</strong> server(s) forking it fall back to the
            compiled base until re-pointed (they'll need re-signing).
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDelTarget(null)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Per-template value editor */}
      <TemplateEditorDialog
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        templateId={editTarget?.id}
        templateName={editTarget?.name}
        onSaved={load}
      />
    </Paper>
  );
}
