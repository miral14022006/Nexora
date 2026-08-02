import { useEffect, useState } from "react";
import { cachedSignedUrl, fetchSignedUrl, formatBytes } from "../media.js";

/**
 * Renders the media half of a media message.
 *  - Images render inline and open a full-size lightbox on tap.
 *  - Videos render in an inline <video> player with native controls. No
 *    thumbnail/poster is generated at upload (ffmpeg skipped this pass — see
 *    ARCHITECTURE.md "Media Service"), so a generic play-icon placeholder
 *    shows while the signed URL resolves and until playback starts.
 *  - Every other file type renders as a download link with filename + size.
 * The actual bytes always come from a signed, time-limited GET URL minted by
 * the media service ("CDN-style" delivery) — never from a raw storage URL.
 */
export default function MediaMessage({ media, text }) {
  if (!media) return <p className="whitespace-pre-wrap break-words">{text}</p>;

  const isImage = media.content_type?.startsWith("image/");
  const isVideo = media.content_type?.startsWith("video/");
  return (
    <div className="space-y-1">
      {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
      {isImage ? (
        <MediaImage media={media} />
      ) : isVideo ? (
        <MediaVideo media={media} />
      ) : (
        <MediaDownload media={media} />
      )}
    </div>
  );
}

function useSignedUrl(mediaId) {
  const [url, setUrl] = useState(() => cachedSignedUrl(mediaId));
  const [state, setState] = useState(url ? "ready" : "loading");
  useEffect(() => {
    if (url) return;
    let cancelled = false;
    fetchSignedUrl(mediaId)
      .then((u) => {
        if (cancelled) return;
        setUrl(u);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, url]);
  return { url, state };
}

/** Loading/error placeholder with the neomorphic pressed style. */
function MediaPlaceholder({ label, children }) {
  return (
    <div
      className="nm-pressed flex h-40 w-64 items-center justify-center rounded-2xl text-xs"
      style={{ color: "var(--nm-text-muted)" }}
    >
      {children ?? label}
    </div>
  );
}

function MediaImage({ media }) {
  const { url, state } = useSignedUrl(media.media_id);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e) => e.key === "Escape" && setLightboxOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightboxOpen]);

  if (state === "loading") return <MediaPlaceholder label="Loading…" />;
  if (state === "error") {
    return <MediaPlaceholder label="Failed to load image">
      <span style={{ color: "var(--nm-error)" }}>Failed to load image</span>
    </MediaPlaceholder>;
  }

  return (
    <>
      <img
        src={url}
        alt={media.filename}
        onClick={() => setLightboxOpen(true)}
        className="max-h-72 max-w-full cursor-zoom-in rounded-2xl object-cover"
        title={media.filename}
      />
      {lightboxOpen && (
        <div
          onClick={() => setLightboxOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <img
            src={url}
            alt={media.filename}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            onClick={() => setLightboxOpen(false)}
            title="Close"
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}
    </>
  );
}

function MediaVideo({ media }) {
  const { url, state } = useSignedUrl(media.media_id);
  if (state === "loading") {
    return (
      <MediaPlaceholder>
        <span className="flex flex-col items-center gap-2">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity="0.7">
            <path d="M8 5v14l11-7z" />
          </svg>
          Video
        </span>
      </MediaPlaceholder>
    );
  }
  if (state === "error") {
    return (
      <MediaPlaceholder>
        <span style={{ color: "var(--nm-error)" }}>Failed to load video</span>
      </MediaPlaceholder>
    );
  }
  return (
    <video
      src={url}
      controls
      preload="metadata"
      playsInline
      className="max-h-96 max-w-full rounded-2xl"
    />
  );
}

function MediaDownload({ media }) {
  const { url, state } = useSignedUrl(media.media_id);
  return (
    <div className="nm-raised-sm flex items-center gap-2 rounded-2xl px-4 py-3">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ color: "var(--nm-text-muted)" }}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{media.filename}</span>
        <span className="block text-[10px]" style={{ color: "var(--nm-text-muted)" }}>
          {media.content_type} · {formatBytes(media.size)}
        </span>
      </span>
      {state === "error" ? (
        <span className="text-[11px]" style={{ color: "var(--nm-error)" }}>Unavailable</span>
      ) : (
        <a
          href={url ?? "#"}
          download={media.filename}
          className="text-xs font-medium transition hover:opacity-70"
          style={{ color: "var(--nm-accent)" }}
          onClick={(e) => !url && e.preventDefault()}
        >
          {state === "loading" ? "Preparing…" : "Download"}
        </a>
      )}
    </div>
  );
}
