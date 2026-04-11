import { Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './components/Layout/ProtectedRoute.jsx';
import AdminLayout from './components/Layout/AdminLayout.jsx';
import PortalLayout from './components/Layout/PortalLayout.jsx';

// Auth
import Login from './components/auth/Login.jsx';
import ChangePassword from './components/auth/ChangePassword.jsx';

// Admin
import AdminDashboard from './components/admin/Dashboard.jsx';
import Users from './components/admin/Users.jsx';
import Licenses from './components/admin/Licenses.jsx';
import Releases from './components/admin/Releases.jsx';
import Sessions from './components/admin/Sessions.jsx';
import AuditLog from './components/admin/AuditLog.jsx';

// Portal
import PortalDashboard from './components/portal/Dashboard.jsx';
import Keys from './components/portal/Keys.jsx';

export default function AppRouter() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Force password change */}
      <Route path="/change-password" element={
        <ProtectedRoute>
          <ChangePassword />
        </ProtectedRoute>
      } />

      {/* Admin */}
      <Route path="/admin" element={
        <ProtectedRoute role="admin">
          <AdminLayout />
        </ProtectedRoute>
      }>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<Users />} />
        <Route path="licenses" element={<Licenses />} />
        <Route path="releases" element={<Releases />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="audit" element={<AuditLog />} />
      </Route>

      {/* Portal (regular users) */}
      <Route path="/portal" element={
        <ProtectedRoute role="user">
          <PortalLayout />
        </ProtectedRoute>
      }>
        <Route index element={<PortalDashboard />} />
        <Route path="keys" element={<Keys />} />
      </Route>

      {/* Default redirect */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
