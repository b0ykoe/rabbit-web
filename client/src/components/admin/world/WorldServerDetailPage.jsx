import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import { Box, Typography, Paper, Breadcrumbs, Link, IconButton, Tooltip } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

// STUB (P0): the per-server detail route. Reads :id (+ optional :tab) so create
// and card navigation resolve. P1 fleshes this out into the full tabbed detail
// (settings / names / coverage / backgrounds / recording).
export default function WorldServerDetailPage() {
  const { id, tab } = useParams();
  const navigate = useNavigate();

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Tooltip title="Back to servers">
          <IconButton size="small" onClick={() => navigate('/admin/world')}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Breadcrumbs aria-label="breadcrumb">
          <Link component={RouterLink} to="/admin/world" underline="hover" color="inherit">
            Monster Map
          </Link>
          <Typography color="text.primary">
            server #{id}{tab ? ` · ${tab}` : ''}
          </Typography>
        </Breadcrumbs>
      </Box>

      <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="body1" color="text.secondary">
          Server detail — full tabs land in the next phase.
        </Typography>
      </Paper>
    </Box>
  );
}
