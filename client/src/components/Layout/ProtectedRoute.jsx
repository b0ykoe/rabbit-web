import { Navigate, useLocation } from 'react-router-dom';
import { CircularProgress, Box } from '@mui/material';
import { useAuth } from '../../context/AuthContext.jsx';

const isAdminRole = (r) => r === 'admin' || r === 'super_admin';

/**
 * Auth guard wrapper. `role="admin"` admits both `admin` and `super_admin`
 * — super-admin is a superset of admin, matching the server's requireAdmin
 * middleware.
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

  // Role mismatch → redirect to correct panel. `admin`-gated routes accept
  // super_admin too; other roles match exactly.
  const ok = !role
    || (role === 'admin' && isAdminRole(user.role))
    || user.role === role;
  if (!ok) {
    return <Navigate to={isAdminRole(user.role) ? '/admin' : '/portal'} replace />;
  }

  return children;
}
