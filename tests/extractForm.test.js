// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * The no-JavaScript fallback sends errors back to the page the form was posted
 * from, so the downloader works mounted at `/` or at `/video`.
 */

import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../functions/api/video/extract-form.js';

function post(url, referer) {
  const body = new URLSearchParams({ url });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (referer) headers.referer = referer;
  return onRequestPost({
    request: new Request('https://xactions.app/api/video/extract-form', { method: 'POST', headers, body }),
    env: {},
  });
}

describe('POST /api/video/extract-form', () => {
  it('redirects an invalid URL back to the posting page', async () => {
    const res = await post('https://example.com/nope', 'https://xactions.app/video');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/video?error=invalid');
  });

  it('falls back to / without a referer', async () => {
    const res = await post('not a url');
    expect(res.headers.get('location')).toBe('/?error=invalid');
  });

  it('ignores a cross-origin referer', async () => {
    const res = await post('not a url', 'https://evil.example/phish');
    expect(res.headers.get('location')).toBe('/?error=invalid');
  });
});
