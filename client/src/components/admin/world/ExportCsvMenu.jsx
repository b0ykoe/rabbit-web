import { useState } from 'react';
import { Tooltip, IconButton, Menu, MenuItem } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { worldApi } from '../../../api/endpoints.js';

// Per-server "Export CSV" control: a small menu offering whole-server all-time
// (default) plus latest-version-only. Streams the admin-only CSV by opening the
// worldApi.exportCsvUrl string in a new tab (browser handles the download).
//
// Renders either as a standalone download IconButton (default) or — when
// `trigger="menuitem"` — as a plain MenuItem meant to sit inside another
// overflow menu (the ServerCard MoreVert menu). In menu-item mode it opens its
// own version submenu anchored to the clicked item and calls `onDone()` so the
// parent menu can close.
export default function ExportCsvMenu({ serverId, trigger = 'icon', label = 'Export CSV', onDone }) {
  const [anchor, setAnchor] = useState(null);
  const open = Boolean(anchor);

  const download = (opts) => {
    setAnchor(null);
    // Same-origin authed GET; the session cookie rides along automatically.
    window.open(worldApi.exportCsvUrl(serverId, opts), '_blank', 'noopener');
    onDone?.();
  };

  return (
    <>
      {trigger === 'menuitem' ? (
        <MenuItem onClick={(e) => setAnchor(e.currentTarget)}>{label}</MenuItem>
      ) : (
        <Tooltip title="Export spawn CSV (admin only)">
          <span>
            <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)}>
              <DownloadIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Menu anchorEl={anchor} open={open} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => download({ version: 'all' })}>Whole server · all versions</MenuItem>
        <MenuItem onClick={() => download({ version: 'latest' })}>Whole server · latest version only</MenuItem>
      </Menu>
    </>
  );
}
