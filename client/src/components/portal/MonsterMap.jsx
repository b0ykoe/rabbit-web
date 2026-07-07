import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Box, Typography, Paper, Grid, MenuItem, TextField, ToggleButtonGroup,
  ToggleButton, CircularProgress, Alert, Chip, List, ListItem, ListItemButton,
  ListItemText, Checkbox, Divider, InputAdornment, FormControlLabel, Switch,
  IconButton, Tooltip, Stack, Collapse, Button, useMediaQuery, useTheme,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { worldApi } from '../../api/endpoints.js';

// ─────────────────────────────────────────────────────────────────────────────
// Monster Map — user-facing read view over /api/portal/world.
//
// Flow: pick a (visible) SERVER → pick a MOB (catalog search) → we derive the
// ZONES that mob appears in via /mobs/:id/spawns, pick a zone, then render the
// zone's CLUSTERS (8-neighbour packs) as an SVG heat map. A cell is 4 m; world =
// origin + cell*4, framed by /zones/:z/bounds when present (else auto-fit).
// Controls: version (latest / all-time) and a mob checklist filter.
//
// The view body lives in MonsterMapView, an exported inner component with opt-in
// props so an admin embed can drive it (controlled server, an explicit zone list,
// a bare-zone background preview, cache-bust nonce, initial zone). Every prop
// defaults to EXACTLY the user-facing behaviour, and the default export is a thin
// shell that renders MonsterMapView with no props — byte-for-byte identical.
// ─────────────────────────────────────────────────────────────────────────────

const CELL_M = 4;          // metres per cell (fixed by ingest quantisation)
const SVG_W = 640;
const SVG_H = 640;
const PAD = 24;            // inner padding inside the viewport
const MIN_VIEW = SVG_W / 12;                        // smallest viewBox width = max zoom-in (~12x)
const FULL_VIEW = { x: 0, y: 0, w: SVG_W, h: SVG_H };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

