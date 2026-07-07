import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Paper, Grid, MenuItem, TextField, Chip, Alert,
  CircularProgress, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Button, Divider, Collapse, IconButton, Tooltip,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import MapIcon from '@mui/icons-material/Map';
import { worldApi } from '../../api/endpoints.js';
import { useAuth } from '../../context/AuthContext.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// Recording Sessions — ADMIN-ONLY read view over the spawn-recording endpoints.
// (Routed under /admin/recording-sessions, super-admin only; the server also
// gates the underlying session-list/coverage/diff/detail endpoints.)
//
// Pick a (visible) SERVER, then see:
//   (a) SESSIONS table   — version windows (worldApi.sessions)
//   (b) COVERAGE panel   — per-zone scan freshness heat list (worldApi.coverage)
//   (c) VERSION-DIFF     — pick a zone + two version_ids → worldApi.diff
// All additive GETs; loading / empty / error states handled per-panel.
// ─────────────────────────────────────────────────────────────────────────────

function humanizeTime(sec) {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString();
}

function timeAgo(sec) {
  if (!sec) return '—';
  const s = Math.floor(Date.now() / 1000) - sec;
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Green (fresh) → amber → red (stale) heat by last-scan age, for the coverage list.
function freshnessColor(sec) {
  if (!sec) return 'text.disabled';
  const ageH = (Math.floor(Date.now() / 1000) - sec) / 3600;
  if (ageH < 24)  return 'success.main';
  if (ageH < 168) return 'warning.main';
  return 'error.main';
}

const serverLabel = (s) => s.name || `Server #${s.id}`;

export default function WorldSessions() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  const [servers, setServers]   = useState([]);
  const [serverId, setServerId] = useState('');
  const [loadingServers, setLoadingServers] = useState(true);
  const [topError, setTopError] = useState('');

  // Which session row is expanded (key = `${version_id}|${zone_no}`); one at a time.
  const [expandedKey, setExpandedKey] = useState(null);

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState('');

  // Coverage
  const [coverage, setCoverage] = useState([]);
  const [loadingCoverage, setLoadingCoverage] = useState(false);
  const [coverageError, setCoverageError] = useState('');

  // Diff
  const [diffZone, setDiffZone] = useState('');
  const [diffA, setDiffA]       = useState('');
  const [diffB, setDiffB]       = useState('');
  const [diff, setDiff]         = useState(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState('');

  // ── Servers (visible only) ────────────────────────────────────────────────
  // Gated on isSuperAdmin so a non-super-admin that somehow mounts this (the
  // route + server-side 403 already block it) never fires the fetches.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    let alive = true;
    setLoadingServers(true);
    worldApi.servers()
      .then((r) => { if (alive) setServers(r.data || []); })
      .catch((e) => { if (alive) setTopError(e.data?.error || e.message || 'Failed to load servers'); })
      .finally(() => { if (alive) setLoadingServers(false); });
    return () => { alive = false; };
  }, [isSuperAdmin]);

  const onServerChange = (id) => {
    setServerId(id);
    setExpandedKey(null);
    setSessions([]); setSessionsError('');
    setCoverage([]); setCoverageError('');
    setDiffZone(''); setDiffA(''); setDiffB(''); setDiff(null); setDiffError('');
  };

  // Open the Monster Map focused on what this session (or a single spot) renewed.
  // Contract: react-router state { serverId, zoneNo, versionId, highlightSpots }.
  // highlightSpots = [{ center_x, center_z, mob_id }]; MonsterMap highlights them.
  const showOnMap = (zoneNo, versionId, highlightSpots = []) => {
    navigate('/portal/world', {
      state: {
        serverId: String(serverId),
        zoneNo: String(zoneNo),
        versionId: String(versionId),
        highlightSpots,
      },
    });
  };

  // ── Sessions for the server ───────────────────────────────────────────────
  useEffect(() => {
    if (!isSuperAdmin || !serverId) { setSessions([]); return undefined; }
    let alive = true;
    setLoadingSessions(true);
    setSessionsError('');
    worldApi.sessions(serverId, { limit: 100 })
      .then((r) => { if (alive) setSessions(r.data || []); })
      .catch((e) => { if (alive) setSessionsError(e.data?.error || e.message || 'Failed to load sessions'); })
      .finally(() => { if (alive) setLoadingSessions(false); });
    return () => { alive = false; };
  }, [serverId, isSuperAdmin]);

  // ── Coverage for the server ───────────────────────────────────────────────
  useEffect(() => {
    if (!isSuperAdmin || !serverId) { setCoverage([]); return undefined; }
    let alive = true;
    setLoadingCoverage(true);
    setCoverageError('');
    worldApi.coverage(serverId)
      .then((r) => { if (alive) setCoverage(r.data || []); })
      .catch((e) => { if (alive) setCoverageError(e.data?.error || e.message || 'Failed to load coverage'); })
      .finally(() => { if (alive) setLoadingCoverage(false); });
    return () => { alive = false; };
  }, [serverId, isSuperAdmin]);

  // Zones that appear in the sessions list (for the diff zone picker).
  const diffZones = useMemo(() => {
    const set = new Set();
    for (const s of sessions) if (s.zone_no != null) set.add(s.zone_no);
    return [...set].sort((a, b) => a - b);
  }, [sessions]);

  // Version ids available for the picked diff zone (from the sessions list).
  const zoneVersions = useMemo(() => {
    if (diffZone === '') return [];
    return sessions
      .filter((s) => String(s.zone_no) === String(diffZone))
      .map((s) => ({ id: s.version_id, start: s.ver_start_sec, current: s.is_current }));
  }, [sessions, diffZone]);

  // Reset the version selections whenever the diff zone changes.
  useEffect(() => { setDiffA(''); setDiffB(''); setDiff(null); setDiffError(''); }, [diffZone]);

  const runDiff = () => {
    if (!serverId || diffZone === '' || !diffA || !diffB) return;
    let alive = true;
    setLoadingDiff(true);
    setDiffError('');
    setDiff(null);
    worldApi.diff(serverId, diffZone, { a: diffA, b: diffB })
      .then((r) => { if (alive) setDiff(r || null); })
      .catch((e) => { if (alive) setDiffError(e.data?.error || e.message || 'Failed to load diff'); })
      .finally(() => { if (alive) setLoadingDiff(false); });
    // no cleanup needed — button-triggered, not effect-driven
  };

  const hasRecordedBy = sessions.some((s) => s.recorded_by != null);

  // Defense-in-depth: this view is routed super-admin only, but guard here too so
  // it never renders (or fires its GETs) for a non-super-admin who reaches it.
  if (!isSuperAdmin) {
    return <Alert severity="warning">Recording sessions are super-admin only.</Alert>;
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} sx={{ mb: 0.5 }}>Recording Sessions</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Scan windows recorded per zone, per-zone coverage freshness, and a version-to-version
        diff of a zone's spawn snapshots.
      </Typography>

      {topError && <Alert severity="error" sx={{ mb: 2 }}>{topError}</Alert>}

      {/* Server picker */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
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
      </Grid>

      {!serverId && (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <Typography color="text.disabled">Pick a server to view its recording sessions.</Typography>
        </Paper>
      )}

      {serverId && (
        <Grid container spacing={2}>
          {/* (a) Sessions table */}
          <Grid item xs={12} md={8}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Sessions</Typography>
              {sessionsError && <Alert severity="error" sx={{ mb: 1 }}>{sessionsError}</Alert>}
              {loadingSessions ? (
                <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>
              ) : sessions.length === 0 ? (
                <Typography variant="body2" color="text.disabled" sx={{ p: 2 }}>
                  No recording sessions for this server yet.
                </Typography>
              ) : (
                <TableContainer sx={{ maxHeight: 520 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: 36 }} />
                        <TableCell>Session</TableCell>
                        <TableCell>When</TableCell>
                        <TableCell>Zone</TableCell>
                        <TableCell>Renewed</TableCell>
                        <TableCell>Mobs</TableCell>
                        {hasRecordedBy && <TableCell>Recorded by</TableCell>}
                        <TableCell align="right">Map</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {sessions.map((s, i) => {
                        const rowKey = `${s.version_id}|${s.zone_no}`;
                        const isOpen = expandedKey === rowKey;
                        // colSpan = fixed columns + optional recorded-by column.
                        const colSpan = 7 + (hasRecordedBy ? 1 : 0);
                        return (
                        <React.Fragment key={`${s.version_id}-${s.zone_no}-${i}`}>
                        <TableRow hover sx={{ '& > *': { borderBottom: isOpen ? 'unset' : undefined } }}>
                          <TableCell sx={{ pr: 0 }}>
                            <IconButton
                              size="small"
                              aria-label={isOpen ? 'Hide details' : 'Show details'}
                              onClick={() => setExpandedKey(isOpen ? null : rowKey)}
                            >
                              {isOpen ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                              <Typography variant="body2" fontFamily="monospace" fontWeight={600}>
                                {s.version_id}
                              </Typography>
                              {s.is_current && (
                                <Chip label="CURRENT" size="small" color="success" variant="outlined"
                                  sx={{ height: 18, fontSize: '0.6rem' }} />
                              )}
                            </Box>
                            <Typography variant="caption" color="text.disabled">
                              {timeAgo(s.ver_start_sec)}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              {humanizeTime(s.ver_start_sec)}
                            </Typography>
                            <Typography variant="caption" color="text.disabled">
                              → {s.ver_end_sec ? humanizeTime(s.ver_end_sec) : 'ongoing'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">Zone {s.zone_no}</Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" color="text.secondary">
                              {s.renewed_spots ?? 0} / {s.total_hits ?? 0}
                            </Typography>
                            <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                              {s.run_count ?? 0} run(s)
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">{s.distinct_mobs ?? 0}</Typography>
                          </TableCell>
                          {hasRecordedBy && (
                            <TableCell>
                              <Typography variant="caption" color="text.disabled">
                                {s.recorded_by ?? '—'}
                              </Typography>
                            </TableCell>
                          )}
                          <TableCell align="right">
                            <Tooltip title="Show on map">
                              <IconButton
                                size="small" color="primary"
                                aria-label="Show on map"
                                onClick={() => showOnMap(s.zone_no, s.version_id)}
                              >
                                <MapIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell colSpan={colSpan} sx={{ py: 0, borderBottom: isOpen ? undefined : 'none' }}>
                            <Collapse in={isOpen} timeout="auto" unmountOnExit>
                              {isOpen && (
                                <SessionDetail
                                  serverId={serverId}
                                  zoneNo={s.zone_no}
                                  versionId={s.version_id}
                                  onShowOnMap={showOnMap}
                                />
                              )}
                            </Collapse>
                          </TableCell>
                        </TableRow>
                        </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>
          </Grid>

          {/* (b) Coverage heat list */}
          <Grid item xs={12} md={4}>
            <Paper variant="outlined" sx={{ p: 1.5, height: '100%' }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Coverage</Typography>
              {coverageError && <Alert severity="error" sx={{ mb: 1 }}>{coverageError}</Alert>}
              {loadingCoverage ? (
                <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={24} /></Box>
              ) : coverage.length === 0 ? (
                <Typography variant="body2" color="text.disabled" sx={{ p: 2 }}>
                  No coverage data yet.
                </Typography>
              ) : (
                <Box sx={{ maxHeight: 520, overflowY: 'auto' }}>
                  {[...coverage]
                    .sort((a, b) => (b.last_scanned || 0) - (a.last_scanned || 0))
                    .map((z) => (
                      <Box key={z.zone_no} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.75, borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 'none' } }}>
                        <FiberDot color={freshnessColor(z.last_scanned)} />
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Typography variant="body2" fontWeight={600}>Zone {z.zone_no}</Typography>
                          <Typography variant="caption" color="text.disabled">
                            {timeAgo(z.last_scanned)} · {z.version_count ?? 0} ver
                            {z.total_renewed_spots != null ? ` · ${z.total_renewed_spots} spots` : ''}
                            {z.has_bounds ? ' · framed' : ''}
                          </Typography>
                        </Box>
                      </Box>
                    ))}
                </Box>
              )}
            </Paper>
          </Grid>

          {/* (c) Version diff */}
          <Grid item xs={12}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Version diff</Typography>
              <Grid container spacing={2} sx={{ mb: 1 }}>
                <Grid item xs={12} sm={3}>
                  <TextField
                    select fullWidth size="small" label="Zone"
                    value={diffZone} onChange={(e) => setDiffZone(e.target.value)}
                    disabled={diffZones.length === 0}
                    helperText={diffZones.length === 0 ? 'No zones' : ''}
                  >
                    {diffZones.map((z) => <MenuItem key={z} value={String(z)}>Zone {z}</MenuItem>)}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    select fullWidth size="small" label="Version A"
                    value={diffA} onChange={(e) => setDiffA(e.target.value)}
                    disabled={zoneVersions.length === 0}
                  >
                    {zoneVersions.map((v) => (
                      <MenuItem key={v.id} value={String(v.id)}>
                        {v.id}{v.current ? ' (current)' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    select fullWidth size="small" label="Version B"
                    value={diffB} onChange={(e) => setDiffB(e.target.value)}
                    disabled={zoneVersions.length === 0}
                  >
                    {zoneVersions.map((v) => (
                      <MenuItem key={v.id} value={String(v.id)}>
                        {v.id}{v.current ? ' (current)' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3} sx={{ display: 'flex', alignItems: 'center' }}>
                  <Button
                    fullWidth variant="contained" size="medium"
                    onClick={runDiff}
                    disabled={diffZone === '' || !diffA || !diffB || diffA === diffB || loadingDiff}
                  >
                    {loadingDiff ? 'Comparing…' : 'Compare'}
                  </Button>
                </Grid>
              </Grid>

              {diffError && <Alert severity="error" sx={{ mb: 1 }}>{diffError}</Alert>}

              {diff && (
                <Box>
                  <Divider sx={{ my: 1 }} />
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                    <Chip label={`+${diff.counts?.added ?? 0} added`} size="small" color="success" variant="outlined" />
                    <Chip label={`−${diff.counts?.removed ?? 0} removed`} size="small" color="error" variant="outlined" />
                    <Chip label={`${diff.counts?.group_changed ?? 0} group changed`} size="small" color="warning" variant="outlined" />
                    <Chip label={`${diff.counts?.moved ?? 0} moved`} size="small" variant="outlined" />
                    <Chip label={`${diff.counts?.same ?? 0} same`} size="small" variant="outlined" />
                  </Box>

                  {(diff.data?.length ?? 0) === 0 ? (
                    <Typography variant="body2" color="text.disabled">No changes to list.</Typography>
                  ) : (
                    <TableContainer sx={{ maxHeight: 360 }}>
                      <Table size="small" stickyHeader>
                        <TableHead>
                          <TableRow>
                            <TableCell>Change</TableCell>
                            <TableCell>Mob</TableCell>
                            <TableCell>Cell</TableCell>
                            <TableCell>Group</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {diff.data.map((d, i) => (
                            <TableRow key={i} hover>
                              <TableCell>
                                <Chip
                                  label={d.change || d.kind || d.type || '—'}
                                  size="small" variant="outlined"
                                  sx={{ height: 18, fontSize: '0.6rem' }}
                                />
                              </TableCell>
                              <TableCell>
                                <Typography variant="caption">
                                  {d.mob_name || (d.mob_id != null ? `#${d.mob_id}` : '—')}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                                  {d.cell_x != null && d.cell_z != null ? `${d.cell_x},${d.cell_z}` : '—'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="caption" color="text.disabled">
                                  {d.typical_group != null ? Number(d.typical_group).toFixed(1) : '—'}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                  {diff.truncated && (
                    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                      List truncated — showing a capped subset of changes.
                    </Typography>
                  )}
                </Box>
              )}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}

// Small coloured status dot (sx color token), used by the coverage heat list.
function FiberDot({ color }) {
  return (
    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
  );
}

// Per-spot change badge (vs the previous session of the same zone).
//   new           → green  'New'
//   group_changed → amber  'Group changed'
//   same          → muted  'Unchanged'
function ChangeBadge({ change }) {
  const map = {
    new:           { label: 'New',            color: 'success' },
    group_changed: { label: 'Group changed',  color: 'warning' },
    same:          { label: 'Unchanged',      color: 'default' },
  };
  const cfg = map[change] || map.same;
  return (
    <Chip
      label={cfg.label} size="small"
      color={cfg.color === 'default' ? undefined : cfg.color}
      variant="outlined"
      sx={{ height: 18, fontSize: '0.6rem', ...(cfg.color === 'default' ? { color: 'text.disabled' } : {}) }}
    />
  );
}

// Expanded session detail — lazily fetches worldApi.sessionDetail on mount and
// renders per-MOB groups of renewed spots (center, group, hits, reliability) with
// a per-spot change badge, plus a compact "Changes vs. previous" summary.
// Own loading / empty / error states, contained inside the expanded row.
function SessionDetail({ serverId, zoneNo, versionId, onShowOnMap }) {
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setDetail(null);
    worldApi.sessionDetail(serverId, zoneNo, versionId)
      .then((r) => { if (alive) setDetail(r || null); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message || 'Failed to load session detail'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [serverId, zoneNo, versionId]);

  if (loading) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}><CircularProgress size={20} /></Box>
    );
  }
  if (error) {
    return <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>;
  }

  const mobs    = detail?.mobs || [];
  const summary = detail?.summary || {};
  const prevId  = detail?.prev_version_id;

  return (
    <Box sx={{ py: 1.5, pl: 1 }}>
      {/* Changes vs. previous — compact summary */}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
          Changes vs. previous:
        </Typography>
        <Chip label={`+${summary.added ?? 0} new`} size="small" color="success" variant="outlined" sx={{ height: 20 }} />
        <Chip label={`−${summary.removed ?? 0} removed`} size="small" color="error" variant="outlined" sx={{ height: 20 }} />
        <Chip label={`${summary.group_changed ?? 0} group changed`} size="small" color="warning" variant="outlined" sx={{ height: 20 }} />
        <Chip label={`${summary.same ?? 0} unchanged`} size="small" variant="outlined" sx={{ height: 20 }} />
        <Typography variant="caption" color="text.disabled" sx={{ ml: 0.5 }}>
          {prevId != null && prevId !== '' ? `Previous session: ${prevId}` : 'First session'}
        </Typography>
      </Box>

      {mobs.length === 0 ? (
        <Typography variant="body2" color="text.disabled" sx={{ p: 1 }}>
          This session renewed no spots.
        </Typography>
      ) : (
        mobs.map((mob) => (
          <Box key={mob.mob_id} sx={{ mb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Typography variant="body2" fontWeight={600}>
                {mob.mob_name || `#${mob.mob_id}`}
              </Typography>
              <Typography variant="caption" color="text.disabled">
                {mob.spot_count ?? (mob.spots?.length ?? 0)} Spot(s)
              </Typography>
            </Box>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Center</TableCell>
                    <TableCell>Group</TableCell>
                    <TableCell>Hits</TableCell>
                    <TableCell>Reliab.</TableCell>
                    <TableCell>Change</TableCell>
                    <TableCell align="right">Map</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(mob.spots || []).map((sp, j) => (
                    <TableRow key={j} hover>
                      <TableCell>
                        <Typography variant="caption" fontFamily="monospace" color="text.secondary">
                          {sp.center_x != null && sp.center_z != null ? `${sp.center_x}, ${sp.center_z}` : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.disabled">
                          {sp.typical_group != null ? Number(sp.typical_group).toFixed(1) : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.disabled">{sp.hits ?? 0}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.disabled">
                          {sp.reliability != null ? `${(Number(sp.reliability) * 100).toFixed(0)}%` : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell><ChangeBadge change={sp.change} /></TableCell>
                      <TableCell align="right">
                        <Tooltip title="Show this spot on the map">
                          <IconButton
                            size="small" color="primary"
                            aria-label="Show spot on map"
                            onClick={() => onShowOnMap(zoneNo, versionId, [{
                              // MonsterMap matches highlights against cluster nodes in
                              // CELL units, so send the raw cell centroid (cell_x/cell_z)
                              // — not the world-metre center_x/center_z which only agree
                              // with cell space when the zone has no bounds frame.
                              center_x: sp.cell_x ?? sp.center_x,
                              center_z: sp.cell_z ?? sp.center_z,
                              mob_id: mob.mob_id,
                            }])}
                          >
                            <MapIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        ))
      )}
    </Box>
  );
}
