// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
/**
 * Edge-safe tweet video extraction
 *
 * Every lane in here is plain `fetch` + JSON, with no Node built-ins and no
 * browser, so the exact same code runs in three places:
 *
 *   - Cloudflare Pages Functions (`functions/api/video/*`), what xactions.app
 *     serves, where Puppeteer and Postgres do not exist
 *   - the Express API (`api/services/videoExtractor.js`), which adds a
 *     Puppeteer lane underneath these
 *   - the CLI / library, via `extractTweetVideo()`
 *
 * Lane order (first success wins):
 *   1. Twitter's public syndication endpoint. No auth, returns every mp4
 *      variant, the widest quality ladder of the three.
 *   2. fxtwitter. Independent third party, alive when syndication rate-limits.
 *   3. Guest-token GraphQL. Richest metadata, but needs TWITTER_BEARER_TOKEN
 *      set, so it only runs when one is configured.
 *
 * @module src/video/edgeExtractor
 * @author nichxbt
 */

const TWEET_URL_RE = /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const LANE_TIMEOUT_MS = 10000;

const GRAPHQL_TWEET_RESULT = 'https://api.x.com/graphql/GZsN2Pc4knAoit6pXa4HSA/TweetResultByRestId';

/**
 * Extraction failure carrying the HTTP status the API surface should answer with.
 * 404 = the tweet is fine but holds no video, 400 = bad input, 502 = every lane
 * failed for reasons outside the caller's control.
 */
export class VideoExtractionError extends Error {
  constructor(message, status = 502, details = []) {
    super(message);
    this.name = 'VideoExtractionError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Parse and validate a tweet URL.
 * @param {string} url
 * @returns {{ username: string, tweetId: string } | null}
 */
export function parseTweetUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.trim().match(TWEET_URL_RE);
  if (!match) return null;
  return { username: match[1], tweetId: match[2] };
}

/**
 * Human label for a video variant's resolution.
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function getQualityLabel(width, height) {
  const maxDim = Math.max(width || 0, height || 0);
  if (maxDim >= 3840) return '4K';
  if (maxDim >= 2560) return '1440p';
  if (maxDim >= 1920) return '1080p';
  if (maxDim >= 1280) return '720p';
  if (maxDim >= 640) return '480p';
  if (maxDim >= 480) return '360p';
  if (maxDim > 0) return `${maxDim}p`;
  return 'unknown';
}

/**
 * Twitter's syndication endpoint derives its access token from the tweet ID
 * with this exact expression (base-36 of the ID scaled by PI, zeroes and the
 * decimal point stripped). Same formula the x.com embed bundle ships.
 * @param {string} tweetId
 * @returns {string}
 */
export function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '');
}

/**
 * True when a variant URL points at a real mp4 file. Twitter and fxtwitter both
 * mix HLS playlists (.m3u8) into the same variant list, and a playlist cannot be
 * saved as a video file, so those never reach the download buttons.
 */
function isMp4Url(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return false;
  }
}

function dimensionsFromUrl(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  return match
    ? { width: parseInt(match[1], 10), height: parseInt(match[2], 10) }
    : { width: 0, height: 0 };
}

/**
 * Normalize one mp4 variant into the wire shape the dashboard renders.
 */
function toVariant(url, { width, height, bitrate } = {}) {
  const derived = dimensionsFromUrl(url);
  const w = width || derived.width;
  const h = height || derived.height;
  return {
    url,
    quality: getQualityLabel(w, h),
    width: w,
    height: h,
    bitrate: bitrate || 0,
    contentType: 'video/mp4',
  };
}

/**
 * Drop duplicate variants (ignoring query strings) and sort best quality first.
 */
function rankVariants(videos) {
  const seen = new Set();
  const unique = [];
  for (const video of videos) {
    const base = video.url.split('?')[0];
    if (seen.has(base)) continue;
    seen.add(base);
    unique.push(video);
  }
  unique.sort((a, b) => (b.width * b.height || b.bitrate) - (a.width * a.height || a.bitrate));
  return unique;
}

async function fetchJson(url, { headers = {}, method = 'GET', label } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...BROWSER_HEADERS, ...headers },
    signal: AbortSignal.timeout(LANE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`${label} responded HTTP ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  const body = await response.text();
  if (!body) {
    throw new Error(`${label} returned an empty body`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a non-JSON body`);
  }
}

// ============================================================================
// Lane 1: Twitter syndication (no auth)
// ============================================================================

/**
 * Extract via `cdn.syndication.twimg.com`, the endpoint the official embed
 * widget uses. No token, no account, and it returns the full variant ladder.
 * @param {string} tweetId
 * @param {string} username
 */
