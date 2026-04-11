/**
 * Fetch wrapper with CSRF token and credentials.
 * All API calls go through this.
 */

function getCsrfToken() {
  const match = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed with status ${status}`);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch(path, options = {}) {
  const headers = { ...options.headers };

  // Add CSRF header for mutating requests
  if (!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())) {
    headers['X-XSRF-TOKEN'] = getCsrfToken();
  }

  // Add Content-Type for JSON bodies (skip for FormData — browser sets multipart boundary)
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
  });

  if (res.status === 401) {
    // Not authenticated — redirect to login (unless already there)
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(401, { error: 'Not authenticated' });
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, data);
  }

  return data;
}

export { ApiError };
