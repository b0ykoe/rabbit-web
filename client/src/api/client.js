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

// XMLHttpRequest is intentionally used only for large multipart uploads: fetch
// does not expose browser upload progress, while cache packages can be hundreds
// of megabytes.
export function apiUpload(path, formData, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-XSRF-TOKEN', getCsrfToken());
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'Upload connection failed' }));
    xhr.onload = () => {
      const data = (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status === 401) {
        if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
        reject(new ApiError(401, { error: 'Not authenticated' }));
      } else if (xhr.status < 200 || xhr.status >= 300) reject(new ApiError(xhr.status, data));
      else resolve(data);
    };
    xhr.send(formData);
  });
}

export { ApiError };
