// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Shared response helpers for the xactions.app Pages Functions.
 *
 * @module src/video/edgeHttp
 * @author nichxbt
 */

const ALLOWED_ORIGINS = new Set([
  'https://xactions.app',
  'https://www.xactions.app',
]);

/**
 * CORS headers for an API response. Unknown origins are answered as the
 * canonical site rather than reflected, so the endpoints stay usable from the
 * dashboard without becoming a general-purpose open proxy for other sites.
 * @param {Request} request
 * @returns {Record<string, string>}
 */
export function corsHeaders(request) {
  const origin = request.headers.get('origin');
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://xactions.app';
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

/**
 * JSON response with caching disabled. Every endpoint here is dynamic.
 * @param {unknown} data
 * @param {number} status
 * @param {Record<string, string>} extraHeaders
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

/**
 * Answer a CORS preflight.
 * @param {Request} request
 * @returns {Response}
 */
export function preflightResponse(request) {
  return new Response(null, { status: 204, headers: { ...corsHeaders(request), 'access-control-max-age': '86400' } });
}
