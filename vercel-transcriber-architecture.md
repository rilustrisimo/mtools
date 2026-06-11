# mtools — Architecture & Flow Reference

> **Live URL:** https://mtools.gravitypointmedia.com
> **GitHub:** https://github.com/rilustrisimo/mtools
> **Hosting:** Vercel (Hobby plan)
> **Purpose:** Serverless AI hub for emeiglobal.com — transcribes Wistia videos
> that GoDaddy WordPress cannot handle (no Python, no ffmpeg, unreliable outbound DNS).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Project Structure](#2-project-structure)
3. [Full Request Flow — Mode A (Server / Cron)](#3-full-request-flow--mode-a-server--cron)
4. [Full Request Flow — Mode B (Browser / Interactive)](#4-full-request-flow--mode-b-browser--interactive)
5. [Combined Architecture Diagram](#5-combined-architecture-diagram)
6. [API Reference](#6-api-reference)
7. [Internal Libraries](#7-internal-libraries)
8. [Environment Variables](#8-environment-variables)
9. [CORS & Security](#9-cors--security)
10. [Vercel Configuration](#10-vercel-configuration)
11. [Bandwidth & Resource Usage](#11-bandwidth--resource-usage)
12. [Dependencies](#12-dependencies)
13. [WordPress Integration](#13-wordpress-integration)

---

## 1. System Overview

### What it does

WordPress (emeiglobal.com) stores Wistia video hashes. When a video needs
transcription, WordPress sends only the hash and a chunk index to mtools.
mtools fetches the relevant audio segment from Wistia's CDN, extracts it
with ffmpeg, and either:

- **(Mode A)** sends it to Groq's Whisper API and returns the transcript text
- **(Mode B)** returns the compressed audio so the browser can run Whisper locally

### Why two modes

| Constraint | Mode A (server) | Mode B (browser) |
|---|---|---|
| Vercel 10s timeout | Groq inference is ~3–4s/chunk ✅ | Browser has no timeout ✅ |
| Needs open browser tab | No — runs in WP cron ✅ | Yes — requires admin UI |
| API key required | Yes (`GROQ_API_KEY`) | No |
| Model quality | `whisper-large-v3` | `whisper-tiny.en` |
| Bandwidth (Vercel → client) | ~100 bytes (text only) | ~120 KB MP3 per chunk |
| Best used for | Scheduled background jobs | On-demand interactive |

### Why Groq (not HuggingFace, not local Whisper)

- **Local Whisper** (`@xenova/transformers` on Vercel): ONNX session creation
  alone takes 15–20s — exceeds Hobby 10s timeout before inference even starts.
- **HuggingFace Inference API**: `api-inference.huggingface.co` DNS fails to
  resolve from Vercel's network (same issue as WordPress PHP). Confirmed broken.
- **Groq API** (`api.groq.com`): resolves correctly from Vercel, inference
  completes in ~3–4s per chunk, free tier is generous.

---

## 2. Project Structure

```
mtools/
│
├── api/
│   ├── transcribe.js    POST /api/transcribe  — server path: ffmpeg → Groq → text
│   ├── audio.js         GET  /api/audio       — browser path: ffmpeg → MP3 bytes
│   └── health.js        GET  /api/health      — status check
│
├── lib/
│   ├── auth.js          shared secret verification (crypto.timingSafeEqual)
│   ├── wistia.js        fetch video CDN URL + duration from Wistia JSON API
│   ├── audio.js         ffmpeg byte-range extraction → WAV or MP3 buffer
│   └── whisper.js       Groq Whisper API call (used by server path only)
│
├── package.json         single dependency: ffmpeg-static
├── vercel.json          function timeouts + per-endpoint CORS headers
└── .env.local           local dev secrets (never committed)
```

**One npm dependency.** `ffmpeg-static` ships a prebuilt Linux x64 binary that
Vercel can execute. No AI/ML packages are installed server-side.

---

## 3. Full Request Flow — Mode A (Server / Cron)

Used by: WordPress cron jobs, WP-CLI, admin "re-process" triggers.

```
┌──────────────────────────────────────────────────────────────────┐
│  WordPress (emeiglobal.com / GoDaddy)                            │
│                                                                  │
│  PHP class: Thinkific_Vercel_Transcriber                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  checkpoint (post meta):                                   │  │
│  │  { status, chunk_index, total_chunks, transcripts: {} }   │  │
│  └────────────────────────────────────────────────────────────┘  │
│          │                                                        │
│          │  POST /api/transcribe                                  │
│          │  Content-Type: application/json                        │
│          │  Body: { wistia_hash, chunk_index, secret }  ~100B    │
│          │                                                        │
│          │  ← 200 { text, chunk_index, total_chunks, duration_s }│
│          │       or 503 { code: "MODEL_LOADING", retry_after_s } │
│          │       or 200 { done: true }  (past last chunk)        │
└──────────┼───────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  Vercel — api/transcribe.js                                      │
│  maxDuration: 10s   CORS: https://emeiglobal.com only            │
│                                                                  │
│  Step 1 — Auth                                                   │
│    verifySecret(secret)  →  crypto.timingSafeEqual vs HUB_SECRET │
│    fail → 401                                                    │
│                                                                  │
│  Step 2 — Wistia lookup  (lib/wistia.js)                        │
│    GET https://fast.wistia.com/embed/medias/{hash}.json          │
│    parse: media.duration, smallest MP4 asset URL                 │
│    fail → 500 WISTIA_FETCH_FAILED                                │
│                                                                  │
│  Step 3 — Chunk math                                             │
│    chunkDuration = CHUNK_DURATION_S env (default 30s)            │
│    totalChunks   = ceil(duration / chunkDuration)                │
│    startSeconds  = chunk_index × chunkDuration                   │
│    if startSeconds >= duration → 200 { done: true }              │
│                                                                  │
│  Step 4 — Audio extraction  (lib/audio.js)                      │
│    ffmpeg -ss START -t DURATION -i WISTIA_URL                    │
│           -vn -ar 16000 -ac 1 -f wav pipe:1                      │
│    → WAV buffer in memory (~1.9 MB for 60s)                      │
│    fail → 500 FFMPEG_FAILED                                      │
│                                                                  │
│  Step 5 — Groq Whisper inference  (lib/whisper.js)              │
│    POST https://api.groq.com/openai/v1/audio/transcriptions      │
│    multipart/form-data: file=audio.wav, model=whisper-large-v3   │
│    → { text: "..." }                                             │
│    fail → 500 WHISPER_FAILED                                     │
│                                                                  │
│  Step 6 — Return                                                 │
│    200 { text, chunk_index, total_chunks, duration_s }           │
└──────────────────────┬───────────────────────────────────────────┘
                       │ Step 4 — ffmpeg range request
           ┌───────────┴──────────────────────────────┐
           ▼                                          ▼
┌────────────────────┐              ┌──────────────────────────────┐
│  fast.wistia.com   │              │  Groq API                    │
│  /{hash}.json      │              │  api.groq.com                │
│  → MP4 URL +       │              │  whisper-large-v3            │
│    duration        │              │  → transcript text           │
└────────────────────┘              └──────────────────────────────┘
           │
           ▼ HTTP Range request (only chunk bytes, not full video)
┌────────────────────┐
│  Wistia CDN        │
│  embed.wistia.com  │
│  MP4 file          │
│  (~1.5 MB per 30s) │
└────────────────────┘
```

### Timing per chunk (30s chunk, warm Vercel function)

| Step | Time |
|---|---|
| Auth + validation | < 1 ms |
| Wistia JSON fetch | ~200 ms |
| ffmpeg byte-range download + extract | ~1–2 s |
| Groq Whisper inference | ~2–4 s |
| **Total** | **~3–6 s** ✅ well within 10s Hobby limit |

### Data sizes — Mode A

| Hop | Direction | Size |
|---|---|---|
| WordPress → Vercel | request body | ~100 bytes |
| Vercel → Wistia (range header) | outbound | ~0 bytes |
| Wistia CDN → Vercel | video segment | ~1.5 MB (30s) / ~1.9 MB (60s) |
| Vercel → Groq | WAV multipart | ~1.9 MB |
| Groq → Vercel | JSON text | ~200 bytes |
| **Vercel → WordPress** | **response** | **~500 bytes – 5 KB** |

Fast Origin Transfer consumed: **~5 KB per chunk** (text response back to WP).
The heavy Wistia→Vercel and Vercel→Groq hops are internal and not billed.

---

## 4. Full Request Flow — Mode B (Browser / Interactive)

Used by: admin browser tab running Whisper.js via WebAssembly.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (admin in WordPress dashboard)                             │
│                                                                     │
│  JavaScript loop — chunk_index = 0, 1, 2 ...                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                                                               │  │
│  │  ① First run only — load Whisper model (~39 MB, cached)      │  │
│  │    import { pipeline } from '@xenova/transformers' (CDN)      │  │
│  │    model: Xenova/whisper-tiny.en                              │  │
│  │    source: HuggingFace public CDN (no API key)                │  │
│  │    cached: browser Cache Storage / IndexedDB (permanent)      │  │
│  │                                                               │  │
│  │  ② Per chunk — fetch audio                                   │  │
│  │    GET /api/audio?wistia_hash=X&chunk_index=N&secret=Y        │  │
│  │    ← 200 audio/mpeg  ~120 KB  (MP3 16kbps 16kHz mono)        │  │
│  │       headers: X-Chunk-Index, X-Total-Chunks, X-Duration-S   │  │
│  │    or 204 No Content  X-Done: true  (all chunks processed)    │  │
│  │                                                               │  │
│  │  ③ Decode MP3 → PCM (AudioContext.decodeAudioData)           │  │
│  │    Pass Float32Array to Whisper pipeline                      │  │
│  │    → result.text  (runs in Web Worker, non-blocking)          │  │
│  │                                                               │  │
│  │  ④ POST text + chunk_index to WordPress REST API / AJAX      │  │
│  │    WordPress stores chunk in post meta checkpoint             │  │
│  │                                                               │  │
│  │  Repeat until X-Done: true                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────────┘
                             │  ② GET /api/audio
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Vercel — api/audio.js                                              │
│  maxDuration: 15s   CORS: * (open)                                  │
│                                                                     │
│  Step 1 — Auth                                                      │
│    verifySecret(secret)  →  crypto.timingSafeEqual vs HUB_SECRET    │
│    fail → 401                                                       │
│                                                                     │
│  Step 2 — Wistia lookup  (lib/wistia.js)                           │
│    Same as Mode A — get MP4 URL + duration                          │
│                                                                     │
│  Step 3 — Chunk math                                                │
│    Same formula as Mode A                                           │
│    if startSeconds >= duration → 204 + X-Done: true                │
│                                                                     │
│  Step 4 — Audio extraction  (lib/audio.js, format: 'mp3')         │
│    ffmpeg -ss START -t DURATION -i WISTIA_URL                       │
│           -vn -ar 16000 -ac 1                                       │
│           -codec:a libmp3lame -b:a 16k -f mp3 pipe:1               │
│    → MP3 buffer in memory (~120 KB for 60s)                         │
│    fail → 500 FFMPEG_FAILED                                         │
│                                                                     │
│  Step 5 — Stream MP3 to browser                                     │
│    200 Content-Type: audio/mpeg                                     │
│    Cache-Control: public, max-age=3600, immutable                   │
│    X-Chunk-Index, X-Total-Chunks, X-Duration-S                      │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ Step 4 — ffmpeg range request
              ┌─────────────┴────────────────────────┐
              ▼                                      ▼
┌────────────────────┐              ┌──────────────────────────────┐
│  fast.wistia.com   │              │  HuggingFace CDN             │
│  /{hash}.json      │              │  cdn-lfs.hf.co (or similar)  │
│  → MP4 URL +       │              │  Xenova/whisper-tiny.en      │
│    duration        │              │  ONNX model weights ~39 MB   │
└────────────────────┘              │  (browser fetches once,      │
              │                     │   cached permanently)        │
              ▼                     └──────────────────────────────┘
┌────────────────────┐
│  Wistia CDN        │
│  embed.wistia.com  │
│  MP4 file          │
│  (byte-range only) │
└────────────────────┘
```

### Data sizes — Mode B

| Hop | Direction | Size |
|---|---|---|
| Browser → Vercel | GET query string | ~200 bytes |
| Vercel → Wistia (range header) | outbound | ~0 bytes |
| Wistia CDN → Vercel | video segment | ~1.5 MB |
| **Vercel → Browser** | **MP3 chunk** | **~120 KB** ← Fast Origin Transfer |
| HuggingFace CDN → Browser | model weights (once) | ~39 MB (browser-cached) |
| Browser → WordPress | text per chunk | ~500 bytes |

Fast Origin Transfer consumed: **~120 KB per chunk** (vs ~1.9 MB if WAV).
A 4.8-hour video (291 chunks): ~34 MB total vs ~553 MB before the MP3 optimization.

---

## 5. Combined Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    emeiglobal.com (WordPress)                        │
│                                                                      │
│  ┌────────────────────┐       ┌──────────────────────────────────┐  │
│  │  WP Cron / Admin   │       │  Browser (admin tab)             │  │
│  │  PHP trigger       │       │  @xenova/transformers (WASM)     │  │
│  └─────────┬──────────┘       └───────────────┬──────────────────┘  │
└────────────┼──────────────────────────────────┼─────────────────────┘
             │                                  │
             │  MODE A                          │  MODE B
             │  POST /api/transcribe            │  GET /api/audio
             │  { wistia_hash,                  │  ?wistia_hash=
             │    chunk_index,                  │   &chunk_index=
             │    secret }                      │   &secret=
             │                                  │
             ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│               mtools.gravitypointmedia.com  (Vercel)                 │
│                                                                      │
│  ┌─────────────────────────┐  ┌──────────────────────────────────┐  │
│  │  api/transcribe.js      │  │  api/audio.js                    │  │
│  │  CORS: emeiglobal.com   │  │  CORS: *                         │  │
│  │  maxDuration: 10s       │  │  maxDuration: 15s                │  │
│  │                         │  │                                  │  │
│  │  1. verify HUB_SECRET   │  │  1. verify HUB_SECRET            │  │
│  │  2. Wistia lookup       │  │  2. Wistia lookup                │  │
│  │  3. ffmpeg → WAV        │  │  3. ffmpeg → MP3 16kbps          │  │
│  │  4. Groq Whisper API    │  │  4. stream MP3 (~120 KB)         │  │
│  │  5. return text         │  │     + cache headers              │  │
│  └────────────┬────────────┘  └────────────────┬─────────────────┘  │
│               │                                │                    │
│      ┌────────┴────────────────────────────────┘                    │
│      │          lib/wistia.js + lib/audio.js                        │
│      │   fetch Wistia JSON → get CDN URL + duration                 │
│      │   spawn ffmpeg with byte-range HTTP fetch                    │
│      └────────┬────────────────────────────────┬────────────────────┘
                │                                │
                ▼ (both modes)                   ▼ (Mode A only)
┌──────────────────────┐           ┌─────────────────────────────┐
│  fast.wistia.com     │           │  Groq API                   │
│  /{hash}.json        │           │  api.groq.com               │
│  → MP4 URL           │           │  whisper-large-v3           │
│  → duration          │           │  ~3–4s inference            │
└──────────┬───────────┘           └─────────────────────────────┘
           │ ffmpeg byte-range
           ▼
┌──────────────────────┐
│  Wistia CDN          │
│  embed.wistia.com    │
│  only the relevant   │
│  video segment bytes │
└──────────────────────┘
```

---

## 6. API Reference

### POST `/api/transcribe`

Server-side transcription. Called by WordPress PHP.

**Request**
```json
{
  "wistia_hash":  "cpkghxeijh",
  "chunk_index":  0,
  "secret":       "your_hub_secret"
}
```

**Response — chunk transcribed**
```json
{
  "text":         "Welcome to this lesson. Today we will cover...",
  "chunk_index":  0,
  "total_chunks": 291,
  "duration_s":   17416.1
}
```

**Response — past last chunk (done)**
```json
{
  "text":         "",
  "chunk_index":  291,
  "total_chunks": 291,
  "done":         true
}
```

**Response — Groq model cold start (rare)**
```json
{
  "error":         "HuggingFace model is loading, retry shortly",
  "code":          "MODEL_LOADING",
  "retry_after_s": 20
}
```
Status: 503. WordPress should retry after `retry_after_s`.

**Error responses**
| Status | `code` | Cause |
|---|---|---|
| 401 | `INVALID_SECRET` | Wrong or missing secret |
| 400 | `BAD_REQUEST` | Invalid wistia_hash or chunk_index |
| 500 | `WISTIA_FETCH_FAILED` | Wistia JSON API unreachable or hash not found |
| 500 | `FFMPEG_FAILED` | Audio extraction error |
| 500 | `WHISPER_FAILED` | Groq API error |

---

### GET `/api/audio`

Browser-side audio delivery. Returns compressed MP3 for local Whisper inference.

**Query parameters**
| Param | Type | Description |
|---|---|---|
| `wistia_hash` | string | Wistia media hash (10–12 lowercase alphanumeric chars) |
| `chunk_index` | integer | Zero-based chunk index |
| `secret` | string | Shared secret (matches `HUB_SECRET` env var) |

**Example**
```
GET /api/audio?wistia_hash=cpkghxeijh&chunk_index=0&secret=your_hub_secret
```

**Response — audio chunk**
```
HTTP 200
Content-Type:   audio/mpeg
Content-Length: 122880
Cache-Control:  public, max-age=3600, immutable
X-Chunk-Index:  0
X-Total-Chunks: 291
X-Duration-S:   17416.1

[MP3 binary body ~120 KB]
```

**Response — all chunks processed**
```
HTTP 204 No Content
X-Done:         true
X-Total-Chunks: 291
```

**Note on caching:** `Cache-Control: public, max-age=3600, immutable` tells Vercel's
CDN to cache each chunk for 1 hour. A given `wistia_hash + chunk_index` always
produces identical bytes, so cached responses are safe and save Fast Origin Transfer.

---

### GET `/api/health`

Returns service status and configuration.

**Response**
```json
{
  "status":          "ok",
  "model":           "whisper-large-v3",
  "backend":         "groq-whisper-api",
  "groq_key_set":    true,
  "chunk_duration_s": 30,
  "version":         "1.0.0"
}
```

---

## 7. Internal Libraries

### `lib/auth.js`

Constant-time secret comparison using Node.js built-in `crypto`.

```javascript
import { timingSafeEqual } from 'crypto';

export function verifySecret(secret) {
  const expected = process.env.HUB_SECRET;
  if (!expected || !secret) return false;
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(secret), 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
}
```

`timingSafeEqual` prevents timing-based secret enumeration attacks.
Length check is done first (required — `timingSafeEqual` throws on different lengths).

---

### `lib/wistia.js`

Fetches the smallest available MP4 asset URL and video duration from
Wistia's public JSON embed API.

```
GET https://fast.wistia.com/embed/medias/{hash}.json
```

Asset priority (smallest first): `mp4_video`, `iphone_video`, `md_mp4_video`,
`hd_mp4_video`. Smallest is chosen to minimise the byte-range download. Wistia
MP4s have `faststart` (moov atom at start), so ffmpeg can seek without reading
the whole file.

---

### `lib/audio.js`

Spawns the bundled `ffmpeg-static` binary to extract an audio segment via
HTTP range request. Accepts a `format` option: `'wav'` (default, for Groq)
or `'mp3'` (for browser endpoint).

**WAV output** (used by `/api/transcribe`):
```
ffmpeg -ss START -t DURATION -i WISTIA_URL
       -vn -ar 16000 -ac 1 -f wav pipe:1
```

**MP3 output** (used by `/api/audio`):
```
ffmpeg -ss START -t DURATION -i WISTIA_URL
       -vn -ar 16000 -ac 1
       -codec:a libmp3lame -b:a 16k -f mp3 pipe:1
```

Both: 16 kHz sample rate, mono, no video track. These are Whisper's required
input parameters. ffmpeg downloads only the bytes covering the requested time
window — not the full video file.

---

### `lib/whisper.js`

Calls Groq's OpenAI-compatible audio transcription endpoint using native
Node.js `FormData` and `fetch`. No npm packages needed.

```
POST https://api.groq.com/openai/v1/audio/transcriptions
Authorization: Bearer GROQ_API_KEY
Content-Type: multipart/form-data

file:            audio.wav  (WAV buffer)
model:           whisper-large-v3  (or WHISPER_MODEL env var)
language:        en
response_format: json
```

Returns `result.text` — plain transcript string.

---

## 8. Environment Variables

Set these in the Vercel dashboard under Project → Settings → Environment Variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HUB_SECRET` | **YES** | — | Shared secret for all endpoint auth. Set the same value in WordPress settings. Rotate both together. |
| `GROQ_API_KEY` | **YES** (Mode A) | — | Groq API key. Get free at console.groq.com. Only needed for `/api/transcribe`. |
| `WHISPER_MODEL` | no | `whisper-large-v3` | Groq model ID. Options: `whisper-large-v3`, `whisper-large-v3-turbo`, `distil-whisper-large-v3-en`. |
| `CHUNK_DURATION_S` | no | `30` | Seconds per chunk. 30s keeps server path well within 10s timeout. Browser path can use 60s safely. |

**Local development — `.env.local`:**
```
HUB_SECRET=your_secret_here
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WHISPER_MODEL=whisper-large-v3
CHUNK_DURATION_S=30
```

**In WordPress (PHP options or `.env`):**
```
THINKIFIC_VERCEL_URL=https://mtools.gravitypointmedia.com
THINKIFIC_VERCEL_SECRET=same_value_as_HUB_SECRET
```

---

## 9. CORS & Security

### CORS per endpoint

| Endpoint | Allowed Origin | Why |
|---|---|---|
| `/api/transcribe` | `https://emeiglobal.com` only | Server-to-server PHP calls only |
| `/api/audio` | `*` (open) | Browser JS may run from any domain |
| `/api/health` | `*` (open) | Monitoring tools, curl, etc. |

`/api/audio` exposes custom response headers to the browser via:
```
Access-Control-Expose-Headers: X-Total-Chunks, X-Chunk-Index, X-Duration-S, X-Done
```
Without this, JavaScript `response.headers.get('X-Total-Chunks')` returns null
even on a successful 200 response.

### Secret auth

All three endpoints verify `HUB_SECRET`:
- POST body field `secret` for `/api/transcribe`
- Query param `secret` for `/api/audio`

Constant-time comparison via `crypto.timingSafeEqual` prevents timing attacks.
Returns HTTP 401 `{ error: "Unauthorized", code: "INVALID_SECRET" }` on failure.

### Input validation

- `wistia_hash`: must match `/^[a-z0-9]{10,12}$/` — rejects SQL injection,
  path traversal, or arbitrary URL construction
- `chunk_index`: must be a non-negative integer
- No user-uploaded content ever touches the server

---

## 10. Vercel Configuration

### `vercel.json`

```json
{
  "functions": {
    "api/transcribe.js": { "maxDuration": 10 },
    "api/audio.js":      { "maxDuration": 15 },
    "api/health.js":     { "maxDuration": 5  }
  },
  "headers": [
    {
      "source": "/api/transcribe",
      "headers": [
        { "key": "Access-Control-Allow-Origin",  "value": "https://emeiglobal.com" },
        { "key": "Access-Control-Allow-Methods", "value": "POST, OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type" }
      ]
    },
    {
      "source": "/api/audio",
      "headers": [
        { "key": "Access-Control-Allow-Origin",   "value": "*" },
        { "key": "Access-Control-Allow-Methods",  "value": "GET, OPTIONS" },
        { "key": "Access-Control-Expose-Headers", "value": "X-Total-Chunks, X-Chunk-Index, X-Duration-S, X-Done" }
      ]
    },
    {
      "source": "/api/health",
      "headers": [
        { "key": "Access-Control-Allow-Origin",  "value": "*" },
        { "key": "Access-Control-Allow-Methods", "value": "GET, OPTIONS" }
      ]
    }
  ]
}
```

### Vercel Hobby plan limits (relevant)

| Limit | Value | Current usage |
|---|---|---|
| Function timeout | 10s | `/api/transcribe` uses ~3–6s ✅ |
| Fast Data Transfer (CDN→user) | 100 GB/mo | ~9 GB used |
| Fast Origin Transfer (function→CDN) | **10 GB/mo** | ~8.7 GB used ⚠️ |
| Function invocations | unlimited | not an issue |

Fast Origin Transfer is the critical limit. See Section 11 for optimization details.

---

## 11. Bandwidth & Resource Usage

### What counts as Fast Origin Transfer

Data sent from a Vercel function's response to the caller (browser or WordPress).
**Does not include** Wistia CDN → Vercel (inbound to function) or function → Groq.

### Per-request costs

| Endpoint | Response size | Fast Origin Transfer per call |
|---|---|---|
| `/api/transcribe` | ~500 bytes text | ~500 bytes |
| `/api/audio` (MP3) | ~120 KB | ~120 KB |
| `/api/audio` (if still WAV) | ~1.9 MB | ~1.9 MB |
| `/api/health` | ~100 bytes | ~100 bytes |

### Full video example (4.8-hour video, 60s chunks = 291 chunks)

| Scenario | Per chunk | Total |
|---|---|---|
| Mode A (server, text response) | 500 bytes | ~140 KB |
| Mode B (browser, MP3) | 120 KB | ~34 MB |
| Mode B (browser, WAV — old) | 1.9 MB | ~553 MB |

### Bandwidth optimization (deployed 2026-06-11)

`/api/audio` was changed from WAV to MP3 output:
- **ffmpeg args**: `-codec:a libmp3lame -b:a 16k -f mp3` instead of `-f wav`
- **Content-Type**: `audio/mpeg` instead of `audio/wav`
- **Cache-Control**: `public, max-age=3600, immutable` — Vercel CDN caches each
  chunk so repeat requests for the same `hash + chunk_index` don't hit origin
- **Result**: ~94% reduction in Fast Origin Transfer per transcription session

`@xenova/transformers` in the browser accepts MP3 `ArrayBuffer` input — it decodes
to PCM internally via `AudioContext.decodeAudioData()`, which supports MP3
natively in all modern browsers.

---

## 12. Dependencies

### `package.json`

```json
{
  "type": "module",
  "dependencies": {
    "ffmpeg-static": "^5.2.0"
  }
}
```

**That's it.** One dependency. No AI/ML packages on the server.

`ffmpeg-static` ships a prebuilt Linux x64 `ffmpeg` binary (~80 MB) that Vercel
executes directly. It includes `libmp3lame` (for MP3 encoding), `libopus`, and all
common codecs. No installation step on Vercel's side.

### Browser-only (not in package.json)

`@xenova/transformers` is loaded in the browser from a CDN (unpkg, jsDelivr, or
bundled in WordPress). The server never imports it.

### Why no `node-fetch`, `fluent-ffmpeg`, `axios`

- **node-fetch**: Node.js 18+ has native `fetch`. Vercel runs Node 24. Not needed.
- **fluent-ffmpeg**: A wrapper for convenience. Direct `child_process.spawn` is
  simpler and has no npm dependencies.
- **axios**: Same as node-fetch — native fetch covers all use cases.

---

## 13. WordPress Integration

### PHP class interface

```php
$transcriber = new Thinkific_Vercel_Transcriber(
    get_option('thinkific_vercel_url'),    // https://mtools.gravitypointmedia.com
    get_option('thinkific_vercel_secret')  // same as HUB_SECRET
);

// Process next unfinished chunk (called from cron or admin trigger)
$transcriber->transcribe($wistia_hash);

// Check if all chunks are done
$transcriber->is_complete($wistia_hash);  // bool

// Get full merged transcript (returns null if incomplete)
$transcriber->get_completed_transcript($wistia_hash);
```

### Checkpoint format (stored in WP post meta)

```json
{
  "status":       "processing",
  "chunk_index":  14,
  "total_chunks": 291,
  "transcripts": {
    "0":  "Welcome to this lesson...",
    "1":  "In this section we cover...",
    "13": "To summarize what we just saw..."
  },
  "started_at":  1749480000,
  "updated_at":  1749481234
}
```

### Cron flow

```
WP cron fires (every 1–5 min)
    │
    ▼
thinkific_extract_and_save($post_id)
    │
    ▼
Thinkific_Vercel_Transcriber::transcribe($wistia_hash)
    │
    ├── load checkpoint from post meta
    ├── find lowest chunk_index with no transcript entry
    ├── POST /api/transcribe { wistia_hash, chunk_index, secret }
    │     ├── on 200 → store text in checkpoint["transcripts"][N]
    │     ├── on 503 MODEL_LOADING → log, bail (retry next cron)
    │     └── on 200 done:true → mark status="complete", merge all transcripts
    └── save checkpoint back to post meta
```

### Settings in WordPress admin

| Setting | Value |
|---|---|
| Vercel Hub URL | `https://mtools.gravitypointmedia.com` |
| Hub Secret | same value as `HUB_SECRET` env var in Vercel |

No HuggingFace API key. No OpenAI key. Only `HUB_SECRET` and `GROQ_API_KEY`
are managed, both in Vercel's dashboard.
