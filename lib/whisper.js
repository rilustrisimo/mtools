import { pipeline } from '@xenova/transformers';

let _transcriber = null;

async function getTranscriber() {
  if (!_transcriber) {
    const model = process.env.WHISPER_MODEL || 'Xenova/whisper-tiny';
    _transcriber = await pipeline('automatic-speech-recognition', model, {
      cache_dir: '/tmp/xenova-cache',
      revision: 'main',
    });
  }
  return _transcriber;
}

/**
 * Transcribes a WAV buffer (16kHz mono PCM).
 * Strips the 44-byte WAV header and normalises Int16 → Float32
 * before passing to the Whisper pipeline.
 */
export async function transcribeBuffer(wavBuffer) {
  const PCM_HEADER_BYTES = 44;
  const int16 = new Int16Array(
    wavBuffer.buffer,
    wavBuffer.byteOffset + PCM_HEADER_BYTES,
    (wavBuffer.byteLength - PCM_HEADER_BYTES) / 2,
  );

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const transcriber = await getTranscriber();
  const result = await transcriber(float32, {
    language: 'en',
    task: 'transcribe',
  });

  return (result.text ?? '').trim();
}