export async function extractViaSyndication(tweetId, username) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${syndicationToken(tweetId)}&lang=en`;
  let data;
  try {
    data = await fetchJson(url, {
      headers: { Accept: 'application/json', Referer: 'https://platform.twitter.com/' },
      label: 'syndication',
    });
  } catch (error) {
    if (error.upstreamStatus === 404) {
      throw new VideoExtractionError('This tweet does not exist, or it was deleted.', 404);
    }
    throw error;
  }

  if (data.__typename === 'TweetTombstone') {
    throw new VideoExtractionError('This tweet is unavailable (deleted, private, or age-restricted).', 404);
  }

  const media = data.mediaDetails || [];
  const videos = [];
  let thumbnail = null;
  let duration = null;

  for (const item of media) {
    if (item.type !== 'video' && item.type !== 'animated_gif') continue;
    if (!thumbnail && item.media_url_https) thumbnail = item.media_url_https;
    if (!duration && item.video_info?.duration_millis) duration = item.video_info.duration_millis;
    for (const variant of item.video_info?.variants || []) {
      if (variant.content_type !== 'video/mp4' || !isMp4Url(variant.url)) continue;
      videos.push(toVariant(variant.url, { bitrate: variant.bitrate }));
    }
  }

  if (videos.length === 0) {
    throw new VideoExtractionError('No video found in this tweet.', 404);
  }

  return {
    videos: rankVariants(videos),
    thumbnail,
    duration,
    author: data.user?.name || username,
    username: data.user?.screen_name || username,
    tweetId,
    text: data.text || null,
    source: 'syndication',
  };
}

// ============================================================================
// Lane 2: fxtwitter
// ============================================================================

/**
 * Extract via the fxtwitter JSON API. Its `formats` array carries the same
 * quality ladder Twitter serves, so read it before falling back to the single
 * top-level `url`.
 * @param {string} tweetId
 * @param {string} username
 */
export async function extractViaFxTwitter(tweetId, username) {
  let data;
  try {
    data = await fetchJson(`https://api.fxtwitter.com/${username}/status/${tweetId}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'XActions/1.0 (+https://github.com/nirholas/XActions)' },
      label: 'fxtwitter',
    });
  } catch (error) {
    if (error.upstreamStatus === 404) {
      throw new VideoExtractionError('This tweet does not exist, or it was deleted.', 404);
    }
    throw error;
  }

  const tweet = data?.tweet;
  if (!tweet) {
    throw new VideoExtractionError('This tweet is unavailable (deleted, private, or age-restricted).', 404);
  }

  const items = tweet.media?.videos || (tweet.media?.all || []).filter((m) => m.type === 'video' || m.type === 'gif');
  const videos = [];
  let thumbnail = null;
  let duration = null;

  for (const item of items) {
    if (!thumbnail && item.thumbnail_url) thumbnail = item.thumbnail_url;
    if (!duration && item.duration) duration = Math.round(item.duration * 1000);

    const ladder = item.formats || item.variants || [];
    for (const variant of ladder) {
      if (!variant.url || !isMp4Url(variant.url)) continue;
      videos.push(toVariant(variant.url, { width: variant.width, height: variant.height, bitrate: variant.bitrate }));
    }

    if (item.url && isMp4Url(item.url)) {
      videos.push(toVariant(item.url, { width: item.width, height: item.height, bitrate: item.bitrate }));
    }
  }

  if (videos.length === 0) {
    throw new VideoExtractionError('No video found in this tweet.', 404);
  }

  return {
    videos: rankVariants(videos),
    thumbnail,
    duration,
    author: tweet.author?.name || username,
    username: tweet.author?.screen_name || username,
    tweetId,
    text: tweet.text || null,
    source: 'fxtwitter',
  };
}

// ============================================================================
// Lane 3: guest-token GraphQL (needs a bearer token)
// ============================================================================

const GRAPHQL_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: false,
  responsive_web_grok_annotations_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const GRAPHQL_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withArticleSummaryText: false,
  withArticleVoiceOver: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
  withPayments: false,
  withAuxiliaryUserLabels: false,
};

/**
 * Mint a Twitter guest token. Callers cache it; tokens last roughly three hours.
 * @param {string} bearerToken
 * @returns {Promise<string>}
 */
export async function mintGuestToken(bearerToken) {
  const data = await fetchJson('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearerToken}`, Referer: 'https://x.com/', Origin: 'https://x.com' },
    label: 'guest activation',
  });
  if (!data.guest_token) {
    throw new Error('guest activation returned no guest_token');
  }
  return data.guest_token;
}

/**
 * Extract via x.com's GraphQL TweetResultByRestId with a guest token.
 * @param {string} tweetId
 * @param {string} username
 * @param {{ bearerToken: string, guestToken?: string }} options
 */
