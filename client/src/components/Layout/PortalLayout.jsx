import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Box, AppBar, Toolbar, Typography, Button, Container,
} from '@mui/material';
import { useAuth } from '../../context/AuthContext.jsx';

const navItems = [
  { label: 'Dashboard', path: '/portal' },
  { label: 'My Keys',   path: '/portal/keys' },
];

export default function PortalLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider' }} elevation={0}>
        <Toolbar sx={{ maxWidth: 896, width: '100%', mx: 'auto', px: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mr: 4 }}>
            BotPortal
          </Typography>

          {navItems.map((item) => (
            <Button
              key={item.path}
              onClick={() => navigate(item.path)}
              size="small"
              sx={{
                mr: 1,
                color: location.pathname === item.path ? 'primary.light' : 'text.secondary',
                '&:hover': { color: 'text.primary' },
              }}
            >
              {item.label}
            </Button>
          ))}

          <Box sx={{ flexGrow: 1 }} />

          <Typography variant="caption" color="text.disabled" sx={{ mr: 2 }}>
            {user?.name}
          </Typography>
          <Button size="small" onClick={handleLogout} sx={{ color: 'text.secondary' }}>
            Log out
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: 4 }}>
        <Outlet />
      </Container>
    </Box>
  );
}
