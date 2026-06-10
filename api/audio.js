/**
 * GET /api/audio?wistia_hash=xxx&chunk_index=0&secret=xxx
 *
 * Returns a raw 16kHz mono WAV buffer for one chunk of a Wistia video.
 * Designed for browser-side transcription: the browser feeds the WAV
 * to @xenova/transformers (Whisper.js running in WebAssembly) and
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
    res.setHeader('X-Done',         'true');
    res.setHeader('X-Total-Chunks', totalChunks);
    res.setHeader('X-Duration-S',   duration);
    return res.status(204).end();
  }

  // ── Audio extraction ─────────────────────────────────────────────────────
  let audioBuffer;
  try {
    audioBuffer = await extractAudioChunk(url, startSeconds, chunkDuration);
  } catch (err) {
    console.error('[audio] ffmpeg error:', err.message);
    return res.status(500).json({ error: 'Audio extraction failed', code: 'FFMPEG_FAILED' });
  }

  // ── Stream WAV to browser ─────────────────────────────────────────────────
  res.setHeader('Content-Type',   'audio/wav');
  res.setHeader('Content-Length', audioBuffer.length);
  res.setHeader('X-Chunk-Index',  chunkIdx);
  res.setHeader('X-Total-Chunks', totalChunks);
  res.setHeader('X-Duration-S',   duration);
  res.setHeader('Cache-Control',  'private, no-store');
  return res.status(200).send(audioBuffer);
}
