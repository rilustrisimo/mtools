import { timingSafeEqual } from 'crypto';

export function verifySecret(secret) {
  const expected = process.env.API_SECRET;
  if (!expected || !secret) return false;

  // Constant-time comparison to prevent timing attacks
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(secret), 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
