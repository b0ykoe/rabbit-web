import { useState, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Box, Typography, Paper, Grid, MenuItem, TextField, ToggleButtonGroup,
  ToggleButton, CircularProgress, Alert, Chip, List, ListItem, ListItemButton,
  ListItemText, Checkbox, Divider, InputAdornment, FormControlLabel, Switch,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { worldApi } from '../../api/endpoints.js';

// ─────────────────────────────────────────────────────────────────────────────
// Monster Map — user-facing read view over /api/portal/world.
//
// Flow: pick a (visible) SERVER → pick a MOB (catalog search) → we derive the
// ZONES that mob appears in via /mobs/:id/spawns, pick a zone, then render the
// zone's CLUSTERS (8-neighbour packs) as an SVG heat map. A cell is 4 m; world =
// origin + cell*4, framed by /zones/:z/bounds when present (else auto-fit).
// Controls: version (latest / all-time) and a mob checklist filter.
// ─────────────────────────────────────────────────────────────────────────────

const CELL_M = 4;          // metres per cell (fixed by ingest quantisation)
const SVG_W = 640;
const SVG_H = 640;
const PAD = 24;            // inner padding inside the viewport

// Blue → cyan → green → yellow → red ramp over a normalised [0,1] score.
function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  // piecewise-linear through 5 stops
  const stops = [
    [0.0, [ 33, 102, 172]], // blue
    [0.25, [ 67, 147, 195]],
    [0.5, [ 90, 174, 97]],  // green
    [0.75, [244, 165, 66]], // orange
    [1.0, [214, 47, 39]],   // red
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (x >= stops[i][0] && x <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  const f = (x - a[0]) / span;
  const c = a[1].map((av, i) => Math.round(av + (b[1][i] - av) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function timeAgo(sec) {
  if (!sec) return '—';
  const s = Math.floor(Date.now() / 1000) - sec;
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function MonsterMap() {
  const [servers, setServers]   = useState([]);
  const [serverId, setServerId] = useState('');
  const [loadingServers, setLoadingServers] = useState(true);
  const [topError, setTopError] = useState('');

  const [mobQuery, setMobQuery] = useState('');
  const [mobs, setMobs]         = useState([]);
  const [loadingMobs, setLoadingMobs] = useState(false);
  const [selectedMobs, setSelectedMobs] = useState(new Set()); // mob_id checklist
  const [focusMob, setFocusMob] = useState(null);              // mob used for zone derivation

  const [version, setVersion]   = useState('latest');          // 'latest' | 'all'

  const [zones, setZones]       = useState([]);                // [zone_no,...]
  const [zoneNo, setZoneNo]     = useState('');
  const [loadingZones, setLoadingZones] = useState(false);

  const [clusters, setClusters] = useState([]);                // rendered packs
  const [bounds, setBounds]     = useState(null);              // zone_bounds row or null
  const [loadingMap, setLoadingMap] = useState(false);
  const [mapError, setMapError] = useState('');
  const [hover, setHover]       = useState(null);              // { c, mobName }

  // Optional per-(server,zone) background image, drawn UNDER the spawn points and
  // framed to the zone AABB. bgAvailable flips false on a 404/decode error (onError)
  // so we silently fall back to the coordinate-space render — never a broken image.
  const [bgAvailable, setBgAvailable] = useState(false);
  const [bgEnabled, setBgEnabled]     = useState(true);       // user toggle, ON by default

  // Hide low-confidence spots (seen once / near-zero reliability) from the render
  // and the auto-fit framing. OFF by default so nothing is hidden implicitly.
  const [hideSeenOnce, setHideSeenOnce] = useState(false);
  const RELIABILITY_MIN = 0.15;             // small threshold below which a spot is "unreliable"

  // ── Deep-link from a recording session ("Show on map") ─────────────────────
  // WorldSessions navigates here with react-router state
  //   { serverId, zoneNo, versionId, highlightSpots:[{center_x,center_z,mob_id}] }.
  // We preselect that server, seed the highlighted mob(s) so the zone derives and
  // the clusters load, force the zone, and remember the spots to ring on the map.
  // No state → nothing happens; existing behaviour is untouched.
  const location = useLocation();
  const navState = location.state || null;
  const [highlightSpots, setHighlightSpots] = useState([]); // [{center_x,center_z,mob_id}]
  const [pendingZone, setPendingZone]       = useState(''); // zone to force once derived

  // ── Servers (visible only) ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoadingServers(true);
    worldApi.servers()
      .then((r) => { if (!alive) return; setServers(r.data || []); })
      .catch((e) => { if (alive) setTopError(e.data?.error || e.message || 'Failed to load servers'); })
      .finally(() => { if (alive) setLoadingServers(false); });
    return () => { alive = false; };
  }, []);

  // Consume the deep-link state ONCE (after servers load so the server id is a
  // valid picker option). Seed server + highlighted mobs + pending zone; the
  // normal zone-derivation / map-load effects then take over. Guarded so it runs
  // a single time per navigation.
  const [navConsumed, setNavConsumed] = useState(false);
  useEffect(() => {
    if (navConsumed || !navState || loadingServers) return;
    const sid = navState.serverId != null ? String(navState.serverId) : '';
    if (!sid) { setNavConsumed(true); return; }

    const spots = Array.isArray(navState.highlightSpots) ? navState.highlightSpots : [];
    const mobIds = [...new Set(spots.map((s) => s.mob_id).filter((m) => m != null))];

    setServerId(sid);
    if (navState.zoneNo != null) setPendingZone(String(navState.zoneNo));
    setHighlightSpots(spots);
    if (mobIds.length) {
      setSelectedMobs(new Set(mobIds));
      setFocusMob(mobIds[0]);
    }
    setNavConsumed(true);
  }, [navConsumed, navState, loadingServers]);

  // Once zones for the focus mob include the pending (deep-linked) zone, force it.
  useEffect(() => {
    if (!pendingZone) return;
    if (zones.includes(parseInt(pendingZone, 10))) {
      setZoneNo(pendingZone);
      setPendingZone('');
    }
  }, [pendingZone, zones]);

  // ── Mobs (catalog search, debounced) ──────────────────────────────────────
  useEffect(() => {
    if (!serverId) { setMobs([]); return; }
    let alive = true;
    setLoadingMobs(true);
    const t = setTimeout(() => {
      worldApi.mobs(serverId, mobQuery.trim() || undefined)
        .then((r) => { if (alive) setMobs(r.data || []); })
        .catch(() => { if (alive) setMobs([]); })
        .finally(() => { if (alive) setLoadingMobs(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [serverId, mobQuery]);

  // Reset downstream selections whenever the server changes (manual pick).
  const onServerChange = (id) => {
    setServerId(id);
    setMobQuery(''); setMobs([]); setSelectedMobs(new Set()); setFocusMob(null);
    setZones([]); setZoneNo(''); setClusters([]); setBounds(null);
    setMapError('');
    // A manual server pick drops any deep-link highlight/pending zone.
    setHighlightSpots([]); setPendingZone('');
  };

  const mobName = useCallback(
    (id) => mobs.find((m) => m.mob_id === id)?.name || `#${id}`,
    [mobs],
  );

  const toggleMob = (id) => {
    setSelectedMobs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    // Focus mob (for zone derivation) = the first still-selected mob.
    setFocusMob((prev) => {
      if (prev === id) return null; // was toggled off
      return prev ?? id;
    });
  };

  // ── Derive zones for the focus mob via /mobs/:id/spawns ────────────────────
  useEffect(() => {
    if (!serverId || focusMob == null) { setZones([]); setZoneNo(''); return; }
    let alive = true;
    setLoadingZones(true);
    worldApi.mobSpawns(serverId, focusMob)
      .then((r) => {
        if (!alive) return;
        const zs = Object.keys(r.zones || {}).map((z) => parseInt(z, 10))
          .filter(Number.isFinite).sort((a, b) => a - b);
        setZones(zs);
        setZoneNo((prev) => (zs.includes(parseInt(prev, 10)) ? prev : (zs.length ? String(zs[0]) : '')));
      })
      .catch(() => { if (alive) { setZones([]); setZoneNo(''); } })
      .finally(() => { if (alive) setLoadingZones(false); });
    return () => { alive = false; };
  }, [serverId, focusMob]);

  // ── Load the map for the selected mobs in the zone + bounds ────────────────
  // All-Time (version=all) → 8-neighbour CLUSTERS (packs). Latest (version=latest)
  // → newest-revision per-cell spots from the versioned spawns read, normalised
  // into the same {center_x/z, min/max, hits…} shape so one renderer serves both.
  useEffect(() => {
    if (!serverId || !zoneNo || selectedMobs.size === 0) {
      setClusters([]); setBounds(null); return;
    }
    let alive = true;
    setLoadingMap(true);
    setMapError('');
    const mobIds = [...selectedMobs];

    // Zone bounds are additive/optional — a 404 just means we auto-fit.
    // The route returns { data: <row> }, so unwrap to the row here.
    const boundsP = worldApi.zoneBounds(serverId, zoneNo)
      .then((r) => r?.data ?? null).catch(() => null);

    let dataP;
    if (version === 'all') {
      // Connected-cell packs per mob (clusters require a mob_id server-side).
      dataP = Promise.all(mobIds.map((mid) =>
        worldApi.zoneClusters(serverId, zoneNo, { mob_id: mid })
          .then((r) => (r.data || []).map((c) => ({ ...c, mob_id: mid })))
          .catch(() => []),
      )).then((lists) => lists.flat());
    } else {
      // Newest-revision per-cell spots → wrap each cell as a single-cell pack.
      dataP = Promise.all(mobIds.map((mid) =>
        worldApi.zoneSpawns(serverId, zoneNo, { version: 'latest', mob_id: mid })
          .then((r) => (r.data || []).map((s) => ({
            mob_id: mid,
            cells: 1,
            center_x: s.cell_x, center_z: s.cell_z,
            min_x: s.cell_x, max_x: s.cell_x, min_z: s.cell_z, max_z: s.cell_z,
            hits: s.hits, passes: s.passes, instance_sum: s.instance_sum,
            reliability: s.reliability, typical_group: s.typical_group,
            density_score: s.density_score, y_avg: s.y_avg,
            last_seen_sec: s.last_seen_sec,
          })))
          .catch(() => []),
      )).then((lists) => lists.flat());
    }

    Promise.all([dataP, boundsP])
      .then(([cl, bd]) => {
        if (!alive) return;
        setClusters(cl);
        setBounds(bd && bd.origin_x !== undefined ? bd : null);
      })
      .catch((e) => { if (alive) setMapError(e.data?.error || e.message || 'Failed to load map'); })
      .finally(() => { if (alive) setLoadingMap(false); });
    return () => { alive = false; };
  }, [serverId, zoneNo, version, selectedMobs]);

  // When the (server, zone) target changes, re-arm the background layer: assume it
  // may exist and let <image onError> decide, and restore the default-ON toggle.
  useEffect(() => {
    setBgAvailable(false);
    setBgEnabled(true);
  }, [serverId, zoneNo]);

  // ── Coordinate framing ─────────────────────────────────────────────────────
  // Prefer zone_bounds (origin + world_min/max). Cluster centres are in CELL
  // units; world = origin + cell*4. If no bounds, auto-fit the cluster extent.
  // Low-confidence filter: drop seen-once (hits<=1) or near-zero-reliability spots
  // when the toggle is on. Applied before framing so render + auto-fit + counts agree.
  const visibleClusters = useMemo(() => {
    if (!hideSeenOnce) return clusters;
    return clusters.filter(
      (c) => (c.hits ?? 0) > 1 && (c.reliability ?? 0) >= RELIABILITY_MIN,
    );
  }, [clusters, hideSeenOnce]);

  const frame = useMemo(() => {
    if (!visibleClusters.length) return null;

    // World-space cluster points (metres).
    const pts = visibleClusters.map((c) => {
      const wx = bounds ? bounds.origin_x + c.center_x * CELL_M : c.center_x * CELL_M;
      const wz = bounds ? bounds.origin_z + c.center_z * CELL_M : c.center_z * CELL_M;
      // radius in metres from the cell bounding box (half-diagonal, min 1 cell).
      const spanX = (c.max_x - c.min_x + 1) * CELL_M;
      const spanZ = (c.max_z - c.min_z + 1) * CELL_M;
      const r = Math.max(CELL_M, Math.sqrt(spanX * spanX + spanZ * spanZ) / 2);
      return { c, wx, wz, r };
    });

    let minX, maxX, minZ, maxZ;
    if (bounds && bounds.world_min_x !== undefined) {
      minX = bounds.world_min_x; maxX = bounds.world_max_x;
      minZ = bounds.world_min_z; maxZ = bounds.world_max_z;
    } else {
      minX = Math.min(...pts.map((p) => p.wx - p.r));
      maxX = Math.max(...pts.map((p) => p.wx + p.r));
      minZ = Math.min(...pts.map((p) => p.wz - p.r));
      maxZ = Math.max(...pts.map((p) => p.wz + p.r));
    }
    const wSpan = Math.max(1, maxX - minX);
    const hSpan = Math.max(1, maxZ - minZ);
    // Uniform scale to keep the aspect ratio (square-ish game zones).
    const scale = Math.min((SVG_W - 2 * PAD) / wSpan, (SVG_H - 2 * PAD) / hSpan);
    const offX = PAD + ((SVG_W - 2 * PAD) - wSpan * scale) / 2;
    const offZ = PAD + ((SVG_H - 2 * PAD) - hSpan * scale) / 2;

    const maxScore = Math.max(...pts.map((p) => p.c.density_score || 0), 0.0001);

    const nodes = pts.map((p) => ({
      c: p.c,
      cx: offX + (p.wx - minX) * scale,
      cy: offZ + (p.wz - minZ) * scale,
      r: Math.max(3, p.r * scale),
      t: (p.c.density_score || 0) / maxScore,
    }));
    return { nodes, minX, maxX, minZ, maxZ, scale, offX, offZ, hasBounds: !!bounds };
  }, [visibleClusters, bounds]);

  // Background <image> rectangle in SVG space, framing the full zone AABB with the
  // SAME world→SVG transform as the spawn points (so an uploaded bot-export image,
  // which frames exactly this AABB, aligns pixel-accurately). Only when bounds
  // expose the world_min/max corners; otherwise there is nothing to align to.
  const bgRect = useMemo(() => {
    if (!frame || !bounds || bounds.world_min_x === undefined) return null;
    const { scale, offX, offZ, minX, minZ } = frame;
    const x = offX + (bounds.world_min_x - minX) * scale;
    const y = offZ + (bounds.world_min_z - minZ) * scale;
    const width  = (bounds.world_max_x - bounds.world_min_x) * scale;
    const height = (bounds.world_max_z - bounds.world_min_z) * scale;
    if (!(width > 0) || !(height > 0)) return null;
    return { x, y, width, height };
  }, [frame, bounds]);

  const showBg = bgEnabled && bgAvailable && !!bgRect && !!serverId && !!zoneNo;

  // Deep-link highlight lookup: cell-key set of the session's renewed spots, so a
  // matching cluster node gets a distinct pulsing ring. Key = `${mob_id}|${cx}|${cz}`
  // (mob-scoped); cluster centres round to the nearest cell for a tolerant match.
  const highlightKeys = useMemo(() => {
    const set = new Set();
    for (const s of highlightSpots) {
      if (s == null || s.center_x == null || s.center_z == null) continue;
      const cx = Math.round(s.center_x), cz = Math.round(s.center_z);
      set.add(`${s.mob_id ?? ''}|${cx}|${cz}`); // mob-scoped
      set.add(`|${cx}|${cz}`);                  // mob-agnostic cell fallback
    }
    return set;
  }, [highlightSpots]);

  const isHighlighted = useCallback((c) => {
    if (highlightKeys.size === 0) return false;
    const cx = Math.round(c.center_x);
    const cz = Math.round(c.center_z);
    // Match mob-scoped first, then fall back to any-mob at that cell (clusters may
    // pack neighbouring cells so an exact centre can drift by a cell).
    return highlightKeys.has(`${c.mob_id ?? ''}|${cx}|${cz}`)
        || highlightKeys.has(`|${cx}|${cz}`);
  }, [highlightKeys]);

  const serverLabel = (s) => s.name || `Server #${s.id}`;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>Monster Map</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Where monsters spawn, by server and zone. Pick a server and one or more mobs to
        plot their spawn clusters — hotter colours mean higher density.
      </Typography>

      {topError && <Alert severity="error" sx={{ mb: 2 }}>{topError}</Alert>}

      {highlightSpots.length > 0 && (
        <Alert
          severity="info" sx={{ mb: 2 }}
          onClose={() => { setHighlightSpots([]); setPendingZone(''); }}
        >
          {highlightSpots.length} spot(s) from the selected session are highlighted
          {navState?.versionId != null ? ` (Session ${navState.versionId})` : ''}.
        </Alert>
      )}

      {/* Top controls */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={5}>
          <TextField
            select fullWidth size="small" label="Server"
            value={serverId} onChange={(e) => onServerChange(e.target.value)}
            disabled={loadingServers}
            helperText={loadingServers ? 'Loading…' : (servers.length ? '' : 'No public servers')}
          >
            {servers.map((s) => (
              <MenuItem key={s.id} value={String(s.id)}>{serverLabel(s)}</MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid item xs={6} sm={4}>
          <TextField
            select fullWidth size="small" label="Zone"
            value={zoneNo} onChange={(e) => setZoneNo(e.target.value)}
            disabled={!zones.length}
            helperText={loadingZones ? 'Deriving…' : (focusMob == null ? 'Select a mob' : (zones.length ? '' : 'No zones'))}
          >
            {zones.map((z) => <MenuItem key={z} value={String(z)}>Zone {z}</MenuItem>)}
          </TextField>
        </Grid>
        <Grid item xs={6} sm={3}>
          <ToggleButtonGroup
            size="small" exclusive value={version}
            onChange={(_, v) => { if (v) setVersion(v); }}
            sx={{ height: '100%' }}
          >
            <ToggleButton value="latest">Latest</ToggleButton>
            <ToggleButton value="all">All-Time</ToggleButton>
          </ToggleButtonGroup>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* Mob checklist */}
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 1.5, height: SVG_H, display: 'flex', flexDirection: 'column' }}>
            <TextField
              size="small" fullWidth placeholder="Search mobs (name or id)"
              value={mobQuery} onChange={(e) => setMobQuery(e.target.value)}
              disabled={!serverId}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              sx={{ mb: 1 }}
            />
            <Divider sx={{ mb: 0.5 }} />
            <Box sx={{ flex: 1, overflowY: 'auto' }}>
              {!serverId && <Typography variant="caption" color="text.disabled" sx={{ p: 1, display: 'block' }}>Select a server first.</Typography>}
              {serverId && loadingMobs && <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={20} /></Box>}
              {serverId && !loadingMobs && mobs.length === 0 && (
                <Typography variant="caption" color="text.disabled" sx={{ p: 1, display: 'block' }}>No mobs found.</Typography>
              )}
              <List dense disablePadding>
                {mobs.map((m) => (
                  <ListItem key={m.mob_id} disablePadding>
                    <ListItemButton dense onClick={() => toggleMob(m.mob_id)} sx={{ py: 0 }}>
                      <Checkbox edge="start" size="small" checked={selectedMobs.has(m.mob_id)} tabIndex={-1} disableRipple />
                      <ListItemText
                        primary={m.name || `Mob #${m.mob_id}`}
                        secondary={`#${m.mob_id}${m.level_min != null ? ` · Lv ${m.level_min}${m.level_max && m.level_max !== m.level_min ? `-${m.level_max}` : ''}` : ''} · ${m.sightings_total ?? 0} seen`}
                        primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                        secondaryTypographyProps={{ variant: 'caption' }}
                      />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </Box>
            {selectedMobs.size > 0 && (
              <Box sx={{ pt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {[...selectedMobs].map((id) => (
                  <Chip key={id} size="small" label={mobName(id)} onDelete={() => toggleMob(id)} />
                ))}
              </Box>
            )}
          </Paper>
        </Grid>

        {/* SVG map */}
        <Grid item xs={12} md={8}>
          <Paper variant="outlined" sx={{ p: 1.5, position: 'relative', minHeight: SVG_H }}>
            {mapError && <Alert severity="error" sx={{ mb: 1 }}>{mapError}</Alert>}

            {loadingMap && (
              <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, bgcolor: 'rgba(0,0,0,0.15)' }}>
                <CircularProgress size={28} />
              </Box>
            )}

            {!serverId && emptyHint('Pick a server to begin.')}
            {serverId && selectedMobs.size === 0 && emptyHint('Select one or more mobs from the list.')}
            {serverId && selectedMobs.size > 0 && !zoneNo && !loadingZones && emptyHint('No zone data for the selected mob(s).')}
            {serverId && selectedMobs.size > 0 && zoneNo && !loadingMap && clusters.length === 0 && emptyHint('No spawn clusters for this selection.')}
            {serverId && selectedMobs.size > 0 && zoneNo && !loadingMap && clusters.length > 0 && visibleClusters.length === 0 && emptyHint('All spawns hidden by the "Hide seen-once" filter.')}

            {frame && (
              <Box sx={{ position: 'relative' }}>
                <svg
                  viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                  width="100%"
                  style={{ display: 'block', background: 'rgba(255,255,255,0.02)', borderRadius: 4, aspectRatio: '1 / 1' }}
                  onMouseLeave={() => setHover(null)}
                >
                  <style>{`
                    @keyframes mmHighlightPulse {
                      0%   { stroke-opacity: 0.95; stroke-width: 2.5; }
                      50%  { stroke-opacity: 0.35; stroke-width: 4; }
                      100% { stroke-opacity: 0.95; stroke-width: 2.5; }
                    }
                    .mm-highlight-ring { animation: mmHighlightPulse 1.4s ease-in-out infinite; }
                  `}</style>
                  {/* background image layer — FIRST child so it sits UNDER the
                      spawn points; framed to the zone AABB. Always mounted (when a
                      bgRect exists) so onLoad/onError can resolve availability, but
                      only painted when confirmed available and the toggle is ON. */}
                  {bgRect && serverId && zoneNo && (
                    <image
                      href={worldApi.zoneMapUrl(serverId, zoneNo)}
                      x={bgRect.x} y={bgRect.y} width={bgRect.width} height={bgRect.height}
                      preserveAspectRatio="none"
                      opacity={showBg ? 1 : 0}
                      style={{ pointerEvents: 'none' }}
                      onLoad={() => setBgAvailable(true)}
                      onError={() => setBgAvailable(false)}
                    />
                  )}
                  {/* frame border */}
                  <rect x={PAD / 2} y={PAD / 2} width={SVG_W - PAD} height={SVG_H - PAD}
                    fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" rx="4" />
                  {frame.nodes.map((n, i) => {
                    const hl = isHighlighted(n.c);
                    return (
                      <g key={`${n.c.mob_id}-${i}`}>
                        <circle
                          cx={n.cx} cy={n.cy} r={n.r}
                          fill={heatColor(n.t)}
                          fillOpacity={0.55}
                          stroke={heatColor(n.t)}
                          strokeOpacity={0.9}
                          strokeWidth={1}
                          onMouseEnter={() => setHover({ n, mobName: mobName(n.c.mob_id) })}
                        />
                        {hl && (
                          <circle
                            cx={n.cx} cy={n.cy} r={n.r + 4}
                            fill="none"
                            stroke="#fff"
                            strokeWidth={2.5}
                            strokeOpacity={0.95}
                            className="mm-highlight-ring"
                            style={{ pointerEvents: 'none' }}
                          />
                        )}
                      </g>
                    );
                  })}
                </svg>

                {/* legend */}
                <Box sx={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'rgba(0,0,0,0.35)', px: 1, py: 0.5, borderRadius: 1 }}>
                  <Typography variant="caption" color="text.secondary">Low</Typography>
                  <Box sx={{ width: 90, height: 8, borderRadius: 1, background: 'linear-gradient(90deg, rgb(33,102,172), rgb(90,174,97), rgb(244,165,66), rgb(214,47,39))' }} />
                  <Typography variant="caption" color="text.secondary">High</Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ ml: 1 }}>
                    {frame.hasBounds ? 'zone-framed' : 'auto-fit'}
                  </Typography>
                  <FormControlLabel
                    sx={{ ml: 0.5, mr: 0 }}
                    control={
                      <Switch
                        size="small" checked={hideSeenOnce}
                        onChange={(e) => setHideSeenOnce(e.target.checked)}
                      />
                    }
                    label={<Typography variant="caption" color="text.secondary">Hide seen-once</Typography>}
                  />
                  {bgRect && bgAvailable && (
                    <FormControlLabel
                      sx={{ ml: 0.5, mr: 0 }}
                      control={
                        <Switch
                          size="small" checked={bgEnabled}
                          onChange={(e) => setBgEnabled(e.target.checked)}
                        />
                      }
                      label={<Typography variant="caption" color="text.secondary">Background</Typography>}
                    />
                  )}
                </Box>

                {/* hover tooltip */}
                {hover && (
                  <Paper elevation={4} sx={{ position: 'absolute', top: 8, right: 8, p: 1, maxWidth: 240, pointerEvents: 'none' }}>
                    <Typography variant="subtitle2" noWrap>{hover.mobName}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Group ≈ {Number(hover.n.c.typical_group || 0).toFixed(1)} · {hover.n.c.cells} cell(s)
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Reliability {(Number(hover.n.c.reliability || 0) * 100).toFixed(0)}% · density {Number(hover.n.c.density_score || 0).toFixed(2)}
                    </Typography>
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                      seen ×{hover.n.c.hits} · last {timeAgo(hover.n.c.last_seen_sec)}
                    </Typography>
                  </Paper>
                )}
              </Box>
            )}

            {frame && (
              <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                {visibleClusters.length} cluster(s) · zone {zoneNo}
                {version === 'latest' ? ' · newest revision' : ' · all-time'}
                {hideSeenOnce && clusters.length > visibleClusters.length
                  ? ` · ${clusters.length - visibleClusters.length} low-confidence hidden` : ''}
              </Typography>
            )}
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}

function emptyHint(text) {
  return (
    <Box sx={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Typography variant="body2" color="text.disabled">{text}</Typography>
    </Box>
  );
}
