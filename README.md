# XActions Video Downloader

Free X/Twitter video downloader that runs entirely at the edge on Cloudflare Pages. No login, no app install, no backend server, no database. Paste a post URL, pick a quality, get the MP4.

Live at **https://xactions.app/video**. Extracted from [XActions](https://github.com/nirholas/XActions) with its commit history intact.

## How it works

```
public/index.html            the page (works without JavaScript via a plain form POST)
functions/api/video/
  extract.js                 POST /api/video/extract       { url } -> every MP4 variant
  download.js                GET  /api/video/download      streams the MP4 with a filename
  extract-form.js            POST /api/video/extract-form  no-JS fallback, redirects to the best MP4
src/edgeExtractor.js         the extraction lanes (plain fetch, no Node built-ins)
src/edgeHttp.js              CORS + JSON response helpers
```

Extraction tries each lane in order and returns the first success:

1. **X's public syndication endpoint.** No auth, returns the widest quality ladder.
2. **fxtwitter.** Independent third party, alive when syndication rate-limits.
3. **Guest-token GraphQL.** Richest metadata. Runs only when `TWITTER_BEARER_TOKEN` is set.

Successful extractions are cached at the edge for an hour per post ID. The download proxy only accepts `video.twimg.com` and `pbs.twimg.com` URLs, so it can never act as an open proxy.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:8788 (also served at /video)
npm test
```

Try the API:

```bash
curl -s -X POST http://localhost:8788/api/video/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://x.com/SpaceX/status/1732824684683784516"}'
```

Response (trimmed):

```json
{
  "tweetId": "1732824684683784516",
  "username": "SpaceX",
  "videos": [
    { "url": "https://video.twimg.com/...1920x1080...mp4", "quality": "1080p", "width": 1920, "height": 1080, "bitrate": 10368000, "contentType": "video/mp4" }
  ]
}
```

Variants are sorted best first. Pass any variant to `/api/video/download?url=<mp4>&author=<handle>&tweetId=<id>` to get it back as an attachment named `<handle>_<id>.mp4`.

Errors return `{ "error": "..." }` with `400` (bad URL), `404` (no video in the post), or `502` (every lane failed).

## Deploy

```bash
npx wrangler login
npm run deploy                                        # creates the Pages project on first run
npx wrangler pages secret put TWITTER_BEARER_TOKEN    # optional, enables lane 3
```

CORS allows `https://xactions.app` and `https://www.xactions.app` (see `src/edgeHttp.js`). Same-origin use needs no change; add your origin there if another site calls the API from the browser.

## License

Apache-2.0. See [LICENSE](LICENSE). Not affiliated with X Corp.
