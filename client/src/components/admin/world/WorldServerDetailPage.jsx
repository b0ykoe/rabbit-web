import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Navigate, Link as RouterLink } from 'react-router-dom';
import {
  Box, Typography, Paper, Breadcrumbs, Link, IconButton, Tooltip, Chip,
  Skeleton, Alert, Stack,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { adminApi } from '../../../api/endpoints.js';
import ServerTabs, { SERVER_TABS } from './ServerTabs.jsx';
import ServerSettingsTab from './ServerSettingsTab.jsx';
import ServerOverviewTab from './ServerOverviewTab.jsx';
import UploadsTab from './UploadsTab.jsx';
import MapTab from './MapTab.jsx';
import ServerDataTab from './ServerDataTab.jsx';
import ServerOffsetsTab from './ServerOffsetsTab.jsx';
import CoverageStatusPill from './CoverageStatusPill.jsx';

const TAB_KEYS = SERVER_TABS.map((t) => t.key);
const DEFAULT_TAB = 'overview';

// Relative "time ago" from epoch seconds. Used for the "Data last updated" clock
// (overview.counts.data_last_seen = MAX(mob_catalog.last_seen)). Null → "never".
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

// The per-server detail shell (P1). Resolves :id + :tab, loads the server ROW (from
// the admin list — there is no GET /servers/:id) plus its coverage overview, renders
// a header + tab bar, and mounts the active tab body. The Settings tab is real; the
// rest are stubs the P2–P4 phases fill in. `mapNonce`/`bumpNonce` are threaded to
// every tab so a later phase can cache-bust map/background renders after an upload.
export default function WorldServerDetailPage() {
  const { id, tab } = useParams();
  const navigate = useNavigate();

  const [server,   setServer]   = useState(null);
  const [overview, setOverview] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [mapNonce, setMapNonce] = useState(0);
  // Zone to preselect on the Map tab when a "Preview on map" (Uploads) or a coverage
  // zone-name click hands off a specific zone. Null → the map picks its own default.
  const [pendingMapZone, setPendingMapZone] = useState(null);

  const bumpNonce = useCallback(() => setMapNonce((n) => n + 1), []);

  // Tab navigation with an optional zone hand-off: when a caller opens the Map tab
  // with a zoneNo (Uploads "Preview on map" / Coverage zone-name click), remember it
  // as the preselected zone; then push the tab route. Non-map tabs clear any pending
  // zone so a later plain map visit doesn't jump to a stale one.
  const openTab = useCallback((t, zoneNo) => {
    if (t === 'map' && zoneNo != null) setPendingMapZone(zoneNo);
    else if (t !== 'map') setPendingMapZone(null);
    navigate(`/admin/world/servers/${id}/${t}`);
  }, [navigate, id]);

  // Fetch both the list row (found by id) and the coverage overview together.
  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, overviewRes] = await Promise.all([
        adminApi.getWorldServers(),
        adminApi.getServerOverview(id).catch(() => null), // overview is best-effort
      ]);
      const rows = listRes?.data || [];
      const row = rows.find((r) => String(r.id) === String(id)) || null;
      setServer(row);
      setOverview(overviewRes);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refetch(); }, [refetch]);

  // Normalise the tab: anything not in the known set redirects to /overview.
  if (tab !== undefined && !TAB_KEYS.includes(tab)) {
    return <Navigate to={`/admin/world/servers/${id}/${DEFAULT_TAB}`} replace />;
  }
  const activeTab = tab || DEFAULT_TAB;

  const tabProps = { server, overview, loading, refetch, nonce: mapNonce, bumpNonce };

  const renderTab = () => {
    switch (activeTab) {
      case 'settings':
        return <ServerSettingsTab {...tabProps} onChanged={refetch} />;
      case 'map':
        return <MapTab {...tabProps} initialZone={pendingMapZone} onOpenTab={openTab} />;
      case 'uploads':
        return <UploadsTab {...tabProps} onOpenTab={openTab} />;
      case 'data':
        return <ServerDataTab {...tabProps} />;
      case 'offsets':
        return <ServerOffsetsTab {...tabProps} />;
      case 'overview':
      default:
        return <ServerOverviewTab {...tabProps} onOpenTab={openTab} />;
    }
  };

  // ── Not-found: loaded, no error, but the id has no row. ────────────────────
  const notFound = !loading && !error && !server;

  const backButton = (
    <Tooltip title="Back to servers">
      <IconButton size="small" onClick={() => navigate('/admin/world')}>
        <ArrowBackIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  if (error) {
    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>{backButton}</Box>
        <Alert severity="error">
          {error.data?.error || error.message || 'Failed to load this server.'}
        </Alert>
      </Box>
    );
  }

  if (notFound) {
    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          {backButton}
          <Breadcrumbs aria-label="breadcrumb">
            <Link component={RouterLink} to="/admin/world" underline="hover" color="inherit">
              Servers
            </Link>
            <Typography color="text.primary">server #{id}</Typography>
          </Breadcrumbs>
        </Box>
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
          <Typography variant="h6" gutterBottom>Server not found</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            No server with id <strong>#{id}</strong> exists. It may have been deleted.
          </Typography>
          <Link component={RouterLink} to="/admin/world" underline="hover">
            Back to servers
          </Link>
        </Paper>
      </Box>
    );
  }

  const displayName = server?.name || `Server #${id}`;
  const dataLastSeen = overview?.counts?.data_last_seen ?? null;

  return (
    <Box>
      {/* Header: back + breadcrumbs */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        {backButton}
        <Breadcrumbs aria-label="breadcrumb">
          <Link component={RouterLink} to="/admin/world" underline="hover" color="inherit">
            Servers
          </Link>
          <Typography color="text.primary" noWrap>
            {loading && !server ? <Skeleton width={120} /> : displayName}
          </Typography>
        </Breadcrumbs>
      </Box>

      {/* Title row: name + visibility + known-IP chips (read-only here) */}
      <Box sx={{ mb: 2 }}>
        {loading && !server ? (
          <Skeleton variant="text" width="40%" height={40} />
        ) : (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <Typography variant="h5" fontWeight={700} sx={{ mr: 0.5 }}>{displayName}</Typography>
            <Chip
              label={server?.visible ? 'Public' : 'Hidden'}
              size="small"
              color={server?.visible ? 'success' : 'default'}
              variant={server?.visible ? 'filled' : 'outlined'}
            />
            <CoverageStatusPill server={server} />
            {(server?.known_ips || []).map((ip) => (
              <Chip
                key={ip} label={ip} size="small" variant="outlined"
                sx={{ fontFamily: 'monospace', height: 22 }}
              />
            ))}
          </Stack>
        )}
        {!(loading && !server) && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            Data last updated {fmtRelative(dataLastSeen)}
          </Typography>
        )}
      </Box>

      <ServerTabs value={activeTab} serverId={id} />

      {renderTab()}
    </Box>
  );
}