// The extracted view body. All props default to the current user-facing behaviour.
//   serverId (prop):   when non-null → controlled server id (picker + deep-link off);
//                      null → internal server state + picker + deep-link (default).
//   showServerPicker:  false → hide the server <TextField select> (default true).
//   zoneList:          [{ zone_no, name }] → the zone picker lists these directly
//                      (dataless zones selectable); null → mob-derived (default).
//   allowBareZone:     true → render the SVG + background + bounds frame even when a
//                      zone has no clusters; false → the empty-hint (default).
//   nonce:             when set → append ?v=<nonce> to the zone map URL (cache-bust).
//   initialZone:       when set (with zoneList) → preselect that zone on mount/change.
export function MonsterMapView({
  serverId: serverIdProp = null,
  showServerPicker = true,
  zoneList = null,
  allowBareZone = false,
  nonce = null,
  initialZone = null,
} = {}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Controlled-server mode: the parent owns the server id (admin embed). In that
  // mode we skip the internal server-select state, the picker, and the deep-link
  // seeding entirely — the server is fixed to serverIdProp.
  const controlledServer = serverIdProp != null;
  // The zone picker lists explicit zones (dataless included) when a list is given.
  const zonesProvided = Array.isArray(zoneList);
  // The deep-link path is user-only: active only for the default (uncontrolled +
  // picker) configuration, exactly as before.
  const deepLinkActive = !controlledServer && showServerPicker;

  const [servers, setServers]   = useState([]);
  const [serverIdState, setServerIdState] = useState('');
  const [loadingServers, setLoadingServers] = useState(true);
  const [topError, setTopError] = useState('');

  // The effective server id: the controlled prop when provided, else internal state.
  const serverId = controlledServer ? String(serverIdProp) : serverIdState;

  // Reference name lists (bot-exported) for the selected server, keyed by string
  // id → real name. Prefer these over the mob_catalog / "Zone N" fallbacks.
  const [zoneNames, setZoneNames] = useState({}); // { "<zone_no>": "<name>" }
  const [mobNames, setMobNames]   = useState({}); // { "<mob_id>":  "<name>" }

  const [mobQuery, setMobQuery] = useState('');
  const [mobs, setMobs]         = useState([]);
  const [loadingMobs, setLoadingMobs] = useState(false);
  const [selectedMobs, setSelectedMobs] = useState(new Set()); // mob_id checklist
  const [focusMob, setFocusMob] = useState(null);              // mob used for zone derivation

  const [version, setVersion]   = useState('latest');          // 'latest' | 'all'

  const [zonesState, setZonesState] = useState([]);            // [zone_no,...] (mob-derived)
  const [zoneNo, setZoneNo]     = useState('');
  const [loadingZones, setLoadingZones] = useState(false);

  const [clusters, setClusters] = useState([]);                // rendered packs
  const [bounds, setBounds]     = useState(null);              // zone_bounds row or null
  const [loadingMap, setLoadingMap] = useState(false);
  const [mapError, setMapError] = useState('');
  const [hover, setHover]       = useState(null);              // { c, mobName }

  // The zone-picker option list: the explicit prop list (as zone_no ints) when
  // provided, else the mob-derived zones. Kept as numbers to preserve equality/
  // membership checks used throughout (parseInt compares, includes, etc.).
  const zones = useMemo(() => {
    if (zonesProvided) {
      return (zoneList || [])
        .map((z) => parseInt(z?.zone_no, 10))
        .filter(Number.isFinite);
    }
    return zonesState;
  }, [zonesProvided, zoneList, zonesState]);

  // Zone display names: prefer the bot-exported names map, then the explicit
  // zoneList name (admin embed passes real names), then "Zone N".
  const zoneListNameById = useMemo(() => {
    const m = {};
    if (zonesProvided) {
      for (const z of (zoneList || [])) {
        const n = parseInt(z?.zone_no, 10);
        if (Number.isFinite(n) && z?.name) m[n] = z.name;
      }
    }
    return m;
  }, [zonesProvided, zoneList]);
  const zoneLabel = useCallback(
    (z) => zoneNames[z] || zoneListNameById[z] || `Zone ${z}`,
    [zoneNames, zoneListNameById],
  );

  // Optional per-(server,zone) background image, drawn UNDER the spawn points and
  // framed to the zone AABB. bgAvailable flips false on a 404/decode error (onError)
  // so we silently fall back to the coordinate-space render — never a broken image.
  const [bgAvailable, setBgAvailable] = useState(false);
  const [bgEnabled, setBgEnabled]     = useState(true);       // user toggle, ON by default

  // Hide low-confidence spots (seen once / near-zero reliability) from the render
  // and the auto-fit framing. OFF by default so nothing is hidden implicitly.
  const [hideSeenOnce, setHideSeenOnce] = useState(false);
  const RELIABILITY_MIN = 0.15;             // small threshold below which a spot is "unreliable"

  // Mobile-only: the mob checklist collapses to save vertical space. Default open
  // when nothing is selected yet; auto-collapse once a mob is picked so the map
  // takes the screen. Desktop ignores this (list always shown).
  const [mobListOpen, setMobListOpen] = useState(true);

  // ── Deep-link from a recording session ("Show on map") ─────────────────────
  // WorldSessions navigates here with react-router state
  //   { serverId, zoneNo, versionId, highlightSpots:[{center_x,center_z,mob_id}] }.
  // We preselect that server, seed the highlighted mob(s) so the zone derives and
  // the clusters load, force the zone, and remember the spots to ring on the map.
  // No state → nothing happens; existing behaviour is untouched. Deep-linking is
  // only active on the default/user path (deepLinkActive).
  const location = useLocation();
  const navState = deepLinkActive ? (location.state || null) : null;
  const [highlightSpots, setHighlightSpots] = useState([]); // [{center_x,center_z,mob_id}]
  const [pendingZone, setPendingZone]       = useState(''); // zone to force once derived

  // ── Servers (visible only) ────────────────────────────────────────────────
  // Only the uncontrolled path fetches/holds the server list (the picker needs it).
  // A controlled embed skips this entirely — the server is fixed by the parent.
  useEffect(() => {
    if (controlledServer) { setLoadingServers(false); return; }
    let alive = true;
    setLoadingServers(true);
    worldApi.servers()
      .then((r) => { if (!alive) return; setServers(r.data || []); })
      .catch((e) => { if (alive) setTopError(e.data?.error || e.message || 'Failed to load servers'); })
      .finally(() => { if (alive) setLoadingServers(false); });
    return () => { alive = false; };
  }, [controlledServer]);

  // Consume the deep-link state ONCE (after servers load so the server id is a
  // valid picker option). Seed server + highlighted mobs + pending zone; the
  // normal zone-derivation / map-load effects then take over. Guarded so it runs
  // a single time per navigation. Only runs on the default/user path.
  const [navConsumed, setNavConsumed] = useState(false);
  useEffect(() => {
    if (!deepLinkActive) return;
    if (navConsumed || !navState || loadingServers) return;
    const sid = navState.serverId != null ? String(navState.serverId) : '';
    if (!sid) { setNavConsumed(true); return; }

    const spots = Array.isArray(navState.highlightSpots) ? navState.highlightSpots : [];
    const mobIds = [...new Set(spots.map((s) => s.mob_id).filter((m) => m != null))];

    setServerIdState(sid);
    if (navState.zoneNo != null) setPendingZone(String(navState.zoneNo));
    setHighlightSpots(spots);
    if (mobIds.length) {
      setSelectedMobs(new Set(mobIds));
      setFocusMob(mobIds[0]);
    }
    setNavConsumed(true);
  }, [deepLinkActive, navConsumed, navState, loadingServers]);

  // Once zones for the focus mob include the pending (deep-linked) zone, force it.
  useEffect(() => {
    if (!pendingZone) return;
    if (zones.includes(parseInt(pendingZone, 10))) {
      setZoneNo(pendingZone);
      setPendingZone('');
    }
  }, [pendingZone, zones]);

  // ── Reference name lists for the selected server ───────────────────────────
  // Additive/optional — a failure just leaves the maps empty and the pickers fall
  // back to "Zone N" / the mob_catalog name.
  useEffect(() => {
    if (!serverId) { setZoneNames({}); setMobNames({}); return; }
    let alive = true;
    worldApi.names(serverId)
      .then((r) => {
        if (!alive) return;
        setZoneNames(r?.zones || {});
        setMobNames(r?.mobs || {});
      })
      .catch(() => { if (alive) { setZoneNames({}); setMobNames({}); } });
    return () => { alive = false; };
  }, [serverId]);

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
    setServerIdState(id);
    setMobQuery(''); setMobs([]); setSelectedMobs(new Set()); setFocusMob(null);
    setZonesState([]); setZoneNo(''); setClusters([]); setBounds(null);
    setZoneNames({}); setMobNames({});
    setMapError('');
    // A manual server pick drops any deep-link highlight/pending zone.
    setHighlightSpots([]); setPendingZone('');
  };

  const mobName = useCallback(
    (id) => mobNames[id]
      || mobs.find((m) => m.mob_id === id)?.name
      || `Mob #${id}`,
    [mobNames, mobs],
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

  // Mobile: keep the mob list expanded while nothing is chosen, and collapse it
  // once a selection exists so the map gets the screen. No-op on desktop.
  useEffect(() => {
    if (!isMobile) return;
    setMobListOpen(selectedMobs.size === 0);
  }, [isMobile, selectedMobs.size]);

  // ── Derive zones for the focus mob via /mobs/:id/spawns ────────────────────
  // Skipped when an explicit zoneList is supplied (the picker lists those directly),
  // so a dataless zone stays selectable and the mob checklist only filters clusters.
  useEffect(() => {
    if (zonesProvided) return;
    if (!serverId || focusMob == null) { setZonesState([]); setZoneNo(''); return; }
    let alive = true;
    setLoadingZones(true);
    worldApi.mobSpawns(serverId, focusMob)
      .then((r) => {
        if (!alive) return;
        const zs = Object.keys(r.zones || {}).map((z) => parseInt(z, 10))
          .filter(Number.isFinite).sort((a, b) => a - b);
        setZonesState(zs);
        setZoneNo((prev) => (zs.includes(parseInt(prev, 10)) ? prev : (zs.length ? String(zs[0]) : '')));
      })
      .catch(() => { if (alive) { setZonesState([]); setZoneNo(''); } })
      .finally(() => { if (alive) setLoadingZones(false); });
    return () => { alive = false; };
  }, [zonesProvided, serverId, focusMob]);

  // ── Preselect an initial zone (admin embed) ────────────────────────────────
  // When an explicit zone list is provided and an initialZone is given, select it
  // on mount and whenever it changes (e.g. a "Preview on map" hand-off), as long as
  // it is one of the listed zones.
  useEffect(() => {
    if (!zonesProvided || initialZone == null) return;
    const target = parseInt(initialZone, 10);
    if (!Number.isFinite(target)) return;
    if (zones.includes(target)) setZoneNo(String(target));
  }, [zonesProvided, initialZone, zones]);

  // ── Load the map for the selected mobs in the zone + bounds ────────────────
  // All-Time (version=all) → 8-neighbour CLUSTERS (packs). Latest (version=latest)
  // → newest-revision per-cell spots from the versioned spawns read, normalised
  // into the same {center_x/z, min/max, hits…} shape so one renderer serves both.
  useEffect(() => {
    if (!serverId || !zoneNo || selectedMobs.size === 0) {
      setClusters([]); setBounds(null);
      // In bare-zone mode we still want the zone's bounds so the fallback frame can
      // render the background even with no mob selected. Fetch bounds standalone.
      if (allowBareZone && serverId && zoneNo) {
        let alive = true;
        setMapError('');
        worldApi.zoneBounds(serverId, zoneNo)
          .then((r) => { if (alive) setBounds(r?.data && r.data.origin_x !== undefined ? r.data : null); })
          .catch(() => { if (alive) setBounds(null); });
        return () => { alive = false; };
      }
      return;
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
  }, [serverId, zoneNo, version, selectedMobs, allowBareZone]);

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

  // ── Bare-zone fallback frame ───────────────────────────────────────────────
  // When allowBareZone is on and there are no clusters to fit, synthesise a frame
  // from the zone bounds (if present) so the background image + a bounds outline
  // still render. Uses the SAME world→SVG transform math as the cluster frame, with
  // no nodes. Falls back to a neutral SVG-space frame when bounds are absent.
  const bareFrame = useMemo(() => {
    if (!allowBareZone || frame || !serverId || !zoneNo) return null;
    if (bounds && bounds.world_min_x !== undefined) {
      const minX = bounds.world_min_x, maxX = bounds.world_max_x;
      const minZ = bounds.world_min_z, maxZ = bounds.world_max_z;
      const wSpan = Math.max(1, maxX - minX);
      const hSpan = Math.max(1, maxZ - minZ);
      const scale = Math.min((SVG_W - 2 * PAD) / wSpan, (SVG_H - 2 * PAD) / hSpan);
      const offX = PAD + ((SVG_W - 2 * PAD) - wSpan * scale) / 2;
      const offZ = PAD + ((SVG_H - 2 * PAD) - hSpan * scale) / 2;
      return { nodes: [], minX, maxX, minZ, maxZ, scale, offX, offZ, hasBounds: true };
    }
    // Neutral default 640 frame in SVG space (world = SVG coords 1:1).
    return {
      nodes: [],
      minX: PAD, maxX: SVG_W - PAD, minZ: PAD, maxZ: SVG_H - PAD,
      scale: 1, offX: 0, offZ: 0, hasBounds: false,
    };
  }, [allowBareZone, frame, serverId, zoneNo, bounds]);

  // The effective frame used by the background rect, the SVG panel and bookkeeping.
  // In bare-zone mode this is the synthetic frame; otherwise the cluster frame.
  const activeFrame = frame || bareFrame;

  // ── Pan / zoom (interactive SVG viewBox) ──────────────────────────────────
  // Everything is drawn in a fixed SVG_W×SVG_H space; we make the viewBox stateful
  // so the wheel zooms toward the cursor, drag pans, and reset re-fits the frame.
  const [view, setView] = useState(FULL_VIEW);
  const [grabbing, setGrabbing] = useState(false);
  const svgElRef = useRef(null);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const dragRef = useRef(null);

  // Re-fit to the full frame whenever the map subject changes.
  useEffect(() => { setView(FULL_VIEW); }, [serverId, zoneNo, version]);
  const resetView = useCallback(() => setView(FULL_VIEW), []);

  // Zoom by a factor (<1 = in) about a point in SVG coords (default = view centre).
  const zoomAt = useCallback((factor, sx, sy) => {
    const v = viewRef.current;
    const cx = sx == null ? v.x + v.w / 2 : sx;
    const cy = sy == null ? v.y + v.h / 2 : sy;
    const nw = clamp(v.w * factor, MIN_VIEW, SVG_W);
    const nh = nw; // square viewport (SVG_W === SVG_H)
    let nx = cx - (cx - v.x) * (nw / v.w);
    let ny = cy - (cy - v.y) * (nh / v.h);
    nx = clamp(nx, 0, SVG_W - nw);
    ny = clamp(ny, 0, SVG_H - nh);
    setView({ x: nx, y: ny, w: nw, h: nh });
  }, []);
  const zoomBy = useCallback((factor) => zoomAt(factor, null, null), [zoomAt]);

  // Native, NON-passive wheel listener (React binds onWheel passive, so
  // preventDefault would be a no-op there and the page would scroll).
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const el = svgElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const v = viewRef.current;
    const sx = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
    const sy = v.y + ((e.clientY - rect.top) / rect.height) * v.h;
    zoomAt(e.deltaY < 0 ? 0.85 : 1 / 0.85, sx, sy);
  }, [zoomAt]);
  const setSvgRef = useCallback((node) => {
    if (svgElRef.current) svgElRef.current.removeEventListener('wheel', handleWheel);
    svgElRef.current = node;
    if (node) node.addEventListener('wheel', handleWheel, { passive: false });
  }, [handleWheel]);

  const onPointerDown = useCallback((e) => {
    dragRef.current = { px: e.clientX, py: e.clientY, view: viewRef.current };
    setGrabbing(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);
  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    const el = svgElRef.current;
    if (!d || !el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = ((e.clientX - d.px) / rect.width) * d.view.w;
    const dy = ((e.clientY - d.py) / rect.height) * d.view.h;
    setView({
      w: d.view.w, h: d.view.h,
      x: clamp(d.view.x - dx, 0, SVG_W - d.view.w),
      y: clamp(d.view.y - dy, 0, SVG_H - d.view.h),
    });
  }, []);
  const onPointerUp = useCallback((e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setGrabbing(false);
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
  }, []);

  // Background <image> rectangle in SVG space, framing the full zone extent with the
  // SAME world→SVG transform as the spawn points (so an uploaded bot-export image
  // aligns pixel-accurately). Two cases:
  //  • bounds present  → frame to the zone AABB (framed:true), as before.
  //  • bounds absent   → frame to the whole auto-fit cluster extent (framed:false),
  //    i.e. the full [minX..maxX]×[minZ..maxZ] the spawn points were fit into. This
  //    lets an uploaded background render even without zone_bounds (bug-fix: it used
  //    to bail out and the image never appeared).
  // Uses activeFrame so the bare-zone fallback frame also gets a background rect.
  const bgRect = useMemo(() => {
    if (!activeFrame) return null;
    const { scale, offX, offZ, minX, minZ, maxX, maxZ } = activeFrame;

    let x, y, width, height, framed;
    if (bounds && bounds.world_min_x !== undefined) {
      x = offX + (bounds.world_min_x - minX) * scale;
      y = offZ + (bounds.world_min_z - minZ) * scale;
      width  = (bounds.world_max_x - bounds.world_min_x) * scale;
      height = (bounds.world_max_z - bounds.world_min_z) * scale;
      framed = true;
    } else {
      // Auto-fit: the whole extent the cluster points were framed into.
      x = offX;
      y = offZ;
      width  = (maxX - minX) * scale;
      height = (maxZ - minZ) * scale;
      framed = false;
    }
    if (!(width > 0) || !(height > 0)) return null;
    return { x, y, width, height, framed };
  }, [activeFrame, bounds]);

  const showBg = bgEnabled && bgAvailable && !!bgRect && !!serverId && !!zoneNo;

  // Zone background URL — with an optional cache-bust nonce so a just-uploaded
  // background/bounds busts the max-age=60 cache in the admin embed.
  const zoneMapHref = useMemo(() => {
    if (!serverId || !zoneNo) return null;
    const base = worldApi.zoneMapUrl(serverId, zoneNo);
    return nonce != null ? `${base}?v=${nonce}` : base;
  }, [serverId, zoneNo, nonce]);

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

  // Auto-zoom + centre on the deep-linked highlighted spot(s) — once per highlight
  // (guarded by a key so later frame recomputes or the user's own pan/zoom don't
  // yank the view back). Fires after the clusters load (frame ready).
  const autoZoomedRef = useRef('');
  useEffect(() => {
    if (!frame || highlightSpots.length === 0) return;
    const hlNodes = frame.nodes.filter((n) => isHighlighted(n.c));
    if (!hlNodes.length) return;
    const key = `${serverId}|${zoneNo}|${version}|` +
      highlightSpots.map((s) => `${s.mob_id}:${s.center_x}:${s.center_z}`).join(',');
    if (autoZoomedRef.current === key) return;
    autoZoomedRef.current = key;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of hlNodes) {
      minX = Math.min(minX, n.cx - n.r); maxX = Math.max(maxX, n.cx + n.r);
      minY = Math.min(minY, n.cy - n.r); maxY = Math.max(maxY, n.cy + n.r);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY) + 80; // padding around the spot(s)
    const nw = clamp(Math.max(span, SVG_W / 6), MIN_VIEW, SVG_W);
    setView({
      w: nw, h: nw,
      x: clamp(cx - nw / 2, 0, SVG_W - nw),
      y: clamp(cy - nw / 2, 0, SVG_H - nw),
    });
  }, [frame, highlightSpots, isHighlighted, serverId, zoneNo, version]);

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
        {showServerPicker && (
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
        )}
        <Grid item xs={12} sm={showServerPicker ? 4 : 8}>
          <TextField
            select fullWidth size="small" label="Zone"
            value={zoneNo} onChange={(e) => setZoneNo(e.target.value)}
            disabled={!zones.length}
            helperText={loadingZones ? 'Deriving…' : (!zonesProvided && focusMob == null ? 'Select a mob' : (zones.length ? '' : 'No zones'))}
          >
            {zones.map((z) => (
              <MenuItem key={z} value={String(z)}>{zoneLabel(z)}</MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid item xs={12} sm={3}>
          <ToggleButtonGroup
            size="small" exclusive value={version}
            onChange={(_, v) => { if (v) setVersion(v); }}
            sx={{ height: '100%', width: '100%', '& .MuiToggleButton-root': { flex: 1 } }}
          >
            <ToggleButton value="latest">Latest</ToggleButton>
            <ToggleButton value="all">All-Time</ToggleButton>
          </ToggleButtonGroup>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        {/* Mob checklist */}
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 1.5, height: { xs: 320, md: SVG_H }, display: 'flex', flexDirection: 'column' }}>
            <TextField
              size="small" fullWidth placeholder="Search mobs (name or id)"
              value={mobQuery} onChange={(e) => setMobQuery(e.target.value)}
              disabled={!serverId}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              sx={{ mb: 1 }}
            />
            {isMobile && (
              <Button
                size="small" variant="text" fullWidth onClick={() => setMobListOpen((o) => !o)}
                sx={{ mb: 0.5, justifyContent: 'space-between', textTransform: 'none' }}
              >
                {mobListOpen ? 'Hide mobs' : `Mobs (${selectedMobs.size} selected)`}
              </Button>
            )}
            <Collapse
              in={!isMobile || mobListOpen}
              sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column',
                    '& .MuiCollapse-wrapper': { flex: 1, minHeight: 0 },
                    '& .MuiCollapse-wrapperInner': { display: 'flex', flexDirection: 'column', height: '100%' } }}
            >
              <Divider sx={{ mb: 0.5 }} />
              <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
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
                          primary={mobNames[m.mob_id] || m.name || `Mob #${m.mob_id}`}
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
            </Collapse>
          </Paper>
        </Grid>

        {/* SVG map */}
        <Grid item xs={12} md={8}>
          <Paper variant="outlined" sx={{ p: { xs: 1, md: 1.5 }, position: 'relative', minHeight: { xs: 'auto', md: SVG_H } }}>
            {mapError && <Alert severity="error" sx={{ mb: 1 }}>{mapError}</Alert>}

            {loadingMap && (
              <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, bgcolor: 'rgba(0,0,0,0.15)' }}>
                <CircularProgress size={28} />
              </Box>
            )}

            {!serverId && emptyHint('Pick a server to begin.')}
            {serverId && selectedMobs.size === 0 && !(allowBareZone && zoneNo) && emptyHint('Select one or more mobs from the list.')}
            {serverId && selectedMobs.size > 0 && !zoneNo && !loadingZones && emptyHint('No zone data for the selected mob(s).')}
            {serverId && selectedMobs.size > 0 && zoneNo && !loadingMap && clusters.length === 0 && !allowBareZone && emptyHint('No spawn clusters for this selection.')}
            {serverId && selectedMobs.size > 0 && zoneNo && !loadingMap && clusters.length > 0 && visibleClusters.length === 0 && emptyHint('All spawns hidden by the "Hide seen-once" filter.')}

            {activeFrame && (
              <Box sx={{ position: 'relative' }}>
                {/* Toolbar row — view toggles pulled out of the legend pill so the
                    legend can shrink to just the heat scale. */}
                <Stack direction="row" flexWrap="wrap" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
                  <FormControlLabel
                    sx={{ mr: 0 }}
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
                      sx={{ mr: 0 }}
                      control={
                        <Switch
                          size="small" checked={bgEnabled}
                          onChange={(e) => setBgEnabled(e.target.checked)}
                        />
                      }
                      label={<Typography variant="caption" color="text.secondary">Background</Typography>}
                    />
                  )}
                </Stack>
                {/* Zoom / pan controls (wheel = zoom-to-cursor, drag = pan). */}
                <Paper elevation={3} sx={{ position: 'absolute', top: 40, right: 8, zIndex: 3, p: 0.25 }}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    <Tooltip title="Zoom in" placement="left"><IconButton size="small" onClick={() => zoomBy(0.7)}><ZoomInIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Zoom out" placement="left"><IconButton size="small" onClick={() => zoomBy(1 / 0.7)}><ZoomOutIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Reset view" placement="left"><IconButton size="small" onClick={resetView}><RestartAltIcon fontSize="small" /></IconButton></Tooltip>
                  </Box>
                </Paper>
                <svg
                  ref={setSvgRef}
                  viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                  width="100%"
                  style={{ display: 'block', background: 'rgba(255,255,255,0.02)', borderRadius: 4, aspectRatio: '1 / 1', cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'none' }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={(e) => { onPointerUp(e); setHover(null); }}
                >
                  <style>{`
                    @keyframes mmHighlightPulse {
                      0%, 100% { stroke-opacity: 0.95; }
                      50%      { stroke-opacity: 0.2; }
                    }
                    .mm-highlight-ring { animation: mmHighlightPulse 1.3s ease-in-out infinite; }
                  `}</style>
                  <defs>
                    <filter id="mmDot">
                      <feDropShadow dx="0" dy="0" stdDeviation="1.5" floodColor="#000" floodOpacity="0.6" />
                    </filter>
                  </defs>
                  {/* background image layer — FIRST child so it sits UNDER the
                      spawn points; framed to the zone AABB. Always mounted (when a
                      bgRect exists) so onLoad/onError can resolve availability, but
                      only painted when confirmed available and the toggle is ON. */}
                  {bgRect && serverId && zoneNo && zoneMapHref && (
                    <image
                      href={zoneMapHref}
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
                  {/* base heat markers — three stacked rings (black outline + white
                      separator + heat fill) so every point reads on any background.
                      Drop-shadow only when the background image is painted. */}
                  {activeFrame.nodes.map((n, i) => (
                    <g key={`${n.c.mob_id}-${i}`} filter={showBg ? 'url(#mmDot)' : undefined}>
                      <circle
                        cx={n.cx} cy={n.cy} r={n.r}
                        fill="none" stroke="#000" strokeOpacity={0.85} strokeWidth={3}
                        vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }}
                      />
                      <circle
                        cx={n.cx} cy={n.cy} r={n.r}
                        fill="none" stroke="#fff" strokeOpacity={0.55} strokeWidth={1.25}
                        vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }}
                      />
                      <circle
                        cx={n.cx} cy={n.cy} r={n.r}
                        fill={heatColor(n.t)} fillOpacity={0.72}
                        onMouseEnter={() => setHover({ n, mobName: mobName(n.c.mob_id) })}
                      />
                    </g>
                  ))}
                  {/* highlight pass — drawn AFTER all base circles so it's on top.
                      Black halo + bright inner ring (reads on any background) +
                      a screen-constant floating label (name + #mob_id). */}
                  {activeFrame.nodes.filter((n) => isHighlighted(n.c)).map((n, i) => {
                    const ls = view.w / SVG_W;                 // screen-constant scale
                    const label = `${mobName(n.c.mob_id)} · #${n.c.mob_id}`;
                    const fontPx = 11, padPx = 5;
                    const wPx = label.length * (fontPx * 0.58) + padPx * 2;
                    const hPx = fontPx + padPx * 2;
                    const by = n.cy - n.r - (7 + hPx) * ls;
                    return (
                      <g key={`hl-${n.c.mob_id}-${i}`} style={{ pointerEvents: 'none' }}>
                        <circle cx={n.cx} cy={n.cy} r={n.r + 6} fill="none"
                          stroke="#000" strokeWidth={6} strokeOpacity={0.9}
                          vectorEffect="non-scaling-stroke" />
                        <circle cx={n.cx} cy={n.cy} r={n.r + 6} fill="none"
                          stroke="#ffd54a" strokeWidth={3.5} strokeOpacity={0.95}
                          vectorEffect="non-scaling-stroke" className="mm-highlight-ring" />
                        <rect x={n.cx - (wPx * ls) / 2} y={by} width={wPx * ls} height={hPx * ls}
                          rx={3 * ls} fill="rgba(0,0,0,0.82)" stroke="#000" strokeWidth={1.5}
                          vectorEffect="non-scaling-stroke" />
                        <text x={n.cx} y={by + (hPx * ls) / 2} textAnchor="middle"
                          dominantBaseline="central" fontSize={fontPx * ls} fill="#fff"
                          fontWeight={600}>{label}</text>
                      </g>
                    );
                  })}
                </svg>

                {/* legend — heat scale only (view toggles live in the toolbar row) */}
                <Box sx={{ position: 'absolute', bottom: 8, left: 8, maxWidth: 160, bgcolor: 'rgba(0,0,0,0.55)', px: 1, py: 0.5, borderRadius: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">Low</Typography>
                    <Box sx={{ flex: 1, minWidth: 60, height: 8, borderRadius: 1, background: 'linear-gradient(90deg, rgb(33,102,172), rgb(90,174,97), rgb(244,165,66), rgb(214,47,39))' }} />
                    <Typography variant="caption" color="text.secondary">High</Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    Color = spawn density
                  </Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                    {activeFrame.hasBounds ? 'zone-framed' : 'auto-fit'}
                  </Typography>
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

// User-facing default export: a thin shell over MonsterMapView with no props, so it
// is byte-for-byte behaviour-identical to the pre-refactor component.
export default function MonsterMap() {
  return <MonsterMapView />;
}

function emptyHint(text) {
  return (
    <Box sx={{ minHeight: { xs: 240, md: 400 }, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Typography variant="body2" color="text.disabled">{text}</Typography>
    </Box>
  );
}
