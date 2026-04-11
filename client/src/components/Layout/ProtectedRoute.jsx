import { Navigate, useLocation } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Auth guard wrapper.
 * @param {object} props
 * @param {'admin'|'user'} [props.role] - required role (optional — any authenticated user if omitted)
 * @param {React.ReactNode} props.children
 */
export default function ProtectedRoute({ role, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress color="primary" />
      </Box>
    );
  }

  // Not logged in → login
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Force password change → redirect (unless already on that page)
  if (user.force_password_change && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  // Role mismatch → redirect to correct panel
  if (role && user.role !== role) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/portal'} replace />;
  }

  return children;
}
