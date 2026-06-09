import { verifySecret }      from '../lib/auth.js';
import { getVideoUrl }        from '../lib/wistia.js';
import { extractAudioChunk }  from '../lib/audio.js';
import { transcribeBuffer }   from '../lib/whisper.js';

const WISTIA_HASH_RE = /^[a-z0-9]{10,12}$/;

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { wistia_hash, chunk_index, secret } = req.body ?? {};

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

  if (startSeconds >= duration) {
    return res.status(200).json({
      text: '',
      chunk_index: chunkIdx,
      total_chunks: totalChunks,
      done: true,
    });
  }

  // ── Audio extraction ─────────────────────────────────────────────────────
  let audioBuffer;
  try {
    audioBuffer = await extractAudioChunk(url, startSeconds, chunkDuration);
  } catch (err) {
    console.error('[transcribe] ffmpeg error:', err.message);
    return res.status(500).json({ error: 'Audio extraction failed', code: 'FFMPEG_FAILED' });
  }

  // ── HuggingFace inference ────────────────────────────────────────────────
  let text;
  try {
    text = await transcribeBuffer(audioBuffer);
  } catch (err) {
    console.error('[transcribe] whisper error:', err.message);
    if (err.code === 'MODEL_LOADING') {
      // HF model is cold — tell the client to retry after eta seconds
      return res.status(503).json({
        error:          'HuggingFace model is loading, retry shortly',
        code:           'MODEL_LOADING',
        retry_after_s:  err.eta ?? 20,
      });
    }
    return res.status(500).json({ error: 'Transcription failed', code: 'WHISPER_FAILED' });
  }

  return res.status(200).json({
    text,
    chunk_index: chunkIdx,
    total_chunks: totalChunks,
    duration_s: duration,
  });
}
