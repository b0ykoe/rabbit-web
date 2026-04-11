import { Chip } from '@mui/material';
import { getExpiryInfo } from '../../utils/format.js';

export default function ExpiryBadge({ expiresAt, size = 'small' }) {
  const { label, color } = getExpiryInfo(expiresAt);
  return <Chip label={label} color={color} size={size} variant="outlined" />;
}
