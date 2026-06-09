import fetch from 'node-fetch';

const WISTIA_JSON_URL = 'https://fast.wistia.com/embed/medias/';
const PREFERRED_TYPES = ['mp4_video', 'iphone_video', 'md_mp4_video', 'hd_mp4_video'];

export async function getVideoUrl(hash) {
  let res;
  try {
    res = await fetch(`${WISTIA_JSON_URL}${hash}.json`, {
      headers: { 'User-Agent': 'mtools-transcriber/1.0' },
    });
  } catch (err) {
    return { url: null, duration: 0, error: `Network error: ${err.message}` };
  }

  if (!res.ok) {
    return { url: null, duration: 0, error: `Wistia returned ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { url: null, duration: 0, error: 'Invalid JSON from Wistia' };
  }

  const media = body?.media;
  if (!media) return { url: null, duration: 0, error: 'No media in Wistia response' };

  const duration = media.duration ?? 0;
  const assets = Array.isArray(media.assets) ? media.assets : [];

  const candidates = assets
    .filter(a => PREFERRED_TYPES.includes(a.type) && a.url)
    .sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity));

  if (!candidates.length) {
    return { url: null, duration, error: 'No suitable video asset found' };
  }

  return { url: candidates[0].url, duration };
}
