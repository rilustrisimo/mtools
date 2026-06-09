# EMEI AI Services — Vercel Hub

> **Purpose:** A self-hosted, serverless AI services hub deployed on Vercel.
> Designed to be the single external dependency for emeiglobal.com tools —
> WordPress (or any client) sends a tiny request; this service handles all
> heavy AI workloads. Start with transcription. Expand to anything.

---

## Table of Contents

1. [Vision & Design Principles](#1-vision--design-principles)
2. [System Architecture](#2-system-architecture)
3. [API Contract](#3-api-contract)
4. [Project Structure](#4-project-structure)
5. [Tech Stack & Rationale](#5-tech-stack--rationale)
6. [Transcription Engine — How It Works](#6-transcription-engine--how-it-works)
7. [WordPress Integration](#7-wordpress-integration)
8. [Deployment Guide](#8-deployment-guide)
9. [Environment Variables](#9-environment-variables)
10. [Vercel Plan Considerations](#10-vercel-plan-considerations)
11. [Security Model](#11-security-model)
12. [Future Services (The Hub)](#12-future-services-the-hub)

---

## 1. Vision & Design Principles

### What this is
A Node.js API hosted on Vercel that runs AI tasks the GoDaddy Managed WordPress
server cannot — because it lacks Python, ffmpeg, sufficient memory, or reliable
outbound DNS to AI APIs.

### Why Vercel
- Free hobby tier covers normal usage
- Zero DevOps — push to main = deployed
- Serverless — scales automatically, no idle cost
- Node.js runtime with native binary support (crucial for ffmpeg)

### Design rules
| Rule | Rationale |
|---|---|
| **Minimal payloads** | Clients send IDs, not files |
| **Stateless functions** | Vercel handles no persistent state — clients own checkpoints |
| **One concern per endpoint** | Easy to extend, easy to debug |
| **Self-contained** | No paid external AI APIs — models run inside the function |
| **Shared secret auth** | Simple, no OAuth complexity needed |

---

## 2. System Architecture

### High-level flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  WordPress (GoDaddy)                                                 │
│                                                                      │
│  class-thinkific-vercel-transcriber.php                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ checkpoint: {status, chunk_index, total_chunks, transcripts} │   │
│  └──────────────────────────────────────────────────────────────┘   │
│         │  POST {wistia_hash, chunk_index}  (~50 bytes)             │
│         │  ← {text, total_chunks}  (one chunk of transcript)        │
└─────────┼───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Vercel  (thinkific-transcriber.vercel.app)                         │
│                                                                      │
│  api/transcribe.js                                                   │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  1. Verify shared secret                                    │    │
│  │  2. Fetch Wistia JSON → video URL + duration                │    │
│  │  3. ffmpeg: stream-seek to chunk N, extract 16kHz mono WAV  │    │
│  │  4. @xenova/transformers Whisper: transcribe WAV buffer      │    │
│  │  5. Return {text, total_chunks}                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│         │                          │                                 │
│         ▼                          ▼                                 │
│  Wistia CDN                  /tmp/whisper-model                      │
│  (range request,             (cached after first call,               │
│   only chunk bytes)           ~39 MB, survives warm invocations)     │
└─────────────────────────────────────────────────────────────────────┘
```

### Data sizes at each step
| Hop | Data | Size |
|---|---|---|
| WordPress → Vercel | `{wistia_hash, chunk_index, secret}` | ~100 bytes |
| Vercel → Wistia CDN | HTTP range request (stream N seconds) | ~0 bytes sent |
| Wistia CDN → Vercel | Audio segment (60s × 16kHz mono WAV) | ~1.9 MB |
| Vercel → Whisper | Float32Array in memory | ~3.7 MB |
| Vercel → WordPress | `{text, total_chunks}` | ~500 bytes–5 KB |

**No video file ever touches WordPress.** Vercel downloads only the required time segment from Wistia, not the full file.

---

## 3. API Contract

### Base URL
```
https://your-app.vercel.app
```

---

### POST `/api/transcribe`

Transcribes one time-based chunk of a Wistia video.

**Request**
```json
{
  "wistia_hash": "cpkghxeijh",
  "chunk_index": 0,
  "secret": "your_shared_secret"
}
```

| Field | Type | Description |
|---|---|---|
| `wistia_hash` | string | Wistia media hash ID |
| `chunk_index` | integer | Zero-based chunk to process |
| `secret` | string | Shared secret (matches `API_SECRET` env var) |

**Response — success**
```json
{
  "text": "Welcome to this lesson. Today we will cover...",
  "chunk_index": 0,
  "total_chunks": 58,
  "duration_s": 17416.1
}
```

**Response — still processing (chunk_index out of range)**
```json
{
  "text": "",
  "chunk_index": 58,
  "total_chunks": 58,
  "done": true
}
```

**Response — error**
```json
{
  "error": "Wistia fetch failed",
  "code": "WISTIA_FETCH_FAILED"
}
```

**HTTP status codes**
| Code | Meaning |
|---|---|
| 200 | Success (even if text is empty — silence in chunk) |
| 400 | Bad request (missing fields) |
| 401 | Invalid secret |
| 500 | Internal error (see `error` field) |

---

### GET `/api/health`

Returns service status and model cache state.

**Response**
```json
{
  "status": "ok",
  "model": "Xenova/whisper-tiny",
  "model_cached": true,
  "chunk_duration_s": 60,
  "version": "1.0.0"
}
```

---

## 4. Project Structure

```
thinkific-transcriber/
│
├── api/
│   ├── transcribe.js         ← main endpoint (POST /api/transcribe)
│   └── health.js             ← status check (GET /api/health)
│
├── lib/
│   ├── wistia.js             ← fetch video URL + duration from Wistia JSON
│   ├── audio.js              ← ffmpeg stream → WAV buffer extraction
│   ├── whisper.js            ← @xenova/transformers pipeline + model cache
│   └── auth.js               ← shared secret verification
│
├── package.json
├── vercel.json               ← function config (memory, max duration)
└── .env.local                ← local dev env (never committed)
```

---

## 5. Tech Stack & Rationale

| Package | Purpose | Why |
|---|---|---|
| `@xenova/transformers` | Whisper inference in JS | Pure JS/WASM — no Python, no server install. Works in Vercel Node.js. |
| `ffmpeg-static` | Bundled ffmpeg binary | Static Linux x64 binary ships with the npm package. Works on Vercel without any server config. |
| `fluent-ffmpeg` | ffmpeg Node.js wrapper | Clean API for piping ffmpeg output to a buffer. |
| `node-fetch` | HTTP requests | Fetch Wistia JSON from inside Vercel function. |

### Why NOT HuggingFace API for transcription here

The original problem was that WordPress's PHP environment failed DNS resolution for
`api-inference.huggingface.co`. If we routed through Vercel to HF, we'd still depend
on an external API — just one hop removed. Running Whisper directly on Vercel means:

- **Zero external API dependencies** for transcription
- **No rate limits** (free tier, daily caps, etc.)
- **No API keys to manage** for the transcription step
- **No downtime risk** from external services
- **Model is the same** — `openai/whisper-tiny` via `@xenova/transformers`

### Model choice: `Xenova/whisper-tiny`

| Model | Size | Speed on Vercel | Accuracy |
|---|---|---|---|
| whisper-tiny | ~39 MB | ~1–6s per 60s audio | Good for speech |
| whisper-base | ~142 MB | ~3–12s per 60s audio | Better |
| whisper-small | ~244 MB | ~8–30s per 60s audio | Best free option |

**whisper-tiny** is the right default for Vercel Hobby (10s timeout). Swap to
`whisper-base` or `whisper-small` on Vercel Pro (60s timeout).

---

## 6. Transcription Engine — How It Works

### Step 1 — Fetch Wistia metadata

```
GET https://fast.wistia.com/embed/medias/{hash}.json
```

Parse: `media.duration` (total seconds), `media.assets` (pick smallest MP4 by size).
The `.bin` URL extension is a Wistia CDN artifact — the actual format is the asset's
`ext` field (`mp4`). These files have `faststart` enabled (moov atom at the start of
file), which means ffmpeg can seek to any timestamp without downloading the whole file.

### Step 2 — Calculate chunks

```javascript
const CHUNK_DURATION = 60; // seconds — configurable via env
const totalChunks = Math.ceil(duration / CHUNK_DURATION);
const startSeconds = chunkIndex * CHUNK_DURATION;
```

### Step 3 — Extract audio via ffmpeg (streaming, range-based)

```javascript
// ffmpeg reads from the Wistia CDN URL directly
// -ss: seek to start (HTTP range request under the hood)
// -t: duration
// -vn: no video track
// -ar 16000 -ac 1: 16kHz mono (Whisper's required format)
// -f wav pipe:1: output WAV to stdout

const args = [
  '-ss', String(startSeconds),
  '-t',  String(CHUNK_DURATION),
  '-i',  videoUrl,
  '-vn', '-ar', '16000', '-ac', '1',
  '-f',  'wav', 'pipe:1'
];
```

Because Wistia CDN supports HTTP range requests and the moov atom is at the start,
ffmpeg only downloads the relevant bytes for the requested time window — not the
entire file. A 60-second chunk from a 4.8-hour video downloads roughly
`(60 / 17416) × file_size ≈ 1.5 MB` from the CDN.

### Step 4 — Whisper inference

```javascript
// Model is cached in /tmp after first load (~39 MB download once)
// Subsequent warm invocations reuse the cached model instantly
const transcriber = await pipeline(
  'automatic-speech-recognition',
  'Xenova/whisper-tiny',
  { cache_dir: '/tmp/xenova-cache' }
);

const wavBuffer = /* WAV bytes from ffmpeg stdout */;
const float32 = wavToFloat32(wavBuffer); // strip WAV header, normalize

const result = await transcriber(float32, {
  language: 'en',
  task: 'transcribe',
});

return result.text; // plain string
```

### Chunk timing for a 4.8-hour video

```
Video duration: 17,416 s
Chunk duration: 60 s
Total chunks:   291

Per-chunk Vercel call:
  - Wistia JSON fetch:     ~0.2s
  - ffmpeg range download: ~1–3s  (downloads ~1.5 MB)
  - Whisper inference:     ~3–6s  (on Vercel CPU, warm model)
  - Total per chunk:       ~5–9s  ✅ within Hobby 10s limit

Total wall time (WordPress cron every 5 min, 1 chunk/run):
  291 chunks × 5 min = ~24 hours

Total wall time (cron every 1 min, 1 chunk/run):
  291 min ≈ 5 hours

Optimization: process multiple chunks per cron run until time budget runs out.
```

---

## 7. WordPress Integration

### New file: `class-thinkific-vercel-transcriber.php`

Drop-in replacement for `class-thinkific-hf-transcriber.php`. Same public interface,
same checkpoint format. WordPress code (extractor, cron script, admin) requires
zero changes beyond swapping the class name and settings key.

**Checkpoint format** (unchanged from current HF transcriber):
```json
{
  "status": "processing",
  "transcripts": {
    "0": "Welcome to this lesson...",
    "1": "In this section we cover...",
    "2": ""
  },
  "total_chunks": 291,
  "started_at": 1749480000,
  "updated_at": 1749481234
}
```

**Public interface:**
```php
$transcriber = new Thinkific_Vercel_Transcriber( $vercel_url, $secret );

$transcriber->transcribe( $wistia_hash );     // process next unfinished chunk
$transcriber->is_complete( $wistia_hash );    // bool
$transcriber->get_completed_transcript( ... ); // full merged text or null
```

**WordPress settings change:**
- Remove: HuggingFace API Key field
- Add: Vercel Transcriber URL (e.g. `https://your-app.vercel.app`)
- Add: Shared Secret (same value as `API_SECRET` env var in Vercel)

### Cron / Re-process flow

```
[WordPress cron / Re-process click]
        │
        ▼
thinkific_extract_and_save($row)
        │
        ▼
Thinkific_Vercel_Transcriber::transcribe($hash)
        │
        ├─ Load checkpoint
        ├─ Find first unfinished chunk_index
        ├─ POST /api/transcribe {hash, chunk_index, secret}
        ├─ Store result in checkpoint['transcripts'][N]
        └─ If all chunks done → merge → return full transcript
```

---

## 8. Deployment Guide

### Prerequisites
- Node.js 18+ installed locally
- Vercel CLI: `npm i -g vercel`
- Vercel account (free Hobby tier works)

### Steps

```bash
# 1. Create and enter project directory
mkdir thinkific-transcriber && cd thinkific-transcriber

# 2. Init npm
npm init -y

# 3. Install dependencies
npm install @xenova/transformers ffmpeg-static fluent-ffmpeg node-fetch

# 4. Create project files (see Section 4 structure)

# 5. Local test
vercel dev

# 6. Deploy
vercel --prod

# 7. Set environment variables (in Vercel dashboard or CLI)
vercel env add API_SECRET production
vercel env add CHUNK_DURATION_S production   # optional, default 60
vercel env add WHISPER_MODEL production      # optional, default Xenova/whisper-tiny
```

### vercel.json

```json
{
  "functions": {
    "api/transcribe.js": {
      "memory": 1024,
      "maxDuration": 10
    },
    "api/health.js": {
      "memory": 128,
      "maxDuration": 5
    }
  }
}
```

For **Vercel Pro** (60s timeout, 3GB memory):
```json
{
  "functions": {
    "api/transcribe.js": {
      "memory": 2048,
      "maxDuration": 60
    }
  }
}
```

---

## 9. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_SECRET` | YES | — | Shared secret for request auth. Set the same value in WordPress settings. |
| `WHISPER_MODEL` | no | `Xenova/whisper-tiny` | HuggingFace model ID. Change to `Xenova/whisper-base` on Pro plan. |
| `CHUNK_DURATION_S` | no | `60` | Audio seconds per chunk. Keep at 60 for Hobby, increase to 300 for Pro. |

**In WordPress (.env or WP options):**
```
THINKIFIC_VERCEL_URL=https://your-app.vercel.app
THINKIFIC_VERCEL_SECRET=same_value_as_API_SECRET
```

---

## 10. Vercel Plan Considerations

### Hobby (free)
| Limit | Value | Impact |
|---|---|---|
| Function timeout | 10 seconds | Use 60s chunks + whisper-tiny |
| Memory | 1024 MB | Fine for whisper-tiny |
| Bandwidth | 100 GB/mo | CDN → Vercel: ~1.5 MB/chunk. For 1000 chunks: 1.5 GB. Monitor. |
| /tmp storage | 512 MB | Model (39 MB) + 1 chunk WAV (2 MB) = fine |

### Pro ($20/month)
| Limit | Value | Impact |
|---|---|---|
| Function timeout | 60 seconds | Use 300s chunks + whisper-base |
| Memory | 3008 MB | Can run whisper-small |
| Fluid Compute | 800 seconds | Process multiple chunks per invocation |

### Cold start behavior
- First invocation after idle: downloads model to `/tmp` (~39 MB, ~10–20s)
- This may cause the first call to time out on Hobby plan
- Mitigation: WordPress retries on timeout; model is cached for subsequent calls
- Optional: add a `/api/warmup` endpoint triggered before batch processing

---

## 11. Security Model

### Shared secret
All requests must include `secret` matching `API_SECRET` env var.
Returns HTTP 401 if missing or wrong. Not OAuth, not JWT — just a token.
Rotate by updating both Vercel env var and WordPress settings.

### CORS
All endpoints return:
```
Access-Control-Allow-Origin: https://emeiglobal.com
```
Prevents other domains from using the service.

### Input validation
- `wistia_hash`: must match `/^[a-z0-9]{10,12}$/`
- `chunk_index`: must be non-negative integer
- No user-uploaded content ever enters the function

### Rate limiting (optional, future)
Add a simple in-memory counter or use Vercel KV to cap requests per IP per minute.

---

## 12. Future Services (The Hub)

This project is designed to grow. Each new service is a new file in `api/`.
WordPress (or any other client) only needs to know the base URL and the shared secret.

### Planned services

```
api/
├── transcribe.js        ✅ Video transcription (Wistia → text)
│
├── summarize.js         → POST {text, style: "bullets|paragraph|key_terms"}
│                           Uses local LLM (llama.cpp WASM) or OpenAI
│                           Returns {summary}
│
├── search-index.js      → POST {content_id, text}
│                           Generates embeddings, stores in Vercel KV or Postgres
│                           Enables semantic search across course content
│
├── embed.js             → POST {text}
│                           Returns {embedding: Float32Array}
│                           Used for similarity search
│
├── classify.js          → POST {text}
│                           Returns {topics: [...], difficulty: "beginner|..."}
│                           Auto-tags course content
│
└── thumbnail-ocr.js     → POST {image_url}
                            Reads text from lesson thumbnails/slides
                            Returns {text}
```

### Adding a new service

1. Create `api/new-service.js`
2. Import `verifySecret` from `lib/auth.js`
3. Write the handler
4. Deploy — that's it

WordPress side:
1. Create `class-thinkific-new-service.php`
2. Add one settings field (if needed)

No infrastructure changes, no new deployments beyond `git push`.

---

## Appendix — Key File Skeletons

### `api/transcribe.js`
```javascript
import { verifySecret }    from '../lib/auth.js';
import { getVideoUrl }     from '../lib/wistia.js';
import { extractAudioChunk } from '../lib/audio.js';
import { transcribeBuffer }  from '../lib/whisper.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { wistia_hash, chunk_index, secret } = req.body;

  if (!verifySecret(secret)) return res.status(401).json({ error: 'Unauthorized' });
  if (!wistia_hash || chunk_index === undefined)
    return res.status(400).json({ error: 'Missing fields' });

  const { url, duration } = await getVideoUrl(wistia_hash);
  if (!url) return res.status(500).json({ error: 'Wistia fetch failed', code: 'WISTIA_FETCH_FAILED' });

  const chunkDuration = parseInt(process.env.CHUNK_DURATION_S || '60');
  const totalChunks   = Math.ceil(duration / chunkDuration);
  const startSeconds  = chunk_index * chunkDuration;

  if (startSeconds >= duration) {
    return res.status(200).json({ text: '', chunk_index, total_chunks: totalChunks, done: true });
  }

  const audioBuffer = await extractAudioChunk(url, startSeconds, chunkDuration);
  if (!audioBuffer) return res.status(500).json({ error: 'Audio extraction failed', code: 'FFMPEG_FAILED' });

  const text = await transcribeBuffer(audioBuffer);

  return res.status(200).json({ text, chunk_index, total_chunks: totalChunks, duration_s: duration });
}
```

### `lib/wistia.js`
```javascript
export async function getVideoUrl(hash) {
  const res = await fetch(`https://fast.wistia.com/embed/medias/${hash}.json`);
  if (!res.ok) return { url: null, duration: 0 };

  const { media } = await res.json();
  const duration = media.duration;

  const videoTypes = ['mp4_video', 'iphone_video', 'md_mp4_video', 'hd_mp4_video'];
  const candidates = media.assets
    .filter(a => videoTypes.includes(a.type) && a.url)
    .sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity));

  if (!candidates.length) return { url: null, duration };
  return { url: candidates[0].url, duration };
}
```

### `lib/audio.js`
```javascript
import ffmpegPath from 'ffmpeg-static';
import { spawn }  from 'child_process';

export function extractAudioChunk(videoUrl, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(startSeconds),
      '-t',  String(durationSeconds),
      '-i',  videoUrl,
      '-vn', '-ar', '16000', '-ac', '1',
      '-f',  'wav', 'pipe:1',
    ];

    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stdout.on('end',  () => resolve(Buffer.concat(chunks)));
    ff.stderr.on('data', () => {}); // suppress ffmpeg log noise
    ff.on('error', reject);
  });
}
```

### `lib/whisper.js`
```javascript
import { pipeline } from '@xenova/transformers';

let _transcriber = null;

async function getTranscriber() {
  if (!_transcriber) {
    const model = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny';
    _transcriber = await pipeline('automatic-speech-recognition', model, {
      cache_dir: '/tmp/xenova-cache',
    });
  }
  return _transcriber;
}

export async function transcribeBuffer(wavBuffer) {
  // Strip 44-byte WAV header; convert Int16 PCM to Float32
  const int16 = new Int16Array(wavBuffer.buffer, wavBuffer.byteOffset + 44);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const transcriber = await getTranscriber();
  const result = await transcriber(float32, { language: 'en', task: 'transcribe' });
  return result.text ?? '';
}
```

### `lib/auth.js`
```javascript
export function verifySecret(secret) {
  const expected = process.env.API_SECRET;
  if (!expected || !secret) return false;
  return secret === expected; // constant-time compare not needed for this use case
}
```
