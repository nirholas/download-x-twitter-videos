// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * POST /api/video/extract-form
 *
 * The no-JavaScript path for https://xactions.app/video. The page's <form>
 * posts here natively when its submit handler never ran, and this redirects
 * straight to the download proxy for the best available quality.
 *
 * Errors come back as <page>?error=<code>, which the page renders inline.
 * <page> is the same-origin path the form was posted from (`/` on a standalone
 * deploy, `/video` when mounted under xactions.app), so the fallback lands back
 * where the user started wherever this project is served.
 *
 * @author nichxbt
 */

import { extractTweetVideo, parseTweetUrl, VideoExtractionError } from '../../../src/edgeExtractor.js';

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * The page path to send errors back to: the same-origin Referer's path, or `/`.
 * @param {Request} request
 * @returns {string}
 */
function pagePath(request) {
  const referer = request.headers.get('referer');
  if (!referer) return '/';
  try {
    const from = new URL(referer);
    return from.origin === new URL(request.url).origin ? from.pathname : '/';
  } catch {
    return '/';
  }
}

export async function onRequestPost({ request, env }) {
  const page = pagePath(request);
  let url = '';
  try {
    const form = await request.formData();
    url = String(form.get('url') || '').trim();
  } catch {
    return redirect(`${page}?error=invalid`);
  }

  if (!parseTweetUrl(url)) {
    return redirect(`${page}?error=invalid`);
  }

  try {
    const result = await extractTweetVideo(url, { bearerToken: env.TWITTER_BEARER_TOKEN || '' });
    const best = result.videos[0];
    const query = new URLSearchParams({ url: best.url, author: result.username, tweetId: result.tweetId });
    return redirect(`/api/video/download?${query}`);
  } catch (error) {
    if (error instanceof VideoExtractionError && error.status === 404) {
      return redirect(`${page}?error=novideo`);
    }
    return redirect(`${page}?error=failed`);
  }
}
