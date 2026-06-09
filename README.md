# mtools

**EMEI AI Services Hub** — a self-hosted, serverless AI services hub deployed on Vercel.

Designed to be a single external dependency for WordPress (or any client): send a tiny request, get back AI-processed results. No external AI API keys required for transcription — Whisper runs directly inside the Vercel function.

---

## Services

| Endpoint | Status | Description |
|---|---|---|
| `POST /api/transcribe` | ✅ Live | Transcribe Wistia videos chunk-by-chunk using local Whisper |
| `GET /api/health` | ✅ Live | Service status and model cache state |
| `POST /api/summarize` | Planned | Summarise text with local LLM |
| `POST /api/embed` | Planned | Generate text embeddings |
| `POST /api/classify` | Planned | Auto-tag and classify content |
| `POST /api/thumbnail-ocr` | Planned | OCR text from images |

---

## How Transcription Works

```
WordPress / any client
   │  POST { wistia_hash, chunk_index, secret }
   ▼
Vercel (this repo)
   │  1. Verify shared secret
   │  2. Fetch Wistia JSON → video URL + duration
   │  3. ffmpeg: range-seek to chunk N, extract 16kHz mono WAV
   │  4. Whisper (local, @xenova/transformers): transcribe WAV
   │  5. Return { text, total_chunks }
   ▼
Client accumulates chunks → full transcript
```

**No video file ever touches the client.** Vercel downloads only the requested time segment (~1.5 MB for 60s) directly from the Wistia CDN.

---

## Quick Deploy

### Prerequisites
- [Vercel account](https://vercel.com) (free Hobby tier works)
- `npm i -g vercel`

### Steps

```bash
# 1. Clone and install
git clone https://github.com/rilustrisimo/mtools.git
cd mtools
npm install

# 2. Test locally
vercel dev

# 3. Deploy
vercel --prod

# 4. Set environment variables
vercel env add API_SECRET production
```

---

## API Reference

### `POST /api/transcribe`

Transcribes one 60-second chunk of a Wistia video.

**Request**
```json
{
  "wistia_hash": "cpkghxeijh",
  "chunk_index": 0,
  "secret": "your_shared_secret"
}
```

**Success response**
```json
{
  "text": "Welcome to this lesson. Today we will cover...",
  "chunk_index": 0,
  "total_chunks": 58,
  "duration_s": 3480.5
}
```

**Done response** (chunk_index ≥ total_chunks)
```json
{
  "text": "",
  "chunk_index": 58,
  "total_chunks": 58,
  "done": true
}
```

**Error response**
```json
{
  "error": "Wistia fetch failed",
  "code": "WISTIA_FETCH_FAILED"
}
```

| HTTP | Meaning |
|---|---|
| 200 | Success (even for silent chunks) |
| 400 | Missing or invalid fields |
| 401 | Invalid secret |
| 500 | Internal error |

---

### `GET /api/health`

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

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_SECRET` | **Yes** | — | Shared secret. Must match the value sent in requests. |
| `WHISPER_MODEL` | No | `Xenova/whisper-tiny` | Whisper model ID. Use `Xenova/whisper-base` on Vercel Pro. |
| `CHUNK_DURATION_S` | No | `60` | Audio seconds per chunk. Keep at 60 for Hobby; up to 300 on Pro. |

Copy `.env.local.example` to `.env.local` for local development:

```
API_SECRET=your_secret_here
WHISPER_MODEL=Xenova/whisper-tiny
CHUNK_DURATION_S=60
```

---

## Vercel Plan Guide

### Hobby (free)
- Function timeout: **10s** → use `whisper-tiny` + 60s chunks
- Memory: 1 GB
- `/tmp` storage: 512 MB (model 39 MB + 1 chunk WAV 2 MB = fine)

### Pro ($20/mo)
- Function timeout: **60s** → use `whisper-base` + 300s chunks
- Memory: 3 GB → can run `whisper-small`

> **Cold start note:** First invocation downloads the model (~39 MB) which may hit the Hobby timeout. The model is then cached in `/tmp` for subsequent warm calls. WordPress retries on timeout, so this is handled automatically.

---

## WordPress Integration

Drop-in PHP class for WordPress (replaces a HuggingFace-based transcriber):

```php
$transcriber = new Thinkific_Vercel_Transcriber(
    'https://your-app.vercel.app',
    'your_shared_secret'
);

$transcriber->transcribe( $wistia_hash );          // process next unfinished chunk
$transcriber->is_complete( $wistia_hash );         // bool
$transcriber->get_completed_transcript( $hash );   // full text or null
```

The checkpoint format is JSON stored in WordPress post meta. Each cron run processes the next unfinished chunk. No changes required to WordPress cron or admin code — only swap the class.

---

## Project Structure

```
mtools/
├── api/
│   ├── transcribe.js     POST /api/transcribe
│   └── health.js         GET  /api/health
├── lib/
│   ├── auth.js           Shared-secret verification
│   ├── wistia.js         Fetch video URL + duration from Wistia
│   ├── audio.js          ffmpeg: range-seek → 16kHz mono WAV buffer
│   └── whisper.js        @xenova/transformers pipeline + /tmp model cache
├── package.json
├── vercel.json
└── .env.local.example
```

---

## Adding a New Service

1. Create `api/new-service.js`
2. Import `verifySecret` from `../lib/auth.js`
3. Write the handler
4. `git push` — Vercel deploys automatically

No infrastructure changes needed.

---

## License

MIT
