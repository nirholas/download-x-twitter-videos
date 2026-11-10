---
name: download-x-video
description: Get the MP4 variants (1080p, 720p and lower) of a video in a public X/Twitter post and save one to disk using the xactions.app video API. Use when the user gives a post URL and wants the video file or its direct links.
---

# X/Twitter video download API

The repo is a Cloudflare Pages app that extracts video variants from a public post without login. It is live at https://xactions.app/video, and the same API can run locally. It only works on posts that actually contain a video, and is not affiliated with X Corp. Only download media the user is entitled to keep.

## Endpoints

Base URL `https://xactions.app` (or `http://localhost:8788` locally).

- `POST /api/video/extract` with JSON `{"url": "<post url>"}`. Returns `tweetId`, `username` and `videos`, best quality first. Each variant has `url`, `quality`, `width`, `height`, `bitrate`, `contentType`.
- `GET /api/video/download?url=<mp4 url>&author=<handle>&tweetId=<id>`. Streams the MP4 as an attachment named `<handle>_<id>.mp4`. Only `video.twimg.com` and `pbs.twimg.com` URLs are accepted.
- `POST /api/video/extract-form`. Form fallback used by the web page; prefer `extract`.

Errors are `{"error": "..."}` with 400 (bad URL), 404 (no video in the post) or 502 (every extraction lane failed).

## Worked example

```bash
curl -s -X POST https://xactions.app/api/video/extract \
  -H 'content-type: application/json' \
  -d '{"url":"https://x.com/SpaceX/status/1732824684683784516"}' > post.json

jq -r '.videos[0].quality, .videos[0].url' post.json

curl -sL -o SpaceX_1732824684683784516.mp4 \
  "https://xactions.app/api/video/download?url=$(jq -r '.videos[0].url|@uri' post.json)&author=SpaceX&tweetId=1732824684683784516"
```

Pick a lower variant by indexing `.videos[N]` or filtering on `.quality`.

## Notes

- Extraction tries X's public syndication endpoint, then fxtwitter, then a guest-token GraphQL lane that only runs when the server has `TWITTER_BEARER_TOKEN` set. Results are cached for an hour per post ID.
- Browser calls from other origins are limited by CORS to xactions.app. Call from a server or CLI.
- Self-host: clone https://github.com/nirholas/download-x-twitter-videos, run `npm install` then `npm run dev` (port 8788), deploy with `npm run deploy` (Cloudflare Pages via wrangler).
