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
  getUsers:       (page = 1)    => apiFetch(`/api/admin/users?page=${page}`),
  createUser:     (data)        => apiFetch('/api/admin/users',            { method: 'POST',   body: JSON.stringify(data) }),
  updateUser:     (id, data)    => apiFetch(`/api/admin/users/${id}`,      { method: 'PATCH',  body: JSON.stringify(data) }),
  deleteUser:     (id)          => apiFetch(`/api/admin/users/${id}`,      { method: 'DELETE' }),
  adjustCredits:  (id, data)    => apiFetch(`/api/admin/users/${id}/credits`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Licenses
  getLicenses:    (page = 1)    => apiFetch(`/api/admin/licenses?page=${page}`),
  createLicense:  (data)        => apiFetch('/api/admin/licenses',                  { method: 'POST',  body: JSON.stringify(data) }),
  updateLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}`,           { method: 'PATCH', body: JSON.stringify(data) }),
  extendLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}/extend`,    { method: 'PATCH', body: JSON.stringify(data) }),
  revokeLicense:  (key)         => apiFetch(`/api/admin/licenses/${key}/revoke`,    { method: 'PATCH' }),
  assignLicense:  (key, data)   => apiFetch(`/api/admin/licenses/${key}/assign`,    { method: 'PATCH', body: JSON.stringify(data) }),

  // Releases
  getReleases:     ()           => apiFetch('/api/admin/releases'),
  uploadRelease:   (formData)   => apiFetch('/api/admin/releases', { method: 'POST', body: formData }),
  updateRelease:   (id, data)   => apiFetch(`/api/admin/releases/${id}`,          { method: 'PATCH', body: JSON.stringify(data) }),
  activateRelease:   (id)         => apiFetch(`/api/admin/releases/${id}/activate`,   { method: 'PATCH' }),
  deactivateRelease: (id)         => apiFetch(`/api/admin/releases/${id}/deactivate`, { method: 'PATCH' }),
  resetLicenseHwid:  (key)        => apiFetch(`/api/admin/licenses/${key}/reset-hwid`, { method: 'PATCH' }),

  // Sessions
  getSessions: (page = 1) => apiFetch(`/api/admin/sessions?page=${page}`),

  // Global Statuses (no delete — archive only)
  getStatuses:    ()          => apiFetch('/api/admin/statuses'),
  createStatus:   (data)      => apiFetch('/api/admin/statuses',      { method: 'POST',   body: JSON.stringify(data) }),
  updateStatus:   (id, data)  => apiFetch(`/api/admin/statuses/${id}`,{ method: 'PATCH',  body: JSON.stringify(data) }),

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
  redeemKey:    (data) => apiFetch('/api/portal/redeem', { method: 'POST', body: JSON.stringify(data) }),
  getShop:      () => apiFetch('/api/portal/shop'),
  purchase:     (data) => apiFetch('/api/portal/shop/purchase', { method: 'POST', body: JSON.stringify(data) }),
  resetHwid:    (data) => apiFetch('/api/portal/reset-hwid', { method: 'POST', body: JSON.stringify(data) }),
  getStatuses:  () => apiFetch('/api/portal/statuses'),
};
