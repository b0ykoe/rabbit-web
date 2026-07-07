import { Chip, Tooltip } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { deriveCoverage } from './deriveCoverage.js';

// A compact traffic-light pill for a server, computed from the LIST ROW alone
// (deriveCoverage(server, null)). Renders on ServerCard AND the detail header,
// so it must degrade gracefully when the B1 counts are absent (treated as 0 by
// deriveCoverage). Three states:
//   ready         -> green  "Ready"
//   not_published -> amber  "Not published"
//   incomplete    -> amber  "N steps left"
export default function CoverageStatusPill({ server }) {
  const cov = deriveCoverage(server, null);

  let label, color, Icon, tip;
  if (cov.verdict === 'ready') {
    label = 'Ready';
    color = 'success';
    Icon = CheckCircleIcon;
    tip = 'Named, has a background and published — visible on the user map.';
  } else if (cov.verdict === 'not_published') {
    label = 'Not published';
    color = 'warning';
    Icon = VisibilityOffIcon;
    tip = 'Everything is set up — publish in Settings to show it on the user map.';
  } else {
    const n = cov.stepsLeft;
    label = `${n} step${n === 1 ? '' : 's'} left`;
    color = 'warning';
    Icon = WarningAmberIcon;
    tip = 'Setup incomplete — open the server to finish the checklist.';
  }

  return (
    <Tooltip title={tip}>
      <Chip
        size="small"
        color={color}
        variant={color === 'success' ? 'filled' : 'outlined'}
        icon={<Icon sx={{ fontSize: 16 }} />}
        label={label}
        sx={{ height: 22, fontWeight: 600 }}
      />
    </Tooltip>
  );
}
