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
import CoverageStatusPill from './CoverageStatusPill.jsx';

// Relative "time ago" for the footer. Server sends epoch seconds. Fed by
// data_last_seen = MAX(mob_catalog.last_seen), the true "data last updated" clock
// (game_servers.last_seen is stamped at create and never advanced by ingest).
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
// neutral "—" placeholder. `color` overrides the default primary tint so the
// per-zone coverage pills (Bounds / Backgrounds) can go green/amber/grey.
function CoveragePill({ label, value, color }) {
  const placeholder = value === null || value === undefined;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color || (placeholder ? 'default' : 'primary')}
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

// Green when the numerator equals a positive denominator (fully covered), amber
// when partially covered, grey when there is nothing yet (0/0 or no data zones).
const coverageColor = (have, total) => {
  if (!total) return 'default';
  if (have >= total) return 'success';
  return 'warning';
};

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

  // Per-zone coverage (B1): distinct data-zones vs. those with bounds/backgrounds.
  const zData       = server.zones_with_data ?? 0;
  const zBounds     = server.zones_with_bounds ?? 0;
  const zBackground = server.zones_with_background ?? 0;

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

          {/* Coverage strip — GET /servers counts + the B1 per-zone rollups. The
              Bounds/Backgrounds pills tint by how many data-zones are covered. */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.5 }}>
            <CoveragePill label={`Names z/mob/npc`} value={`${zNamed}/${mNamed}/${nNamed}`} />
            <CoveragePill label="Data mob/cell" value={`${mobCount}/${cellCount}`} />
            <CoveragePill label="Bounds" value={`${zBounds}/${zData}`} color={coverageColor(zBounds, zData)} />
            <CoveragePill label="Backgrounds" value={`${zBackground}/${zData}`} color={coverageColor(zBackground, zData)} />
          </Box>

          {/* At-a-glance setup status (computed from the row alone). */}
          <Box sx={{ mt: 1 }}>
            <CoverageStatusPill server={server} />
          </Box>
        </CardContent>
      </CardActionArea>

      <Divider />
      <CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">
            Updated {fmtRelative(server.data_last_seen)}
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
