import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Grid, Card, CardContent, Skeleton, Paper,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import KeyIcon from '@mui/icons-material/VpnKey';
import ConfirmationNumberIcon from '@mui/icons-material/ConfirmationNumber';
import { adminApi } from '../../../api/endpoints.js';
import { useApi } from '../../../hooks/useApi.js';
import ServerCard from './ServerCard.jsx';
import CreateServerDialog from './CreateServerDialog.jsx';
import GrantRecordingKeyDialog from './GrantRecordingKeyDialog.jsx';

// The /admin/world landing page: a responsive grid of server cards + a header
// with "New server", "Grant recording key" and an "Ingest tokens" link. One
// fetch of the admin server list; cards mutate via updateWorldServer /
// deleteWorldServer and call back to refetch.
export default function WorldServersPage() {
  const navigate = useNavigate();
  const { data, loading, refetch } = useApi(() => adminApi.getWorldServers(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [grantOpen, setGrantOpen]   = useState(false);

  const rows = data?.data || [];

  const handleCreated = (row) => {
    refetch();
    // Navigate into the freshly-created server's detail if the POST returned it.
    if (row?.id != null) navigate(`/admin/world/servers/${row.id}`);
  };

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Monster Map — Servers</Typography>
          <Typography variant="caption" color="text.secondary">
            Admin-defined game servers. Open one to manage its names, coverage, backgrounds and spawn data.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button
            size="small" variant="contained" startIcon={<AddIcon fontSize="small" />}
            onClick={() => setCreateOpen(true)}
          >
            New server
          </Button>
          <Button
            size="small" variant="outlined" startIcon={<KeyIcon fontSize="small" />}
            onClick={() => setGrantOpen(true)}
          >
            Grant recording key
          </Button>
          <Button
            size="small" variant="text" startIcon={<ConfirmationNumberIcon fontSize="small" />}
            onClick={() => navigate('/admin/world/tokens')}
          >
            Ingest tokens
          </Button>
        </Box>
      </Box>

      {/* Grid */}
      <Box sx={{ mt: 2 }}>
        {loading ? (
          <Grid container spacing={2}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Grid item xs={12} sm={6} lg={4} key={i}>
                <Card variant="outlined">
                  <CardContent>
                    <Skeleton variant="text" width="60%" height={32} />
                    <Skeleton variant="rounded" width={80} height={20} sx={{ mt: 1 }} />
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 2 }}>
                      <Skeleton variant="rounded" width={90} height={22} />
                      <Skeleton variant="rounded" width={90} height={22} />
                    </Box>
                    <Skeleton variant="text" width="40%" sx={{ mt: 2 }} />
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        ) : rows.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              No servers yet. Create one to start tracking its spawn data.
            </Typography>
            <Button
              variant="contained" startIcon={<AddIcon fontSize="small" />}
              onClick={() => setCreateOpen(true)}
            >
              New server
            </Button>
          </Paper>
        ) : (
          <Grid container spacing={2}>
            {rows.map((s) => (
              <Grid item xs={12} sm={6} lg={4} key={s.id}>
                <ServerCard server={s} onChanged={refetch} />
              </Grid>
            ))}
          </Grid>
        )}
      </Box>

      <CreateServerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      <GrantRecordingKeyDialog open={grantOpen} onClose={() => setGrantOpen(false)} />
    </Box>
  );
}
