import { useEffect, useState } from "react";
import { cachedSignedUrl, fetchSignedUrl, formatBytes } from "../media.js";

/**
 * Renders the media half of a media message. Images render inline; every other
 * file type renders as a download link with filename + size. The actual bytes
 * always come from a signed, time-limited GET URL minted by the media service
 * ("CDN-style" delivery) — never from a raw storage URL.
 */
export default function MediaMessage({ media, text }) {
  if (!media) return <p className="whitespace-pre-wrap break-words">{text}</p>;

  const isImage = media.content_type?.startsWith("image/");
  return (
    <div className="space-y-1">
      {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
      {isImage ? (
        <MediaImage media={media} />
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

function MediaImage({ media }) {
  const { url, state } = useSignedUrl(media.media_id);
  if (state === "loading") {
    return (
      <div
        className="nm-pressed flex h-32 w-56 items-center justify-center rounded-2xl text-xs"
        style={{ color: "var(--nm-text-muted)" }}
      >
        Loading…
      </div>
    );
  }
  if (state === "error") {
    return (
      <div
        className="nm-pressed flex h-32 w-56 items-center justify-center rounded-2xl text-xs"
        style={{ color: "var(--nm-error)" }}
      >
        Failed to load image
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={media.filename}
      className="max-h-72 max-w-full rounded-2xl object-cover"
      title={media.filename}
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
