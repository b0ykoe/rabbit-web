import { Tooltip } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ErrorIcon from '@mui/icons-material/Error';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';

// A tiny status atom shared by the coverage checklist + matrix cells.
//   done    — green check (satisfied)
//   missing — amber/red cross (ACTIONABLE: an upload/import fixes it)
//   partial — amber warning (some-but-not-all)
//   inert   — grey ring (NOT actionable: e.g. "spawn data missing", which only a
//             recording bot can fill — there is no upload for it)
const MAP = {
  done:    { Icon: CheckCircleIcon,          color: 'success.main' },
  missing: { Icon: CancelIcon,               color: 'error.main'   },
  partial: { Icon: ErrorIcon,                color: 'warning.main' },
  inert:   { Icon: RemoveCircleOutlineIcon,  color: 'text.disabled' },
};

export default function StatusDot({ state = 'inert', title, size = 18 }) {
  const { Icon, color } = MAP[state] || MAP.inert;
  const dot = (
    <Icon
      sx={{ fontSize: size, color, verticalAlign: 'middle', display: 'inline-block' }}
      aria-label={title || state}
    />
  );
  return title ? <Tooltip title={title}><span style={{ display: 'inline-flex' }}>{dot}</span></Tooltip> : dot;
}
