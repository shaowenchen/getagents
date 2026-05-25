import type { Request } from 'express';

export function normalizeRoutePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export function normalizeAccessUrl(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/g, '');
}

export function getConfiguredAccessUrl(): string {
  return normalizeAccessUrl(process.env.ACCESS_URL);
}

export function inferAccessUrl(req: Request, routePrefix = ''): string {
  const configured = getConfiguredAccessUrl();
  if (configured) return configured;

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host') || '';
  return normalizeAccessUrl(`${proto}://${host}${routePrefix}`);
}
