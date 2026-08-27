// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Edge video extractor tests.
 *
 * The lane tests drive the real parsers over response bodies captured from the
 * live endpoints (a SpaceX post with a 4K video, trimmed to the fields the
 * parsers read), so the shapes are the ones X and fxtwitter actually return.
 *
 * @author nich (@nichxbt)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertMediaUrl,
  downloadFilename,
  extractTweetVideo,
  extractViaFxTwitter,
  extractViaSyndication,
  getQualityLabel,
  parseTweetUrl,
  syndicationToken,
  VideoExtractionError,
} from '../../src/video/edgeExtractor.js';

const TWEET_ID = '2092648130856571283';
const MEDIA_ID = '2092647926593953792';
const CDN = `https://video.twimg.com/amplify_video/${MEDIA_ID}`;

const SYNDICATION_BODY = {
  __typename: 'Tweet',
  text: 'Falcon Heavy in the hangar at pad 39A in Florida',
  user: { screen_name: 'SpaceX', name: 'SpaceX' },
  mediaDetails: [
    {
      type: 'video',
      media_url_https: `https://pbs.twimg.com/amplify_video_thumb/${MEDIA_ID}/img/BCdk.jpg`,
      video_info: {
        duration_millis: 28542,
        variants: [
          { content_type: 'application/x-mpegURL', url: `${CDN}/pl/8C8d.m3u8?v=cfc` },
          { bitrate: 256000, content_type: 'video/mp4', url: `${CDN}/vid/avc1/480x270/1gKa.mp4` },
          { bitrate: 10368000, content_type: 'video/mp4', url: `${CDN}/vid/avc1/1920x1080/VGhm.mp4` },
          { bitrate: 25128000, content_type: 'video/mp4', url: `${CDN}/vid/avc1/3840x2160/u8cu.mp4` },
        ],
      },
    },
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/photo.jpg' },
  ],
};

const FXTWITTER_BODY = {
  code: 200,
  tweet: {
    text: 'Falcon Heavy in the hangar at pad 39A in Florida',
    author: { name: 'SpaceX', screen_name: 'SpaceX' },
    media: {
      videos: [
        {
          url: `${CDN}/vid/avc1/3840x2160/u8cu.mp4?tag=29`,
          thumbnail_url: `https://pbs.twimg.com/amplify_video_thumb/${MEDIA_ID}/img/BCdk.jpg`,
          duration: 28.542,
          width: 3840,
          height: 2160,
          type: 'video',
          formats: [
            { url: `${CDN}/pl/8C8d.m3u8?tag=29&v=cfc`, container: 'm3u8' },
            { url: `${CDN}/vid/avc1/480x270/1gKa.mp4?tag=29`, bitrate: 256000, container: 'mp4' },
            { url: `${CDN}/vid/avc1/1920x1080/VGhm.mp4?tag=29`, bitrate: 10368000, container: 'mp4' },
            { url: `${CDN}/vid/avc1/3840x2160/u8cu.mp4?tag=29`, bitrate: 25128000, container: 'mp4' },
          ],
        },
      ],
    },
  },
};

/**
 * Route every fetch through a table of matchers, so a lane that is supposed to
 * be skipped fails loudly instead of silently hitting the network.
 */
function stubFetch(routes) {
  const calls = [];
  vi.stubGlobal('fetch', async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    for (const [fragment, respond] of routes) {
      if (url.includes(fragment)) return respond();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  return calls;
}

const ok = (body) => () => new Response(JSON.stringify(body), { status: 200 });
const status = (code) => () => new Response('', { status: code });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseTweetUrl', () => {
  it('accepts x.com, twitter.com, and www variants', () => {
    expect(parseTweetUrl('https://x.com/SpaceX/status/123')).toEqual({ username: 'SpaceX', tweetId: '123' });
    expect(parseTweetUrl('https://twitter.com/SpaceX/status/123')).toEqual({ username: 'SpaceX', tweetId: '123' });
    expect(parseTweetUrl('  https://www.x.com/SpaceX/status/123?s=20  ')).toEqual({ username: 'SpaceX', tweetId: '123' });
  });

  it('rejects anything that is not a tweet permalink', () => {
    expect(parseTweetUrl('https://x.com/SpaceX')).toBeNull();
    expect(parseTweetUrl('https://example.com/SpaceX/status/123')).toBeNull();
    expect(parseTweetUrl('')).toBeNull();
    expect(parseTweetUrl(null)).toBeNull();
  });
});

describe('getQualityLabel', () => {
  it('names the resolution ladder Twitter serves', () => {
    expect(getQualityLabel(3840, 2160)).toBe('4K');
    expect(getQualityLabel(2560, 1440)).toBe('1440p');
    expect(getQualityLabel(1920, 1080)).toBe('1080p');
    expect(getQualityLabel(1280, 720)).toBe('720p');
    expect(getQualityLabel(640, 360)).toBe('480p');
    expect(getQualityLabel(480, 270)).toBe('360p');
    expect(getQualityLabel(0, 0)).toBe('unknown');
  });
});

describe('syndicationToken', () => {
  it('derives the token x.com embeds use for a given tweet ID', () => {
    expect(syndicationToken(TWEET_ID)).toBe('52m8xeffwk8');
    expect(syndicationToken(TWEET_ID)).not.toContain('.');
    expect(syndicationToken(TWEET_ID)).not.toContain('0');
  });
});

