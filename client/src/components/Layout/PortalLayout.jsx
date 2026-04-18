import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Box, AppBar, Toolbar, Typography, Button, Container, Chip,
} from '@mui/material';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import { useAuth } from '../../context/AuthContext.jsx';

const navItems = [
  { label: 'Dashboard', path: '/portal' },
  { label: 'My Keys',   path: '/portal/keys' },
  { label: 'Sessions',  path: '/portal/sessions' },
  { label: 'Shop',      path: '/portal/shop' },
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
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }} elevation={0}>
        <Toolbar sx={{ maxWidth: 896, width: '100%', mx: 'auto', px: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mr: 4 }}>
            Rabbit
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

          <Chip
            icon={<AccountBalanceWalletIcon sx={{ fontSize: 14 }} />}
            label={`${user?.credits ?? 0}`}
            size="small"
            variant="outlined"
            color="primary"
            sx={{ mr: 2, fontWeight: 600, fontSize: '0.75rem' }}
            onClick={() => navigate('/portal/shop')}
          />
          {user?.status && (
            <Chip label={user.status} size="small" variant="outlined" sx={{ mr: 2, fontSize: '0.65rem' }} />
          )}
          <Typography variant="caption" color="text.disabled" sx={{ mr: 2 }}>
            {user?.name}
          </Typography>
          <Button size="small" onClick={handleLogout} sx={{ color: 'text.secondary' }}>
            Log out
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: 4, flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Container>
    </Box>
  );
}
