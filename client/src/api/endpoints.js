import { apiFetch } from './client.js';

// ── Auth ─────────────────────────────────────────────────────────────────────

export const authApi = {
  me:             ()     => apiFetch('/api/auth/me'),
  login:          (data) => apiFetch('/api/auth/login',           { method: 'POST', body: JSON.stringify(data) }),
  logout:         ()     => apiFetch('/api/auth/logout',          { method: 'POST' }),
  changePassword: (data) => apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify(data) }),
};

// ── Admin ────────────────────────────────────────────────────────────────────

export const adminApi = {
  // Dashboard
  getDashboard: () => apiFetch('/api/admin/dashboard'),

  // Users
  getUsers:    (page = 1)    => apiFetch(`/api/admin/users?page=${page}`),
  createUser:  (data)        => apiFetch('/api/admin/users',      { method: 'POST',   body: JSON.stringify(data) }),
  updateUser:  (id, data)    => apiFetch(`/api/admin/users/${id}`,{ method: 'PATCH',  body: JSON.stringify(data) }),
  deleteUser:  (id)          => apiFetch(`/api/admin/users/${id}`,{ method: 'DELETE' }),

  // Licenses
  getLicenses:    (page = 1)    => apiFetch(`/api/admin/licenses?page=${page}`),
  createLicense:  (data)        => apiFetch('/api/admin/licenses',                  { method: 'POST',  body: JSON.stringify(data) }),
  revokeLicense:  (key)         => apiFetch(`/api/admin/licenses/${key}/revoke`,    { method: 'PATCH' }),
  assignLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}/assign`,    { method: 'PATCH', body: JSON.stringify(data) }),

  // Releases
  getReleases:     ()           => apiFetch('/api/admin/releases'),
  uploadRelease:   (formData)   => apiFetch('/api/admin/releases', { method: 'POST', body: formData }), // FormData — no Content-Type header
  activateRelease: (id)         => apiFetch(`/api/admin/releases/${id}/activate`, { method: 'PATCH' }),

  // Sessions
  getSessions: (page = 1) => apiFetch(`/api/admin/sessions?page=${page}`),

  // Audit
  getAuditLog: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/api/admin/audit?${qs}`);
  },
};

// ── Portal ───────────────────────────────────────────────────────────────────

export const portalApi = {
  getDashboard: () => apiFetch('/api/portal/dashboard'),
  getKeys:      () => apiFetch('/api/portal/keys'),
};
