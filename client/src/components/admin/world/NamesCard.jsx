import { useState } from 'react';
import {
  Paper, Typography, Stack, Chip, Box,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button,
} from '@mui/material';
import LabelIcon from '@mui/icons-material/Label';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import UploadDropZone from './UploadDropZone.jsx';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// One current-named-count chip (zones / monsters / NPCs).
function CountChip({ label, count }) {
  const has = count > 0;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={has ? 'success' : 'default'}
      label={`${count} ${label}`}
      sx={{ height: 22 }}
    />
  );
}

// The server-level reference-names import card (P3). A single UploadDropZone that
// posts a names.json OR a zones/mobs/npcs .csv to importServerNames — REPLACE-ALL
// per list. If any current named count is > 0 we gate the upload behind a
// replace-all confirm dialog first (the file's lists overwrite the whole server's
// names). Success -> refetch() + snackbar; error -> error snackbar.
export default function NamesCard({ server, refetch }) {
  const { showSnackbar } = useSnackbar();
  const [busy, setBusy]       = useState(false);
  const [pending, setPending] = useState(null); // File awaiting replace-all confirm

  const zNamed = num(server?.zone_named_count);
  const mNamed = num(server?.mob_named_count);
  const nNamed = num(server?.npc_named_count);
  const hasAny = zNamed + mNamed + nNamed > 0;

  const doImport = async (file) => {
    if (!file || !server?.id) return;
    setBusy(true);
    try {
      const res = await adminApi.importServerNames(server.id, file);
      showSnackbar(`Names imported — ${res?.zones ?? 0} zones, ${res?.mobs ?? 0} monsters`);
      refetch?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Name import failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const onFiles = (fileList) => {
    const file = fileList?.[0];
    if (!file) return;
    if (hasAny) { setPending(file); return; } // confirm replace-all first
    doImport(file);
  };

  const confirmReplace = () => {
    const file = pending;
    setPending(null);
    doImport(file);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <LabelIcon fontSize="small" color="action" />
        <Typography variant="subtitle1" fontWeight={700}>Reference names</Typography>
      </Stack>

      <Stack direction="row" spacing={0.75} flexWrap="wrap" sx={{ rowGap: 0.75, mb: 1 }}>
        <CountChip label="zones" count={zNamed} />
        <CountChip label="monsters" count={mNamed} />
        <CountChip label="NPCs" count={nNamed} />
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        From the bot Exporter → names.json, or a zones / mobs / npcs .csv. Uploading{' '}
        <strong>replaces all</strong> names for the list(s) contained in the file.
      </Typography>

      <UploadDropZone
        accept=".json,.csv"
        busy={busy}
        onFiles={onFiles}
        label="Drop names.json / .csv, or click to browse"
        hint="Replaces the whole server's names for the lists in the file"
      />

      {/* Replace-all confirm — only shown when names already exist. */}
      <Dialog open={!!pending} onClose={() => !busy && setPending(null)}>
        <DialogTitle>Replace reference names?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This replaces the whole server's names for the list(s) in the file{' '}
            {pending?.name && (<><strong>({pending.name})</strong>{' '}</>)}
            — every zone / monster / NPC name in each list the file contains is
            overwritten. Lists not present in the file are left untouched.
          </DialogContentText>
          <Box sx={{ mt: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              Current: {zNamed} zones · {mNamed} monsters · {nNamed} NPCs
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
          <Button color="warning" variant="contained" onClick={confirmReplace} disabled={busy}>
            Replace all
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
