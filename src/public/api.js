import { ADMIN_TOKEN_KEY, appConfig } from './state.js';

const routePrefix = normalizePrefix(appConfig.routePrefix || '');
const apiPrefix = appConfig.apiPrefix || `${routePrefix}/api`;

function normalizePrefix(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return '/' + trimmed.replace(/^\/+|\/+$/g, '');
}

function routeHref(path) {
  if (!routePrefix) return path;
  return path === '/' ? routePrefix : routePrefix + path;
}

function stripRoutePrefix(pathname) {
  if (!routePrefix) return pathname || '/';
  if (pathname === routePrefix) return '/';
  if (pathname.startsWith(routePrefix + '/')) return pathname.slice(routePrefix.length) || '/';
  return pathname || '/';
}

function apiUrl(path) {
  return apiPrefix + path;
}

function apiPath(path) {
  return apiPrefix + path;
}

function getAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

function setAdminToken(token, username) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  if (username) sessionStorage.setItem('admin_username', username);
}

function clearAdminToken() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  sessionStorage.removeItem('admin_username');
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.admin) {
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `API error: ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function apiUpload(path, formData, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.admin) {
    const token = getAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(apiUrl(path), {
    method: options.method || 'POST',
    headers,
    body: formData,
  });

  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `API error: ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export {
  routePrefix,
  apiPrefix,
  normalizePrefix,
  routeHref,
  stripRoutePrefix,
  apiUrl,
  apiPath,
  api,
  apiUpload,
  getAdminToken,
  setAdminToken,
  clearAdminToken,
};