export async function extractViaGraphQL(tweetId, username, { bearerToken, guestToken } = {}) {
  if (!bearerToken) {
    throw new Error('GraphQL lane needs TWITTER_BEARER_TOKEN');
  }
  const token = guestToken || (await mintGuestToken(bearerToken));

  const variables = JSON.stringify({
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  });
  const url = `${GRAPHQL_TWEET_RESULT}?variables=${encodeURIComponent(variables)}`
    + `&features=${encodeURIComponent(JSON.stringify(GRAPHQL_FEATURES))}`
    + `&fieldToggles=${encodeURIComponent(JSON.stringify(GRAPHQL_FIELD_TOGGLES))}`;

  const data = await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Referer: 'https://x.com/',
      Origin: 'https://x.com',
      'x-guest-token': token,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
    label: 'graphql',
  });

  const result = data?.data?.tweetResult?.result;
  if (!result || result.__typename === 'TweetTombstone') {
    throw new VideoExtractionError('This tweet is unavailable (deleted, private, or age-restricted).', 404);
  }

  const tweet = result.tweet || result;
  const legacy = tweet.legacy || {};
  const user = tweet.core?.user_results?.result || {};
  const userLegacy = user.legacy || user.core || {};

  const media = legacy.extended_entities?.media || legacy.entities?.media || [];
  const videos = [];
  let thumbnail = null;
  let duration = null;

  for (const item of media) {
    if (item.type !== 'video' && item.type !== 'animated_gif') continue;
    if (!thumbnail && item.media_url_https) thumbnail = item.media_url_https;
    if (!duration && item.video_info?.duration_millis) duration = item.video_info.duration_millis;
    for (const variant of item.video_info?.variants || []) {
      if (variant.content_type !== 'video/mp4' || !isMp4Url(variant.url)) continue;
      videos.push(toVariant(variant.url, { bitrate: variant.bitrate }));
    }
  }

  if (videos.length === 0) {
    throw new VideoExtractionError('No video found in this tweet.', 404);
  }

  return {
    videos: rankVariants(videos),
    thumbnail,
    duration,
    author: userLegacy.name || username,
    username: userLegacy.screen_name || username,
    tweetId,
    text: legacy.full_text || null,
    source: 'graphql',
  };
}

// ============================================================================
// Lane chain
// ============================================================================

/**
 * Run every edge-safe lane in order and return the first success.
 *
 * @param {string} tweetUrl full tweet URL (x.com or twitter.com)
 * @param {{ bearerToken?: string }} [options]
 * @returns {Promise<Object>} { videos, thumbnail, duration, author, username, tweetId, text, source }
 * @throws {VideoExtractionError}
 */
export async function extractTweetVideo(tweetUrl, { bearerToken } = {}) {
  const parsed = parseTweetUrl(tweetUrl);
  if (!parsed) {
    throw new VideoExtractionError('Invalid URL. Expected a tweet link like https://x.com/user/status/123.', 400);
  }

  const { tweetId, username } = parsed;
  const lanes = [
    ['syndication', () => extractViaSyndication(tweetId, username)],
    ['fxtwitter', () => extractViaFxTwitter(tweetId, username)],
  ];
  if (bearerToken) {
    lanes.push(['graphql', () => extractViaGraphQL(tweetId, username, { bearerToken })]);
  }

  const failures = [];
  let verdict = null;

  for (const [name, run] of lanes) {
    try {
      return await run();
    } catch (error) {
      // A lane that reached X and found no video (or no tweet) has answered the
      // question. Keep its wording so the page can say which of the two it was.
      if (!verdict && error instanceof VideoExtractionError && error.status === 404) verdict = error;
      failures.push(`${name}: ${error.message}`);
    }
  }

  if (verdict) {
    const message = verdict.message === 'No video found in this tweet.'
      ? 'No video found in this tweet. Make sure the post actually contains a video or GIF.'
      : verdict.message;
    throw new VideoExtractionError(message, 404, failures);
  }

  throw new VideoExtractionError(
    'Could not reach X to read this tweet. It may be rate-limited right now, so try again in a minute.',
    502,
    failures,
  );
}

/** Hosts the download proxy is allowed to stream from. */
export const ALLOWED_MEDIA_HOSTS = ['video.twimg.com', 'pbs.twimg.com'];

/**
 * Validate a media URL before proxying it, so the endpoint can never be turned
 * into an open proxy for arbitrary hosts.
 * @param {string} rawUrl
 * @returns {URL}
 * @throws {VideoExtractionError}
 */
export function assertMediaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(decodeURIComponent(rawUrl));
  } catch {
    throw new VideoExtractionError('Invalid URL format.', 400);
  }
  if (parsed.protocol !== 'https:') {
    throw new VideoExtractionError('Only HTTPS URLs are allowed.', 400);
  }
  if (!ALLOWED_MEDIA_HOSTS.includes(parsed.hostname)) {
    throw new VideoExtractionError('Invalid video URL. Must be a Twitter video CDN URL.', 400);
  }
  return parsed;
}

/**
 * Build the `{author}_{tweetId}.mp4` download filename, stripped of anything
 * that could break a Content-Disposition header.
 * @param {string} author
 * @param {string} tweetId
 * @returns {string}
 */
export function downloadFilename(author, tweetId) {
  const safeAuthor = String(author || 'video').replace(/[^\w-]/g, '_').slice(0, 50);
  const safeTweetId = String(tweetId || 'tweet').replace(/[^\w-]/g, '_').slice(0, 30);
  return `${safeAuthor}_${safeTweetId}.mp4`;
}
