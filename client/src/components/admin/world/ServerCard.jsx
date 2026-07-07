import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Chip, Card, CardActionArea, CardContent, CardActions,
  IconButton, Menu, MenuItem, Divider, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { adminApi } from '../../../api/endpoints.js';
import { useSnackbar } from '../../../context/SnackbarContext.jsx';
import ExportCsvMenu from './ExportCsvMenu.jsx';

// Relative "time ago" for the last_seen footer. Server sends epoch seconds.
const fmtRelative = (sec) => {
  if (!sec) return 'never';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
};

// A small labelled pill for the coverage strip. `value` null/undefined renders a
// neutral "—" placeholder (used for counts a later phase + backend will add).
function CoveragePill({ label, value }) {
  const placeholder = value === null || value === undefined;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={placeholder ? 'default' : 'primary'}
      label={
        <Box component="span" sx={{ display: 'inline-flex', gap: 0.5, alignItems: 'baseline' }}>
          <Box component="span" sx={{ fontSize: '0.65rem', opacity: 0.75 }}>{label}</Box>
          <Box component="span" sx={{ fontWeight: 600 }}>{placeholder ? '—' : value}</Box>
        </Box>
      }
      sx={{ height: 22 }}
    />
  );
}

// One server as a card in the WorldServersPage grid. The card body is a big
// CardActionArea that navigates into the server's detail route; a MoreVert
// overflow menu holds Edit / Export CSV / Delete; a clickable visibility Chip
// toggles the server's public/hidden state in place.
export default function ServerCard({ server, onChanged }) {
  const navigate = useNavigate();
  const { showSnackbar } = useSnackbar();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [toggling, setToggling]     = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting]     = useState(false);

  const menuOpen = Boolean(menuAnchor);
  const detailPath = `/admin/world/servers/${server.id}`;

  const toggleVisible = async () => {
    if (toggling) return;
    setToggling(true);
    try {
      await adminApi.updateWorldServer(server.id, { visible: !server.visible });
      showSnackbar(!server.visible ? 'Server made public' : 'Server hidden');
      onChanged?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Toggle failed', 'error');
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await adminApi.deleteWorldServer(server.id);
      showSnackbar('Server and its spawn data deleted');
      setConfirmDel(false);
      onChanged?.();
    } catch (err) {
      showSnackbar(err.data?.error || err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const zNamed = server.zone_named_count ?? 0;
  const mNamed = server.mob_named_count ?? 0;
  const nNamed = server.npc_named_count ?? 0;
  const mobCount = server.mob_count ?? 0;
  const cellCount = server.cell_count ?? 0;

  return (
    <Card variant="outlined" sx={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Visibility chip — kept OUTSIDE the CardActionArea: an interactive control
          must not nest inside the action-area button (invalid DOM). Floats top-right. */}
      <Tooltip title={server.visible ? 'Public on user map — click to hide' : 'Hidden — click to publish'}>
        <Chip
          label={server.visible ? 'Public' : 'Hidden'}
          size="small"
          color={server.visible ? 'success' : 'default'}
          variant={server.visible ? 'filled' : 'outlined'}
          disabled={toggling}
          onClick={toggleVisible}
          sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
        />
      </Tooltip>
      <CardActionArea
        onClick={() => navigate(detailPath)}
        sx={{ flexGrow: 1, alignItems: 'stretch' }}
      >
        <CardContent>
          <Box sx={{ minWidth: 0, pr: 7, mb: 1 }}>
            <Typography variant="h6" fontWeight={600} noWrap>
              {server.name || `Server #${server.id}`}
            </Typography>
            <Chip
              label={server.variant || 'Unknown'}
              size="small"
              variant="outlined"
              sx={{ mt: 0.5, height: 20 }}
            />
          </Box>

          {/* Coverage strip — for P0 only what GET /servers returns; Bounds &
              Backgrounds are neutral placeholders a later phase fills in. */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
            <CoveragePill label={`Names z/mob/npc`} value={`${zNamed}/${mNamed}/${nNamed}`} />
            <CoveragePill label="Data mob/cell" value={`${mobCount}/${cellCount}`} />
            <CoveragePill label="Bounds" value={null} />
            <CoveragePill label="Backgrounds" value={null} />
          </Box>
        </CardContent>
      </CardActionArea>

      <Divider />
      <CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">
            Last seen {fmtRelative(server.last_seen)}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            {cellCount} cells
          </Typography>
        </Box>
        <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)}>
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </CardActions>

      <Menu anchorEl={menuAnchor} open={menuOpen} onClose={() => setMenuAnchor(null)}>
        <MenuItem
          onClick={() => { setMenuAnchor(null); navigate(`${detailPath}/settings`); }}
        >
          Edit
        </MenuItem>
        <ExportCsvMenu serverId={server.id} trigger="menuitem" onDone={() => setMenuAnchor(null)} />
        <MenuItem
          onClick={() => { setMenuAnchor(null); setConfirmDel(true); }}
          sx={{ color: 'error.main' }}
        >
          Delete
        </MenuItem>
      </Menu>

      <Dialog open={confirmDel} onClose={() => !deleting && setConfirmDel(false)}>
        <DialogTitle>Delete server?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes server{' '}
            <strong>{server.name || `#${server.id}`}</strong>{' '}
            (#{server.id}) and <strong>all of its collected spawn data</strong> — mob
            catalog, spawn cells, versions and zone bounds. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDel(false)} disabled={deleting}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
