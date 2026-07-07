import { useNavigate } from 'react-router-dom';
import { Tabs, Tab, Box } from '@mui/material';

// The tab keys for a server's detail page, in display order. Kept in one place so
// WorldServerDetailPage (which validates :tab) and this bar agree on the set.
export const SERVER_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'map',      label: 'Map' },
  { key: 'uploads',  label: 'Uploads' },
  { key: 'data',     label: 'Data' },
  { key: 'offsets',  label: 'Offsets' },
  { key: 'settings', label: 'Settings' },
];

// Controlled, presentational tab bar for the per-server detail page. `value` is the
// active tab key; changing tabs navigates to the matching detail route so the URL is
// the single source of truth (deep-linkable, back/forward friendly).
export default function ServerTabs({ value, serverId }) {
  const navigate = useNavigate();

  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
      <Tabs
        value={value}
        onChange={(_, key) => navigate(`/admin/world/servers/${serverId}/${key}`)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
      >
        {SERVER_TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>
    </Box>
  );
}
