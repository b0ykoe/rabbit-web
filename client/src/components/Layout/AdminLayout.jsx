import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Box, Drawer, List, ListItemButton, ListItemIcon, ListItemText,
  Typography, Divider,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import PeopleIcon from '@mui/icons-material/People';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SensorsIcon from '@mui/icons-material/Sensors';
import HistoryIcon from '@mui/icons-material/History';
import AnnouncementIcon from '@mui/icons-material/Announcement';
import LogoutIcon from '@mui/icons-material/Logout';
import SettingsIcon from '@mui/icons-material/Settings';
import { useAuth } from '../../context/AuthContext.jsx';

const DRAWER_WIDTH = 224;

const navItems = [
  { label: 'Dashboard', icon: <DashboardIcon />,  path: '/admin' },
  { label: 'Users',     icon: <PeopleIcon />,      path: '/admin/users' },
  { label: 'Licenses',  icon: <VpnKeyIcon />,      path: '/admin/licenses' },
  { label: 'Releases',  icon: <CloudUploadIcon />, path: '/admin/releases' },
  { label: 'Sessions',  icon: <SensorsIcon />,     path: '/admin/sessions' },
  { label: 'Statuses',  icon: <AnnouncementIcon />, path: '/admin/statuses' },
  { label: 'Audit Log', icon: <HistoryIcon />,     path: '/admin/audit' },
  { label: 'Settings',  icon: <SettingsIcon />,    path: '/admin/settings' },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const isActive = (path) => {
    if (path === '/admin') return location.pathname === '/admin';
    return location.pathname.startsWith(path);
  };

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Sidebar */}
      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DRAWER_WIDTH,
            bgcolor: 'background.paper',
            borderRight: '1px solid',
            borderColor: 'divider',
          },
        }}
      >
        <Box sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} color="text.primary">
            Rabbit
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Admin
          </Typography>
        </Box>

        <Divider />

        <List sx={{ px: 1, py: 0.5 }}>
          {navItems.map((item) => (
            <ListItemButton
              key={item.path}
              onClick={() => navigate(item.path)}
              selected={isActive(item.path)}
              sx={{
                borderRadius: 1,
                mb: 0.25,
                '&.Mui-selected': {
                  bgcolor: 'primary.main',
                  color: 'white',
                  '& .MuiListItemIcon-root': { color: 'white' },
                  '&:hover': { bgcolor: 'primary.dark' },
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 36, color: 'text.secondary' }}>
                {item.icon}
              </ListItemIcon>
              <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: '0.8125rem' }} />
            </ListItemButton>
          ))}
        </List>

        <Box sx={{ mt: 'auto', p: 1 }}>
          <Divider sx={{ mb: 1 }} />
          <Typography variant="caption" color="text.disabled" sx={{ px: 1 }}>
            {user?.email}
          </Typography>
          <ListItemButton onClick={handleLogout} sx={{ borderRadius: 1, mt: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 36, color: 'text.secondary' }}>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Log out" primaryTypographyProps={{ fontSize: '0.8125rem' }} />
          </ListItemButton>
        </Box>
      </Drawer>

      {/* Main Content */}
      <Box component="main" sx={{ flexGrow: 1, p: 3, minWidth: 0 }}>
        <Outlet />
      </Box>
    </Box>
  );
}
