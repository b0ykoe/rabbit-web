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
import Statuses from './components/admin/Statuses.jsx';
import AuditLog from './components/admin/AuditLog.jsx';
import AdminSettings from './components/admin/Settings.jsx';

// Admin World (Monster Map) — super-admin-only subtree.
import WorldOutlet from './components/admin/world/WorldOutlet.jsx';
import WorldServersPage from './components/admin/world/WorldServersPage.jsx';
import IngestTokensPage from './components/admin/world/IngestTokensPage.jsx';
import VariantsPage from './components/admin/world/VariantsPage.jsx';
import WorldServerDetailPage from './components/admin/world/WorldServerDetailPage.jsx';

// Portal
import PortalDashboard from './components/portal/Dashboard.jsx';
import Keys from './components/portal/Keys.jsx';
import Shop from './components/portal/Shop.jsx';
import PortalSessions from './components/portal/Sessions.jsx';
import MonsterMap from './components/portal/MonsterMap.jsx';

// Recording sessions (spawn recording / coverage / version-diff) — admin-only.
import WorldSessions from './components/portal/WorldSessions.jsx';

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
        <Route path="statuses" element={<Statuses />} />
        <Route path="audit" element={<AuditLog />} />
        {/* Admin World (Monster Map) — guarded ONCE at super_admin via WorldOutlet. */}
        <Route path="world" element={
          <ProtectedRoute role="super_admin">
            <WorldOutlet />
          </ProtectedRoute>
        }>
          <Route index element={<WorldServersPage />} />
          <Route path="tokens" element={<IngestTokensPage />} />
          <Route path="variants" element={<VariantsPage />} />
          <Route path="servers/:id" element={<WorldServerDetailPage />} />
          <Route path="servers/:id/:tab" element={<WorldServerDetailPage />} />
        </Route>
        {/* Recording sessions moved here from the user portal — super-admin only. */}
        <Route path="recording-sessions" element={
          <ProtectedRoute role="super_admin">
            <WorldSessions />
          </ProtectedRoute>
        } />
        <Route path="settings" element={<AdminSettings />} />
      </Route>

      {/* Portal (regular users) */}
      <Route path="/portal" element={
        <ProtectedRoute role="user">
          <PortalLayout />
        </ProtectedRoute>
      }>
        <Route index element={<PortalDashboard />} />
        <Route path="keys" element={<Keys />} />
        <Route path="sessions" element={<PortalSessions />} />
        <Route path="shop" element={<Shop />} />
        <Route path="world" element={<MonsterMap />} />
      </Route>

      {/* Default redirect */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
