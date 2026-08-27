// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * GET /api/video/download?url=<mp4>&author=<handle>&tweetId=<id>
 *
 * Streams a tweet's mp4 back through xactions.app so the browser saves it
 * instead of navigating to it. A cross-origin `<a download>` is ignored by
 * every browser, so the file has to come from our own origin to get a
 * filename, and video.twimg.com sends no CORS headers of its own.
 *
 * Only video.twimg.com and pbs.twimg.com are proxyable, so this can never be
 * used as a general-purpose open proxy.
 *
 * @author nichxbt
 */

import { assertMediaUrl, downloadFilename, VideoExtractionError } from '../../../src/video/edgeExtractor.js';
import { corsHeaders, jsonResponse, preflightResponse } from '../../../src/video/edgeHttp.js';

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  Referer: 'https://x.com/',
};

export async function onRequestOptions({ request }) {
  return preflightResponse(request);
}

export async function onRequestGet({ request }) {
  const cors = corsHeaders(request);
  const params = new URL(request.url).searchParams;
  const target = params.get('url');

  if (!target) {
    return jsonResponse({ error: 'Missing required query param: url' }, 400, cors);
  }

  let media;
  try {
    media = assertMediaUrl(target);
  } catch (error) {
    const status = error instanceof VideoExtractionError ? error.status : 400;
    return jsonResponse({ error: error.message }, status, cors);
  }

  const upstream = await fetch(media.href, { headers: UPSTREAM_HEADERS });
  if (!upstream.ok || !upstream.body) {
    return jsonResponse({ error: `Failed to fetch video: HTTP ${upstream.status}` }, upstream.status === 404 ? 404 : 502, cors);
  }

  const filename = downloadFilename(params.get('author'), params.get('tweetId'));
  const headers = new Headers(cors);
  headers.set('content-type', upstream.headers.get('content-type') || 'video/mp4');
  headers.set('content-disposition', `attachment; filename="${filename}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('content-length', length);
  // Twitter's CDN URLs are stable for the life of the media, so let the edge
  // hold the bytes and serve repeat downloads without a second origin fetch.
  headers.set('cache-control', 'public, max-age=3600');

  return new Response(upstream.body, { status: 200, headers });
}
