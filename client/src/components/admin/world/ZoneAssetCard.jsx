import { useState } from 'react';
import {
  Paper, Box, Typography, Stack, Chip, Button,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import CropFreeIcon from '@mui/icons-material/CropFree';
import MapIcon from '@mui/icons-material/Map';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import StatusDot from './StatusDot.jsx';
import UploadDropZone from './UploadDropZone.jsx';

// Human byte size for the mapMeta line.
function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage  = (name) => /\.(png|svg)$/i.test(name || '');
const isJson    = (name) => /\.json$/i.test(name || '');
const looksCalib = (name) => /calib/i.test(name || '') || /_bounds\b/i.test(name || '');

// One compact per-zone asset card (P3). Routes a single dropped file to the right
// endpoint by its NAME:
//   *.png / *.svg          -> uploadZoneMap (background)
//   *.json containing calib -> importZoneBounds (bounds)
//   ambiguous (.json not obviously calib, or unknown) -> a two-button chooser.
// After any success -> refetch() + bumpNonce() + snackbar. When a background
// exists, the card also exposes Replace / Delete / Preview affordances.
export default function ZoneAssetCard({ server, zone, mapMeta, refetch, bumpNonce, onPreview }) {
  const { showSnackbar } = useSnackbar();
  const [busy, setBusy]           = useState(false);
  const [ambiguous, setAmbiguous] = useState(null); // File awaiting a route choice
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting]   = useState(false);

  const zoneNo = zone?.zone_no;
  const label  = `Zone ${zoneNo} · ${zone?.name || 'unnamed'}`;

  const afterSuccess = () => { refetch?.(); bumpNonce?.(); };

  const uploadBackground = async (file) => {
    setBusy(true);
    try {
      await adminApi.uploadZoneMap(server.id, zoneNo, file);
      showSnackbar(`Background uploaded for zone ${zoneNo}`);
      afterSuccess();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Background upload failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const uploadBounds = async (file) => {
    setBusy(true);
    try {
      await adminApi.importZoneBounds(server.id, zoneNo, file);
      showSnackbar(`Bounds imported for zone ${zoneNo}`);
      afterSuccess();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Bounds import failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Route a dropped/selected file by its name; defer to the chooser when unclear.
  const routeFile = (file) => {
    if (!file || !server?.id) return;
    if (isImage(file.name)) { uploadBackground(file); return; }
    if (isJson(file.name) && looksCalib(file.name)) { uploadBounds(file); return; }
    // Ambiguous: a .json that isn't obviously calib, or an unknown type.
    setAmbiguous(file);
  };

  const onFiles = (fileList) => routeFile(fileList?.[0]);

  const resolveAmbiguous = (asBackground) => {
    const file = ambiguous;
    setAmbiguous(null);
    if (!file) return;
    if (asBackground) uploadBackground(file);
    else uploadBounds(file);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await adminApi.deleteZoneMap(server.id, zoneNo);
      showSnackbar(`Background deleted for zone ${zoneNo}`);
      setConfirmDel(false);
      afterSuccess();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const meta = mapMeta || null;
  const sizeStr = meta ? fmtBytes(meta.byte_size) : '';

  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {/* Header: title + three status dots. */}
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="body2" fontWeight={700} noWrap sx={{ minWidth: 0 }} title={label}>
          {label}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          <StatusDot
            state={zone?.has_data ? 'done' : 'inert'}
            title={zone?.has_data ? 'Spawn data collected' : 'No spawn data yet — bot-recorded, not uploadable'}
            size={16}
          />
          <StatusDot
            state={zone?.has_bounds ? 'done' : 'missing'}
            title={zone?.has_bounds ? 'Bounds set (framed)' : 'No bounds — upload calib.json to frame'}
            size={16}
          />
          <StatusDot
            state={zone?.has_background ? 'done' : 'missing'}
            title={zone?.has_background ? 'Background uploaded' : 'No background — upload a PNG/SVG'}
            size={16}
          />
        </Stack>
      </Stack>

      {/* Bounds status chip / hint. */}
      {zone?.has_bounds ? (
        <Chip
          size="small"
          variant="outlined"
          color="success"
          icon={<CropFreeIcon sx={{ fontSize: 15 }} />}
          label="framed"
          sx={{ alignSelf: 'flex-start', height: 22 }}
        />
      ) : (
        <Typography variant="caption" color="text.secondary">
          Background will auto-fit (approximate) until bounds are uploaded.
        </Typography>
      )}

      {/* Background present: meta + Replace/Delete/Preview. Absent: the dropzone. */}
      {zone?.has_background ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
            {meta?.format && (
              <Chip size="small" label={String(meta.format).toUpperCase()} sx={{ height: 20 }} />
            )}
            {(meta?.width && meta?.height) ? (
              <Typography variant="caption" color="text.secondary">
                {meta.width}×{meta.height}
              </Typography>
            ) : null}
            {sizeStr && (
              <Typography variant="caption" color="text.secondary">· {sizeStr}</Typography>
            )}
          </Box>
          <UploadDropZone
            accept=".png,.svg,.json"
            busy={busy}
            onFiles={onFiles}
            label="Replace: drop a PNG/SVG or calib.json"
            hint="PNG/SVG → background · calib.json → bounds"
          />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<MapIcon sx={{ fontSize: 16 }} />}
              onClick={() => onPreview?.(zoneNo)}
            >
              Preview on map
            </Button>
            <Button
              size="small"
              color="error"
              variant="text"
              startIcon={<DeleteOutlineIcon sx={{ fontSize: 16 }} />}
              disabled={busy || deleting}
              onClick={() => setConfirmDel(true)}
            >
              Delete background
            </Button>
          </Stack>
        </>
      ) : (
        <UploadDropZone
          accept=".png,.svg,.json"
          busy={busy}
          onFiles={onFiles}
          label="Drop a PNG/SVG or calib.json"
          hint="PNG/SVG → background · calib.json → bounds"
        />
      )}

      {/* Ambiguous-file chooser. */}
      <Dialog open={!!ambiguous} onClose={() => !busy && setAmbiguous(null)}>
        <DialogTitle>How should this file be used?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The file {ambiguous?.name && (<><strong>{ambiguous.name}</strong>{' '}</>)}
            could be a zone background or a bounds calibration. Choose how to import
            it for zone {zoneNo}.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAmbiguous(null)} disabled={busy}>Cancel</Button>
          <Button onClick={() => resolveAmbiguous(false)} disabled={busy}>Use as bounds</Button>
          <Button variant="contained" onClick={() => resolveAmbiguous(true)} disabled={busy}>
            Use as background
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete-background confirm. */}
      <Dialog open={confirmDel} onClose={() => !deleting && setConfirmDel(false)}>
        <DialogTitle>Delete background?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the uploaded background image for zone {zoneNo}. Spawn data
            and bounds are kept. You can re-upload a background at any time.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(false)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
