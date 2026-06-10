const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export async function transcribeBuffer(wavBuffer) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY env var is not set');

  const model = process.env.WHISPER_MODEL || 'whisper-large-v3';

  const formData = new FormData();
  formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', model);
  formData.append('language', 'en');
  formData.append('response_format', 'json');

  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body:    formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API ${res.status}: ${text.slice(0, 300)}`);
  }

  const result = await res.json();
  return (result.text ?? '').trim();
}
