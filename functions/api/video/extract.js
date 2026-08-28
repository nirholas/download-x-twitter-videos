// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * POST /api/video/extract
 *
 * Cloudflare Pages Function behind https://xactions.app/video. The dashboard
 * page posts `{ url }` here and renders one download button per quality.
 *
 * Runs entirely at the edge: no database, no Puppeteer, no backend origin. The
 * lane chain in src/video/edgeExtractor.js reads the tweet straight from X's
 * public syndication endpoint, with fxtwitter as the fallback.
 *
 * @author nichxbt
 */

import { extractTweetVideo, parseTweetUrl, VideoExtractionError } from '../../../src/video/edgeExtractor.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../../src/video/edgeHttp.js';

/** Successful extractions are reusable for an hour, keyed by tweet ID. */
const CACHE_TTL_SECONDS = 3600;

function cacheKey(tweetId) {
  return new Request(`https://xactions.app/__video-cache/${tweetId}`, { method: 'GET' });
}

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request }) {
  return jsonResponse({
    error: 'Use POST with a JSON body: { "url": "https://x.com/user/status/123" }',
  }, 405, { ...corsHeaders(request), allow: 'POST, OPTIONS' });
}

export async function onRequestPost({ request, env }) {
  const cors = corsHeaders(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be JSON: { "url": "https://x.com/user/status/123" }' }, 400, cors);
  }

  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url) {
    return jsonResponse({ error: 'Missing required field: url' }, 400, cors);
  }

  const parsed = parseTweetUrl(url);
  if (!parsed) {
    return jsonResponse({
      error: 'Invalid URL. Please provide a valid X/Twitter tweet URL.',
      example: 'https://x.com/user/status/123456789',
    }, 400, cors);
  }

  const cache = caches.default;
  const key = cacheKey(parsed.tweetId);
  const hit = await cache.match(key);
  if (hit) {
    const cached = await hit.json();
    return jsonResponse({ ...cached, cached: true }, 200, cors);
  }

  try {
    const result = await extractTweetVideo(url, { bearerToken: env.TWITTER_BEARER_TOKEN || '' });
    const payload = jsonResponse(result, 200, cors);
    // Store a cacheable copy; the response handed to the caller stays no-store
    // so a browser never serves a stale variant list after X rotates its CDN URLs.
    await cache.put(key, new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_TTL_SECONDS}` },
    }));
    return payload;
  } catch (error) {
    if (error instanceof VideoExtractionError) {
      return jsonResponse({ error: error.message }, error.status, cors);
    }
    return jsonResponse({ error: 'Failed to extract video. Please try again.' }, 500, cors);
  }
}

// A discovery crawler probes with HEAD first; Pages would otherwise route that
// to functions/api/[[path]].js and answer 503 for an endpoint that is live.
export const onRequestHead = onRequestGet;
