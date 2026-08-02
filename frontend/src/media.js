import { api } from "./api.js";

/**
 * Media messages carry their payload as a small JSON string in `content`:
 *   {"text": "caption", "media": {"media_id", "filename", "content_type", "size"}}
 * Plain-text messages are left untouched so old clients still render them.
 */
export function parseMediaContent(content) {
  if (typeof content !== "string" || (!content.startsWith("{") && !content.startsWith("["))) {
    return { text: content ?? "", media: null };
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && parsed.media) {
      return { text: parsed.text ?? "", media: parsed.media };
    }
  } catch {
    // fall through: not JSON, render as plain text
  }
  return { text: content, media: null };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Short one-line preview used in the sidebar (raw JSON must never leak). */
export function mediaPreview(media) {
  if (!media) return "";
  const kind = media.content_type?.startsWith("image/")
    ? "Image"
    : media.content_type?.startsWith("audio/")
      ? "Audio"
      : media.content_type?.startsWith("video/")
        ? "Video"
        : "File";
  return `[${kind}] ${media.filename}`;
}

/**
 * True when the message is only emoji (plus optional whitespace) and short —
 * such messages render reaction-style: bigger glyph, tighter bubble.
 * Emoji are unicode code points in the normal TEXT column; this only changes
 * presentation, never the stored content.
 */
const EMOJI_ONLY_RE =
  /^(?:\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*|\ufe0f|\u200d|\s)+$/u;

export function isEmojiOnly(content) {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 12) return false;
  return EMOJI_ONLY_RE.test(trimmed);
}

// Signed GET URLs are time-limited (10 min); keep a small cache so re-renders
// don't mint a new URL per frame.
const signedUrlCache = new Map(); // media_id -> { url, expiresAt }

export function cachedSignedUrl(mediaId) {
  const entry = signedUrlCache.get(mediaId);
  if (entry && entry.expiresAt > Date.now() + 5_000) return entry.url;
  return null;
}

export async function fetchSignedUrl(mediaId) {
  const cached = cachedSignedUrl(mediaId);
  if (cached) return cached;
  const res = await api.mediaGetUrl(mediaId);
  if (!res.ok) throw new Error(res.error ?? "Could not fetch media URL");
  signedUrlCache.set(mediaId, {
    url: res.data.get_url,
    expiresAt: Date.now() + (res.data.expires_in ?? 600) * 1000,
  });
  return res.data.get_url;
}
