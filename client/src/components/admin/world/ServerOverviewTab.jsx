import { Stack } from '@mui/material';
import SetupCompletenessCard from './SetupCompletenessCard.jsx';
import CoverageMatrix from './CoverageMatrix.jsx';

// The Overview tab body (P2): the setup-completeness centrepiece stacked above the
// per-zone coverage matrix. Consumes the shared tab props
// { server, overview, loading, refetch, bumpNonce } plus onOpenTab (route push).
// Zone-name clicks deep-link the Map tab (for P2 that is just onOpenTab('map')).
export default function ServerOverviewTab({ server, overview, loading, refetch, bumpNonce, onOpenTab }) {
  return (
    <Stack spacing={2.5}>
      <SetupCompletenessCard
        server={server}
        overview={overview}
        loading={loading}
        refetch={refetch}
        onOpenTab={onOpenTab}
      />
      <CoverageMatrix
        server={server}
        overview={overview}
        loading={loading}
        refetch={refetch}
        bumpNonce={bumpNonce}
        onOpenZoneMap={(zoneNo) => onOpenTab?.('map', zoneNo)}
      />
    </Stack>
  );
}