describe('extractViaSyndication', () => {
  it('returns every mp4 variant, best first, and drops the HLS playlist', async () => {
    stubFetch([['cdn.syndication.twimg.com', ok(SYNDICATION_BODY)]]);
    const result = await extractViaSyndication(TWEET_ID, 'SpaceX');

    expect(result.source).toBe('syndication');
    expect(result.videos.map((v) => v.quality)).toEqual(['4K', '1080p', '360p']);
    expect(result.videos.every((v) => v.url.endsWith('.mp4'))).toBe(true);
    expect(result.videos[0]).toMatchObject({ width: 3840, height: 2160, bitrate: 25128000, contentType: 'video/mp4' });
    expect(result.duration).toBe(28542);
    expect(result.username).toBe('SpaceX');
    expect(result.thumbnail).toContain('amplify_video_thumb');
  });

  it('reports a deleted tweet as a 404 rather than a transport failure', async () => {
    stubFetch([['cdn.syndication.twimg.com', status(404)]]);
    await expect(extractViaSyndication(TWEET_ID, 'SpaceX')).rejects.toMatchObject({ status: 404 });
  });

  it('reports a photo-only tweet as no video found', async () => {
    stubFetch([['cdn.syndication.twimg.com', ok({ ...SYNDICATION_BODY, mediaDetails: [{ type: 'photo' }] })]]);
    await expect(extractViaSyndication(TWEET_ID, 'SpaceX')).rejects.toThrow(/No video found/);
  });
});

describe('extractViaFxTwitter', () => {
  it('reads the formats ladder instead of only the top-level url', async () => {
    stubFetch([['api.fxtwitter.com', ok(FXTWITTER_BODY)]]);
    const result = await extractViaFxTwitter(TWEET_ID, 'SpaceX');

    expect(result.source).toBe('fxtwitter');
    expect(result.videos.map((v) => v.quality)).toEqual(['4K', '1080p', '360p']);
    expect(result.videos.some((v) => v.url.includes('.m3u8'))).toBe(false);
    expect(result.duration).toBe(28542);
  });
});

describe('extractTweetVideo lane chain', () => {
  it('falls through to fxtwitter when syndication is rate-limited', async () => {
    const calls = stubFetch([
      ['cdn.syndication.twimg.com', status(429)],
      ['api.fxtwitter.com', ok(FXTWITTER_BODY)],
    ]);

    const result = await extractTweetVideo(`https://x.com/SpaceX/status/${TWEET_ID}`);
    expect(result.source).toBe('fxtwitter');
    expect(calls).toHaveLength(2);
  });

  it('stops at the first lane that succeeds', async () => {
    const calls = stubFetch([['cdn.syndication.twimg.com', ok(SYNDICATION_BODY)]]);
    const result = await extractTweetVideo(`https://x.com/SpaceX/status/${TWEET_ID}`);
    expect(result.source).toBe('syndication');
    expect(calls).toHaveLength(1);
  });

  it('answers 400 for a URL that is not a tweet', async () => {
    await expect(extractTweetVideo('https://example.com/nope')).rejects.toMatchObject({ status: 400 });
  });

  it('answers 502, not 404, when every lane fails to reach X', async () => {
    stubFetch([
      ['cdn.syndication.twimg.com', status(500)],
      ['api.fxtwitter.com', status(500)],
    ]);
    const error = await extractTweetVideo(`https://x.com/SpaceX/status/${TWEET_ID}`).catch((e) => e);
    expect(error).toBeInstanceOf(VideoExtractionError);
    expect(error.status).toBe(502);
    expect(error.details).toHaveLength(2);
  });

  it('keeps the deleted-tweet wording when a lane reached X and found nothing', async () => {
    stubFetch([
      ['cdn.syndication.twimg.com', status(404)],
      ['api.fxtwitter.com', status(500)],
    ]);
    const error = await extractTweetVideo(`https://x.com/SpaceX/status/${TWEET_ID}`).catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.message).toMatch(/does not exist/);
  });

  it('only runs the GraphQL lane when a bearer token is configured', async () => {
    const calls = stubFetch([
      ['cdn.syndication.twimg.com', status(500)],
      ['api.fxtwitter.com', status(500)],
      ['guest/activate.json', ok({ guest_token: '123' })],
      ['TweetResultByRestId', status(403)],
    ]);
    await extractTweetVideo(`https://x.com/SpaceX/status/${TWEET_ID}`, { bearerToken: 'test-bearer' }).catch(() => {});
    expect(calls.some((u) => u.includes('TweetResultByRestId'))).toBe(true);
  });
});

describe('download proxy guards', () => {
  it('allows only Twitter media hosts over https', () => {
    expect(assertMediaUrl(`${CDN}/vid/avc1/480x270/1gKa.mp4`).hostname).toBe('video.twimg.com');
    expect(assertMediaUrl(encodeURIComponent('https://pbs.twimg.com/media/x.jpg')).hostname).toBe('pbs.twimg.com');
    expect(() => assertMediaUrl('https://evil.example.com/a.mp4')).toThrow(/Twitter video CDN/);
    expect(() => assertMediaUrl('http://video.twimg.com/a.mp4')).toThrow(/HTTPS/);
    expect(() => assertMediaUrl('not a url')).toThrow(/Invalid URL format/);
  });

  it('builds a filesystem-safe download filename', () => {
    expect(downloadFilename('SpaceX', TWEET_ID)).toBe(`SpaceX_${TWEET_ID}.mp4`);
    expect(downloadFilename('a/b"c', '12;3')).toBe('a_b_c_12_3.mp4');
    expect(downloadFilename('', '')).toBe('video_tweet.mp4');
  });
});
