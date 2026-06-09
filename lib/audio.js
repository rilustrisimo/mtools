import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';

/**
 * Extracts a mono 16kHz WAV segment from a remote video URL using ffmpeg.
 * ffmpeg performs a byte-range HTTP request — only the relevant segment
 * is downloaded from the CDN, not the full file.
 */
export function extractAudioChunk(videoUrl, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(startSeconds),
      '-t',  String(durationSeconds),
      '-i',  videoUrl,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-f',  'wav',
      'pipe:1',
    ];

    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks = [];
    let stderrBuf = '';

    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', d => { stderrBuf += d.toString(); });

    ff.stdout.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 44) {
        reject(new Error(`ffmpeg produced no audio. stderr: ${stderrBuf.slice(-300)}`));
      } else {
        resolve(buf);
      }
    });

    ff.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    ff.on('close', code => {
      if (code !== 0 && chunks.length === 0) {
        reject(new Error(`ffmpeg exited ${code}. stderr: ${stderrBuf.slice(-300)}`));
      }
    });
  });
}
