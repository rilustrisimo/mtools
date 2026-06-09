const HF_BASE = 'https://api-inference.huggingface.co/models/';

export async function transcribeBuffer(wavBuffer) {
  const model = process.env.WHISPER_MODEL || 'openai/whisper-large-v3';
  const token = process.env.HF_TOKEN;

  if (!token) throw new Error('HF_TOKEN env var is not set');

  const res = await fetch(`${HF_BASE}${model}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'audio/wav',
    },
    body: wavBuffer,
  });

  // HF returns 503 while the model is warming up on their side
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    const eta  = body.estimated_time ?? 20;
    const err  = new Error(`Model loading on HF — estimated ${eta}s`);
    err.code   = 'MODEL_LOADING';
    err.eta    = eta;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HF API ${res.status}: ${text.slice(0, 300)}`);
  }

  const result = await res.json();
  return (result.text ?? '').trim();
}
