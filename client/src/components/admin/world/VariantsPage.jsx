import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, Alert, Paper, Chip, Tooltip, IconButton,
  Table, TableHead, TableRow, TableCell, TableBody, Link, Stack, Switch,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { adminApi } from '../../../api/endpoints.js';
import { useApi } from '../../../hooks/useApi.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';

const errMsg = (err, fallback) => err?.data?.error || err?.message || fallback;

// Manage game variants (super-admin) — Phase C label layer. Variants are the
// free-text join key the bot emits (game_servers.variant); this page promotes them
// to managed rows so the picker isn't a hardcoded list. `name` is IMMUTABLE once
// created (it's the join key); display_name/notes/archived are editable. Delete
// archives when the variant is still in use by a server, else hard-deletes.
export default function VariantsPage() {
  const { showSnackbar } = useSnackbar();
  const { data, loading, refetch } = useApi(() => adminApi.getVariants(), []);
  const rows = data?.data || [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId]         = useState(null);   // row.id being inline-edited
  const [editDisplay, setEditDisplay] = useState('');
  const [editNotes, setEditNotes]     = useState('');
  const [rowBusy, setRowBusy]         = useState(null);  // id with an in-flight mutation
  const [confirmDel, setConfirmDel]   = useState(null);  // the row pending delete

  // ── Inline edit ────────────────────────────────────────────────────────────
  const startEdit = (r) => {
    setEditId(r.id);
    setEditDisplay(r.display_name || '');
    setEditNotes(r.notes || '');
  };
  const cancelEdit = () => { setEditId(null); setEditDisplay(''); setEditNotes(''); };

  const saveEdit = async (r) => {
    setRowBusy(r.id);
    try {
      await adminApi.updateVariant(r.id, {
        display_name: editDisplay.trim() || null,
        notes: editNotes.trim() || null,
      });
      showSnackbar('Variant updated');
      cancelEdit();
      refetch();
    } catch (err) {
      showSnackbar(errMsg(err, 'Update failed'), 'error');
    } finally {
      setRowBusy(null);
    }
  };

  // ── Archive / unarchive ────────────────────────────────────────────────────
  const toggleArchive = async (r) => {
    setRowBusy(r.id);
    try {
      await adminApi.updateVariant(r.id, { archived: !r.archived });
      showSnackbar(r.archived ? 'Variant restored' : 'Variant archived');
      refetch();
    } catch (err) {
      showSnackbar(errMsg(err, 'Update failed'), 'error');
    } finally {
      setRowBusy(null);
    }
  };

  // ── Delete (server refuses & archives instead when still in use) ────────────
  const handleDelete = async () => {
    const r = confirmDel;
    if (!r) return;
    setRowBusy(r.id);
    try {
      await adminApi.deleteVariant(r.id);
      showSnackbar('Variant deleted');
      setConfirmDel(null);
      refetch();
    } catch (err) {
      // Server refuses a delete for an in-use variant (409) and archives it.
      showSnackbar(errMsg(err, 'Delete failed'), 'error');
      setConfirmDel(null);
      refetch();
    } finally {
      setRowBusy(null);
    }
  };

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

      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Monster Map — Variants</Typography>
          <Typography variant="caption" color="text.secondary">
            Managed labels for the server variant picker. The variant name is the join key the bot reports — it can't be renamed here.
          </Typography>
        </Box>
        <Button
          size="small" variant="contained" startIcon={<AddIcon fontSize="small" />}
          onClick={() => setCreateOpen(true)}
        >
          New variant
        </Button>
      </Box>

      <Paper variant="outlined" sx={{ mt: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Display</TableCell>
              <TableCell align="right">Servers</TableCell>
              <TableCell>Notes</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={5}>Loading…</TableCell></TableRow>}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={5}><Typography variant="caption" color="text.disabled">No variants yet.</Typography></TableCell></TableRow>
            )}
            {rows.map((r) => {
              const editing = editId === r.id;
              const busy = rowBusy === r.id;
              const inUse = (r.server_count || 0) > 0;
              return (
                <TableRow key={r.id} sx={r.archived ? { opacity: 0.55 } : undefined}>
                  <TableCell>
                    <Typography variant="body2" fontFamily="monospace">{r.name}</Typography>
                    {r.archived && <Chip label="archived" size="small" variant="outlined" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell sx={{ minWidth: 180 }}>
                    {editing ? (
                      <TextField
                        size="small" value={editDisplay} disabled={busy} fullWidth
                        placeholder="Display name"
                        inputProps={{ maxLength: 64 }}
                        onChange={(e) => setEditDisplay(e.target.value)}
                      />
                    ) : (
                      r.display_name || <Typography variant="caption" color="text.disabled">—</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">{r.server_count ?? 0}</TableCell>
                  <TableCell sx={{ minWidth: 220 }}>
                    {editing ? (
                      <TextField
                        size="small" value={editNotes} disabled={busy} fullWidth
                        placeholder="Notes"
                        inputProps={{ maxLength: 255 }}
                        onChange={(e) => setEditNotes(e.target.value)}
                      />
                    ) : (
                      r.notes || <Typography variant="caption" color="text.disabled">—</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {editing ? (
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Save">
                          <span>
                            <IconButton size="small" color="success" disabled={busy} onClick={() => saveEdit(r)}>
                              <CheckIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Cancel">
                          <span>
                            <IconButton size="small" disabled={busy} onClick={cancelEdit}>
                              <CloseIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    ) : (
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center">
                        <Tooltip title="Edit display / notes">
                          <span>
                            <IconButton size="small" disabled={busy} onClick={() => startEdit(r)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title={r.archived ? 'Restore (show in picker)' : 'Archive (hide from picker)'}>
                          <Switch
                            size="small" checked={!r.archived} disabled={busy}
                            onChange={() => toggleArchive(r)}
                          />
                        </Tooltip>
                        <Tooltip title={inUse ? 'In use — deleting will archive instead' : 'Delete'}>
                          <span>
                            <IconButton size="small" color="error" disabled={busy} onClick={() => setConfirmDel(r)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Paper>

      <NewVariantDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); refetch(); }}
      />

      {/* Delete confirmation. In-use variants are archived server-side, not deleted. */}
      <Dialog open={!!confirmDel} onClose={() => rowBusy == null && setConfirmDel(null)}>
        <DialogTitle>Delete variant?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirmDel && (confirmDel.server_count || 0) > 0 ? (
              <>
                <strong>{confirmDel?.name}</strong> is still used by{' '}
                <strong>{confirmDel?.server_count}</strong> server(s), so it will be{' '}
                <strong>archived</strong> (hidden from the picker) instead of deleted.
              </>
            ) : (
              <>
                This permanently deletes variant <strong>{confirmDel?.name}</strong>.
                This cannot be undone.
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(null)} disabled={rowBusy != null}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={rowBusy != null}>
            {confirmDel && (confirmDel.server_count || 0) > 0 ? 'Archive' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// New-variant dialog: name (required, the immutable join key) + optional display
// name and notes. 409 on a duplicate name surfaces inline.
function NewVariantDialog({ open, onClose, onCreated }) {
  const { showSnackbar } = useSnackbar();
  const [name, setName]       = useState('');
  const [display, setDisplay] = useState('');
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  // Reset on open.
  const handleEnter = () => {
    setName(''); setDisplay(''); setNotes(''); setError(''); setSaving(false);
  };

  const handleCreate = async () => {
    const nm = name.trim();
    if (!nm) { setError('Name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const body = { name: nm };
      if (display.trim()) body.display_name = display.trim();
      if (notes.trim())   body.notes = notes.trim();
      await adminApi.createVariant(body);
      showSnackbar('Variant created');
      onCreated?.();
    } catch (err) {
      const msg = errMsg(err, 'Create failed');
      setError(msg);
      showSnackbar(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open} onClose={() => !saving && onClose()} maxWidth="sm" fullWidth
      TransitionProps={{ onEnter: handleEnter }}
    >
      <DialogTitle>New variant</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
        <DialogContentText sx={{ fontSize: '0.8rem' }}>
          The name is the join key the bot reports and cannot be changed later.
          Display name and notes are labels only.
        </DialogContentText>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Name" size="small" value={name} disabled={saving} autoFocus fullWidth
          inputProps={{ maxLength: 32 }}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Display name (optional)" size="small" value={display} disabled={saving} fullWidth
          inputProps={{ maxLength: 64 }}
          onChange={(e) => setDisplay(e.target.value)}
        />
        <TextField
          label="Notes (optional)" size="small" value={notes} disabled={saving} fullWidth multiline minRows={2}
          inputProps={{ maxLength: 255 }}
          onChange={(e) => setNotes(e.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={handleCreate} disabled={saving || !name.trim()}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
