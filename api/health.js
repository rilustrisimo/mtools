import { existsSync } from 'fs';

const VERSION = '1.0.0';
const MODEL   = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')  return res.status(405).json({ error: 'Method not allowed' });

  const modelCached = existsSync('/tmp/xenova-cache');

  return res.status(200).json({
    status:           'ok',
    model:            MODEL,
    model_cached:     modelCached,
    chunk_duration_s: parseInt(process.env.CHUNK_DURATION_S || '60', 10),
    version:          VERSION,
  });
}
