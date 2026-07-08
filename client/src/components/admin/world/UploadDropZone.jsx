import { useRef, useState } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';

// A reusable, DUMB drag-and-drop + click-to-browse file input. Holds no API
// state — it just surfaces the dropped/selected FileList to onFiles and leaves
// everything else (which endpoint, snackbars, refetch) to the caller.
//
// Props:
//   accept    — <input accept> filter string (e.g. ".json,.csv").
//   multiple  — allow multiple files (default false).
//   onFiles   — (fileList) => void; called with the dropped/selected files.
//   busy      — show a spinner + block interaction while a caller op runs.
//   label     — primary line (e.g. "Drop names.json / .csv, or click to browse").
//   hint      — secondary caption under the label.
//   disabled  — fully inert (no click, no drop, dimmed).
export default function UploadDropZone({
  accept,
  multiple = false,
  onFiles,
  busy = false,
  label = 'Drop a file here, or click to browse',
  hint,
  disabled = false,
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const blocked = disabled || busy;

  const emit = (fileList) => {
    if (blocked) return;
    if (fileList && fileList.length) onFiles?.(fileList);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (blocked) return;
    emit(e.dataTransfer?.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    if (!blocked) setDragOver(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const onPicked = (e) => {
    const files = e.target.files;
    e.target.value = ''; // allow re-picking the same file
    emit(files);
  };

  const openPicker = () => { if (!blocked) inputRef.current?.click(); };

  return (
    <Box
      role="button"
      tabIndex={blocked ? -1 : 0}
      aria-disabled={blocked}
      onClick={openPicker}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } }}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        px: 2,
        py: 2.5,
        textAlign: 'center',
        border: '1.5px dashed',
        borderColor: dragOver ? 'primary.main' : 'divider',
        borderRadius: 1.5,
        bgcolor: dragOver ? 'action.hover' : 'transparent',
        color: disabled ? 'text.disabled' : 'text.secondary',
        cursor: blocked ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s, background-color .12s',
        outline: 'none',
        '&:hover': blocked ? undefined : { borderColor: 'primary.light', bgcolor: 'action.hover' },
        '&:focus-visible': { borderColor: 'primary.main' },
      }}
    >
      {/* Visually hidden but STILL in the layout tree — a display:none / `hidden`
          input makes a programmatic inputRef.click() a no-op in some browsers, which
          is why "click to browse" did nothing while drag-drop worked. */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={onPicked}
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        tabIndex={-1}
      />
      {busy ? (
        <CircularProgress size={22} />
      ) : (
        <CloudUploadIcon sx={{ fontSize: 28, color: dragOver ? 'primary.main' : 'text.disabled' }} />
      )}
      <Typography variant="body2" fontWeight={600} sx={{ lineHeight: 1.3 }}>
        {busy ? 'Uploading…' : label}
      </Typography>
      {hint && !busy && (
        <Typography variant="caption" color="text.disabled" sx={{ lineHeight: 1.3 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
