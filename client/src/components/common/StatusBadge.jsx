import { Chip } from '@mui/material';

const presets = {
  active:  { label: 'Active',  color: 'success' },
  revoked: { label: 'Revoked', color: 'error' },
  live:    { label: 'Live',    color: 'success' },
  stale:   { label: 'Stale',   color: 'default' },
  online:  { label: 'Running', color: 'success' },
  offline: { label: 'Offline', color: 'default' },
};

export default function StatusBadge({ status, label, color, size = 'small' }) {
  const preset = presets[status] || {};
  return (
    <Chip
      label={label || preset.label || status}
      color={color || preset.color || 'default'}
      size={size}
      variant="outlined"
    />
  );
}
