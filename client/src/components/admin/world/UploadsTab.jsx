import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box, Stack, Alert, Chip, Paper, Typography, TextField, Switch,
  FormControlLabel, InputAdornment, Skeleton,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { adminApi } from '../../../api/endpoints.js';
import NamesCard from './NamesCard.jsx';
import ZoneAssetCard from './ZoneAssetCard.jsx';

// One missing-* chip: amber when >0, success when 0.
function MissingChip({ label, count }) {
  const missing = count > 0;
  return (
    <Chip
      size="small"
      color={missing ? 'warning' : 'success'}
      variant={missing ? 'outlined' : 'filled'}
      label={missing ? `${count} ${label}` : `${label}: all set`}
      sx={{ height: 22 }}
    />
  );
}

// The unified Uploads tab (P3). Brings together the server-level names import and
// the per-zone background + bounds uploads. A single listZoneMaps(server.id) fetch
// supplies the per-zone background meta (format/size/dims), keyed by zone_no and
// re-run whenever the parent bumps `nonce` (i.e. after any upload/delete).
export default function UploadsTab({ server, overview, loading, refetch, bumpNonce, onOpenTab }) {
  const [maps, setMaps]       = useState(null);   // Map<zone_no, meta> | null
  const [query, setQuery]     = useState('');
  const [hideComplete, setHideComplete] = useState(false);

  const serverId = server?.id;

  const zones  = overview?.zones || [];
  const counts = overview?.counts || {};

  // Fetch per-zone background meta. Best-effort — a failure just leaves cards
  // without size/format detail (the overview flags still drive the status dots).
  const loadMaps = useCallback(async () => {
    if (!serverId) return;
    try {
      const res = await adminApi.listZoneMaps(serverId);
      const m = new Map();
      for (const row of (res?.data || [])) {
        if (row?.image) m.set(row.zone_no, row.image);
      }
      setMaps(m);
    } catch {
      setMaps(new Map()); // degrade gracefully; don't block the tab
    }
  }, [serverId]);

  useEffect(() => { loadMaps(); }, [loadMaps]);

  // After a zone upload/delete the child calls bumpNonce (parent state) + refetch.
  // Re-pull the map meta too so format/size stay in sync. We chain both here.
  const afterZoneChange = useCallback(() => {
    bumpNonce?.();
    loadMaps();
  }, [bumpNonce, loadMaps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return zones.filter((z) => {
      if (hideComplete && z.has_bounds && z.has_background) return false;
      if (!q) return true;
      const name = (z.name || '').toLowerCase();
      return String(z.zone_no).includes(q) || name.includes(q);
    });
  }, [zones, query, hideComplete]);

  const missing = {
    name:       counts.missing_name ?? 0,
    background: counts.missing_background ?? 0,
    data:       counts.missing_data ?? 0,
    bounds:     counts.missing_bounds ?? 0,
  };
  const allSet = !(missing.name || missing.background || missing.data || missing.bounds);

  return (
    <Stack spacing={2.5}>
      {/* Persistent, non-dismissible provenance note. */}
      <Alert severity="info">
        Files come from the bot's Exporter tab: <strong>names.json</strong>,{' '}
        <strong>zone_&lt;N&gt;_&lt;size&gt;.png</strong>,{' '}
        <strong>zone_&lt;N&gt;_calib.json</strong>.
      </Alert>

      {/* Missing-* rollup banner. */}
      <Stack direction="row" spacing={0.75} flexWrap="wrap" sx={{ rowGap: 0.75, alignItems: 'center' }}>
        {allSet ? (
          <Chip size="small" color="success" variant="filled" label="All assets in place" sx={{ height: 22 }} />
        ) : (
          <>
            <MissingChip label="unnamed" count={missing.name} />
            <MissingChip label="no background" count={missing.background} />
            <MissingChip label="no bounds" count={missing.bounds} />
            <MissingChip label="no spawn data" count={missing.data} />
          </>
        )}
      </Stack>

      {/* Server-level names import. */}
      <NamesCard server={server} refetch={refetch} />

      {/* Per-zone assets. */}
      <Box>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ mb: 1.5, alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
        >
          <Typography variant="subtitle1" fontWeight={700}>Per-zone assets</Typography>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
            <TextField
              size="small"
              placeholder="Search zone # or name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ minWidth: 220 }}
            />
            <FormControlLabel
              control={<Switch size="small" checked={hideComplete} onChange={(e) => setHideComplete(e.target.checked)} />}
              label={<Typography variant="body2">Hide complete</Typography>}
            />
          </Stack>
        </Stack>

        {loading && !overview ? (
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
            }}
          >
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} variant="rectangular" height={190} sx={{ borderRadius: 1.5 }} />
            ))}
          </Box>
        ) : zones.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              No zones yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Import a reference name list above to seed zones, or grant a recording key
              so a bot starts collecting spawns. Per-zone background &amp; bounds uploads
              appear here once a zone exists.
            </Typography>
          </Paper>
        ) : filtered.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              {hideComplete ? 'Every matching zone is fully covered.' : 'No zones match your search.'}
            </Typography>
          </Paper>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
            }}
          >
            {filtered.map((z) => (
              <ZoneAssetCard
                key={z.zone_no}
                server={server}
                zone={z}
                mapMeta={maps?.get(z.zone_no) || null}
                refetch={refetch}
                bumpNonce={afterZoneChange}
                onPreview={(zoneNo) => onOpenTab?.('map', zoneNo)}
              />
            ))}
          </Box>
        )}
      </Box>
    </Stack>
  );
}
