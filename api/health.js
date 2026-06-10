const VERSION = '1.0.0';
const MODEL   = process.env.WHISPER_MODEL || 'whisper-large-v3';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({
    status:           'ok',
    model:            MODEL,
    backend:          'groq-whisper-api',
    groq_key_set:     !!process.env.GROQ_API_KEY,
    chunk_duration_s: parseInt(process.env.CHUNK_DURATION_S || '30', 10),
    version:          VERSION,
  });
}
