import { Paper, Typography, Skeleton, Alert, Box } from '@mui/material';
import { MonsterMapView } from '../../portal/MonsterMap.jsx';

// The admin Map tab (P4). Embeds the user-facing monster map as an ADMIN preview of
// a single server: the server picker is hidden and the server id is fixed to this
// detail page's server, so the embed renders exactly what a user would see for this
// server — including HIDDEN servers, which the per-server read endpoints expose to
// admins (only the servers-list picker is visibility-gated, and it is hidden here).
//
// The zone picker is driven by the coverage overview's zone list (so DATALESS zones
// are still selectable to preview a just-uploaded background/bounds), bare zones
// render the background + bounds frame, and the parent `nonce` cache-busts the
// background after an upload. `initialZone` lands a "Preview on map" / coverage
// zone-name click on the pre-selected zone.
export default function MapTab({ server, overview, loading, nonce, initialZone, onOpenTab }) { // eslint-disable-line no-unused-vars
  // Still resolving the server row → skeleton (matches the other tabs' loading UX).
  if (loading && !server) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Skeleton variant="text" width="45%" height={28} sx={{ mb: 1 }} />
        <Skeleton variant="rectangular" height={420} sx={{ borderRadius: 1.5 }} />
      </Paper>
    );
  }

  // No server row (shouldn't happen — the detail shell handles not-found first).
  if (!server) {
    return (
      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No server to preview.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2 } }}>
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 0.25 }}>
          Map preview
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Previews this server exactly as users would see it on the public Monster Map,
          including hidden servers (admin-only). Pick a zone and one or more mobs to
          plot spawn clusters; dataless zones still preview their background.
        </Typography>
      </Box>

      {overview == null && (
        <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
          Coverage overview unavailable — no zones to list for this preview yet. Try
          refreshing the detail page.
        </Alert>
      )}

      <MonsterMapView
        showServerPicker={false}
        serverId={String(server.id)}
        zoneList={overview?.zones || []}
        allowBareZone
        nonce={nonce}
        initialZone={initialZone}
      />
    </Paper>
  );
}
