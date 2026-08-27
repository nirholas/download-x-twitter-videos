// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * POST /api/video/extract-form
 *
 * The no-JavaScript path for https://xactions.app/video. The page's <form>
 * posts here natively when its submit handler never ran, and this redirects
 * straight to the download proxy for the best available quality.
 *
 * Errors come back as /video?error=<code>, which the page renders inline.
 *
 * @author nichxbt
 */

import { extractTweetVideo, parseTweetUrl, VideoExtractionError } from '../../../src/video/edgeExtractor.js';

function redirect(location) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  let url = '';
  try {
    const form = await request.formData();
    url = String(form.get('url') || '').trim();
  } catch {
    return redirect('/video?error=invalid');
  }

  if (!parseTweetUrl(url)) {
    return redirect('/video?error=invalid');
  }

  try {
    const result = await extractTweetVideo(url, { bearerToken: env.TWITTER_BEARER_TOKEN || '' });
    const best = result.videos[0];
    const query = new URLSearchParams({ url: best.url, author: result.username, tweetId: result.tweetId });
    return redirect(`/api/video/download?${query}`);
  } catch (error) {
    if (error instanceof VideoExtractionError && error.status === 404) {
      return redirect('/video?error=novideo');
    }
    return redirect('/video?error=failed');
  }
}
