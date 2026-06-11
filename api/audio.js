/**
 * GET /api/audio?wistia_hash=xxx&chunk_index=0&secret=xxx
 *
 * Returns a 16kHz mono MP3 buffer for one chunk of a Wistia video.
 * MP3 at 16kbps is ~16x smaller than WAV (~120 KB vs ~1.9 MB per 60s chunk),
 * which dramatically reduces Vercel Fast Origin Transfer usage.
 *
 * Designed for browser-side transcription: the browser feeds the MP3
 * to @xenova/transformers (Whisper.js via WebAssembly/WebGPU) and
 * transcribes entirely client-side — no server inference, no timeout risk.
 *
 * Chunk metadata is returned in response headers:
 *   X-Chunk-Index   : the requested chunk index
 *   X-Total-Chunks  : total chunks for this video
 *   X-Duration-S    : total video duration in seconds
 *
 * If chunk_index >= total_chunks the response is 204 No Content with
 * X-Done: true so the browser knows transcription is complete.
 */

import { verifySecret }     from '../lib/auth.js';
import { getVideoUrl }      from '../lib/wistia.js';
import { extractAudioChunk } from '../lib/audio.js';

const WISTIA_HASH_RE = /^[a-z0-9]{10,12}$/;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { wistia_hash, chunk_index, secret } = req.query;

  if (!verifySecret(secret)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_SECRET' });
  }

  if (!wistia_hash || !WISTIA_HASH_RE.test(wistia_hash)) {
    return res.status(400).json({ error: 'Invalid wistia_hash', code: 'BAD_REQUEST' });
  }

  const chunkIdx = parseInt(chunk_index, 10);
  if (!Number.isInteger(chunkIdx) || chunkIdx < 0) {
    return res.status(400).json({ error: 'chunk_index must be a non-negative integer', code: 'BAD_REQUEST' });
  }

  // ── Wistia lookup ────────────────────────────────────────────────────────
  const { url, duration, error: wistiaError } = await getVideoUrl(wistia_hash);
  if (!url) {
    return res.status(500).json({ error: wistiaError ?? 'Wistia fetch failed', code: 'WISTIA_FETCH_FAILED' });
  }

  // ── Chunk math ───────────────────────────────────────────────────────────
  const chunkDuration = parseInt(process.env.CHUNK_DURATION_S || '30', 10);
  const totalChunks   = Math.ceil(duration / chunkDuration);
  const startSeconds  = chunkIdx * chunkDuration;

  // Browser knows it's done
  if (startSeconds >= duration) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Total-Chunks, X-Done');
    res.setHeader('X-Done',         'true');
    res.setHeader('X-Total-Chunks', totalChunks);
    return res.status(204).end();
  }

  // ── Audio extraction (MP3 @ 16kbps — ~16x smaller than WAV) ─────────────
  let audioBuffer;
  try {
    audioBuffer = await extractAudioChunk(url, startSeconds, chunkDuration, { format: 'mp3' });
  } catch (err) {
    console.error('[audio] ffmpeg error:', err.message);
    return res.status(500).json({ error: 'Audio extraction failed', code: 'FFMPEG_FAILED' });
  }

  // ── Stream MP3 to browser ─────────────────────────────────────────────────
  // Content is permanently immutable: same hash + chunk_index = same bytes always.
  // max-age=31536000 (1 year) means Vercel CDN and browsers never re-request
  // the same chunk. ETag allows cheap 304 revalidation if the cache expires.
  const etag = `"${wistia_hash}-${chunkIdx}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Chunks, X-Chunk-Index, X-Duration-S');
  res.setHeader('Content-Type',   'audio/mpeg');
  res.setHeader('Content-Length', audioBuffer.length);
  res.setHeader('ETag',           etag);
  res.setHeader('X-Chunk-Index',  chunkIdx);
  res.setHeader('X-Total-Chunks', totalChunks);
  res.setHeader('X-Duration-S',   duration);
  res.setHeader('Cache-Control',  'public, max-age=31536000, immutable');
  return res.status(200).send(audioBuffer);
}
