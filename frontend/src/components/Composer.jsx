import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { chatIdOf, useStore } from "../store.js";
import { sendTyping } from "../ws.js";
import { useTheme } from "./ThemeProvider.jsx";

// The picker (~230KB of emoji data) is only loaded once the emoji button is
// first opened — it never delays the initial chat render.
const EmojiPicker = lazy(() => import("emoji-picker-react"));

const TYPING_THROTTLE_MS = 2000;
const TYPING_STOP_MS = 1500;

// Send retry policy: exponential backoff + jitter, capped attempts. The SAME
// client_msg_id is reused on every attempt — the server's idempotency check
// (UNIQUE (sender_id, client_msg_id)) guarantees that even if an earlier
// attempt actually persisted the message and the response was lost, the retry
// returns the existing message instead of creating a duplicate.
const SEND_MAX_ATTEMPTS = 4;
const SEND_BASE_DELAY_MS = 1000;
const SEND_JITTER_MAX_MS = 300;

// Media uploads: 3 pre-signed steps (request URL → PUT to storage → confirm),
// then the normal message send. The file bytes never touch chat-service.
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_BASE_DELAY_MS = 1000;

// Client-side caps mirror the media-service limits (validators/media.js).
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** PUTs the raw file to the pre-signed URL with progress reporting. */
function uploadToUrl(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.max(5, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.send(file);
  });
}

export default function Composer() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [upload, setUpload] = useState(null); // { filename, progress, error, uploadId }
  const [pendingFile, setPendingFile] = useState(null); // { file, kind, previewUrl }
  const [emojiOpen, setEmojiOpen] = useState(false);
  const fileRef = useRef(null);
  const textRef = useRef(null);
  const cursorRef = useRef(0); // last known caret position in the textarea
  const emojiWrapRef = useRef(null);
  const activeChat = useStore((s) => s.activeChat);
  const user = useStore((s) => s.user);
  const appendMessage = useStore((s) => s.appendMessage);
  const patchMessage = useStore((s) => s.patchMessage);
  const loadGroupMembers = useStore((s) => s.loadGroupMembers);
  const setError = useStore((s) => s.setError);
  const { theme } = useTheme();

  let lastTypingSent = 0;
  let stopTimer = null;

  // Close the picker when clicking anywhere outside it.
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e) => {
      if (!emojiWrapRef.current?.contains(e.target)) setEmojiOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [emojiOpen]);

  const notifyTyping = (isTyping) => {
    if (!activeChat) return;
    const now = Date.now();
    if (isTyping && now - lastTypingSent < TYPING_THROTTLE_MS) return;
    if (!isTyping && !lastTypingSent) return;
    lastTypingSent = now;
    sendTyping(activeChat, isTyping);
  };

  const handleTyping = () => {
    notifyTyping(true);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => notifyTyping(false), TYPING_STOP_MS);
  };

  /** Shared retry loop; `content` is either plain text or a JSON media envelope. */
  const sendContent = async (content) => {
    if (!activeChat || sending) return;

    const clientMsgId = crypto.randomUUID();
    const optimisticMessage = {
      id: clientMsgId, // temporary ID
      type: activeChat.type,
      content,
      clientMsgId,
      client_msg_id: clientMsgId,
      senderId: user.id,
      ...(activeChat.type === "DIRECT"
        ? { recipientId: activeChat.id }
        : { groupId: activeChat.id }),
      status: "PENDING",
      createdAt: new Date().toISOString(),
    };

    appendMessage(optimisticMessage);
    setSending(true);

    try {
      let res = null;
      let lastError = null;
      for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
        try {
          res = await api.sendMessage(optimisticMessage);
        } catch (err) {
          res = null;
          lastError = err; // network-level failure (fetch threw)
        }

        if (res?.ok) {
          const saved = res.data.message;
          patchMessage(clientMsgId, { ...saved, status: "SENT" });
          useStore.getState().bumpConversation(activeChat.type, activeChat.id, {
            lastMessage: {
              id: saved.id,
              content: saved.content,
              senderId: saved.senderId,
              createdAt: saved.createdAt,
            },
          });
          notifyTyping(false);
          return true;
        }

        const status = res?.status ?? 0;
        // 4xx (validation, membership…) will never fix themselves — don't
        // hammer the server. 5xx / 429 / network errors are retriable.
        if (res && status < 500 && status !== 429) {
          setError(res.error ?? `Failed to send message (${status})`);
          patchMessage(clientMsgId, { status: "FAILED" });
          return false;
        }
        if (attempt === SEND_MAX_ATTEMPTS) break;

        const delay =
          SEND_BASE_DELAY_MS * 2 ** (attempt - 1) +
          Math.floor(Math.random() * SEND_JITTER_MAX_MS);
        console.warn(
          `[send] attempt ${attempt}/${SEND_MAX_ATTEMPTS} failed (${status || "network"}) — retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }

      setError(
        res?.status
          ? `Message not sent after ${SEND_MAX_ATTEMPTS} attempts — it was saved but delivery may be delayed`
          : `Message not sent after ${SEND_MAX_ATTEMPTS} attempts: ${lastError?.message ?? "network error"}`
      );
      patchMessage(clientMsgId, { status: "FAILED" });
      return false;
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (!activeChat || sending || upload) return;
    if (pendingFile) return sendMedia();
    const content = text.trim();
    if (!content) return;

    if (activeChat.type === "GROUP") {
      await loadGroupMembers(activeChat.id); // ensure member list for typing fan-out
    }

    const ok = await sendContent(content);
    if (ok) setText("");
  };

  /**
   * Uploads a selected file (3-step pipeline) and then sends the chat message
   * referencing the confirmed media id. Throws on upload failure — the error
   * card with the Retry button stays visible and the pending file is kept.
   */
  const uploadFileWithRetry = async (file) => {
    let res = null;
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        // 1. Request a pre-signed upload URL (validates type + size up front).
        res = await api.mediaUploadUrl({
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          size: file.size,
        });
        break;
      } catch {
        if (attempt === UPLOAD_MAX_ATTEMPTS) throw new Error("Network error requesting upload URL");
        await new Promise((r) => setTimeout(r, UPLOAD_BASE_DELAY_MS * attempt));
      }
    }
    if (!res.ok) {
      throw new Error(res.error ?? `Upload rejected (${res.status})`);
    }
    const { upload_id, upload_url } = res.data;
    setUpload({ filename: file.name, progress: 5, error: null, uploadId: upload_id });

    // 2. PUT the bytes directly to storage (never proxied through chat).
    await uploadToUrl(upload_url, file, (progress) =>
      setUpload((u) => (u ? { ...u, progress, error: null } : u))
    );

    // 3. Confirm — the service re-checks the actual stored size against the
    //    declared size and the per-kind cap.
    const confirm = await api.mediaConfirm(upload_id);
    if (!confirm.ok) {
      api.mediaCancel(upload_id).catch(() => {});
      throw new Error(confirm.error ?? "Upload confirm failed");
    }
    setUpload({ filename: file.name, progress: 100, error: null, uploadId: upload_id });
    return upload_id;
  };

  const sendMedia = async () => {
    if (!activeChat || sending) return;
    if (upload && !upload.error) return; // an upload is already in flight
    const file = pendingFile.file;
    const caption = text.trim();

    if (activeChat.type === "GROUP") {
      await loadGroupMembers(activeChat.id);
    }

    let uploadId;
    try {
      uploadId = await uploadFileWithRetry(file);
    } catch (err) {
      // Keep the pending file + show the error card with a Retry button.
      setUpload((u) => (u ? { ...u, error: err.message } : { filename: file.name, progress: 0, error: err.message }));
      return;
    }

    // 4. Send a normal chat message whose content references the media.
    const ok = await sendContent(
      JSON.stringify({
        text: caption,
        media: {
          media_id: uploadId,
          filename: file.name,
          content_type: file.type || "application/octet-stream",
          size: file.size,
        },
      })
    );
    if (ok) setText("");
    removePending();
    setUpload(null);
  };

  const handleFile = (file) => {
    if (!activeChat || sending || upload || pendingFile) return;
    const kind = file.type.startsWith("image/")
      ? "image"
      : file.type.startsWith("video/")
        ? "video"
        : null;
    if (!kind) {
      setError("Only images and videos can be attached");
      return;
    }
    const cap = kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (file.size > cap) {
      setError(
        kind === "image"
          ? "Images are limited to 15 MB"
          : "Videos are limited to 100 MB"
      );
      return;
    }
    setPendingFile({ file, kind, previewUrl: URL.createObjectURL(file) });
  };

  const removePending = () => {
    if (pendingFile?.previewUrl) URL.revokeObjectURL(pendingFile.previewUrl);
    setPendingFile(null);
  };

  /** Inserts the picked emoji at the caret position in the textarea. */
  const insertEmoji = (emoji) => {
    const el = textRef.current;
    const pos =
      el && el.selectionStart !== undefined && el.selectionStart !== null
        ? el.selectionStart
        : cursorRef.current;
    const next = text.slice(0, pos) + emoji + text.slice(pos);
    setText(next);
    cursorRef.current = pos + emoji.length;
    handleTyping();
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursorRef.current, cursorRef.current);
    });
  };

  if (!activeChat) return null;

  const hasText = text.trim().length > 0;
  const canSend = (hasText || !!pendingFile) && !sending && !upload;

  return (
    <footer className="px-4 py-3 shrink-0" style={{ background: "var(--nm-bg)" }}>
      {/* Inline preview of the selected file, removable before sending */}
      {pendingFile && !upload && (
        <div className="nm-raised-sm relative mb-3 w-fit rounded-2xl p-2">
          <div className="relative h-24 w-40 overflow-hidden rounded-xl">
            {pendingFile.kind === "video" ? (
              <>
                <video
                  src={pendingFile.previewUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </>
            ) : (
              <img
                src={pendingFile.previewUrl}
                alt="Selected"
                className="h-full w-full object-cover"
              />
            )}
          </div>
          <button
            onClick={removePending}
            title="Remove attachment"
            className="nm-icon-btn absolute -right-2 -top-2 h-6 w-6"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

      {/* Upload progress / failure (with explicit retry) */}
      {upload && (
        <div className="nm-raised-sm mb-3 rounded-2xl px-4 py-3 text-xs">
          <div className="flex items-center justify-between gap-2" style={{ color: "var(--nm-text)" }}>
            <span className="truncate">{upload.filename}</span>
            <span className="shrink-0">
              {upload.error
                ? "Upload failed"
                : upload.progress < 100
                  ? `Uploading ${upload.progress}%`
                  : "Sending…"}
            </span>
          </div>
          {!upload.error ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--nm-divider)" }}>
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${upload.progress}%`, background: "var(--nm-accent)" }}
              />
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="truncate" style={{ color: "var(--nm-error)" }}>{upload.error}</p>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={sendMedia}
                  className="rounded-lg px-2.5 py-1 font-medium transition hover:opacity-70"
                  style={{ background: "var(--nm-accent)", color: "#fff" }}
                >
                  Retry
                </button>
                <button
                  onClick={() => {
                    if (upload.uploadId) api.mediaCancel(upload.uploadId).catch(() => {});
                    removePending();
                    setUpload(null);
                  }}
                  className="font-medium transition hover:opacity-70"
                  style={{ color: "var(--nm-text-muted)" }}
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Emoji picker popover */}
      <div ref={emojiWrapRef} className="relative">
        {emojiOpen && !sending && (
          <div className="absolute bottom-full left-0 z-20 mb-2">
            <Suspense fallback={<div className="nm-raised-sm h-[360px] w-80 rounded-2xl" />}>
              <EmojiPicker
                theme={theme}
                height={360}
                width={320}
                lazyLoadEmojis
                onEmojiClick={(data) => insertEmoji(data.emoji)}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* Input bar — pressed inset container */}
      <div className="flex items-end gap-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />

        <div className="nm-pressed flex flex-1 items-center gap-2 rounded-[24px] px-4 py-2.5">
          {/* Emoji icon — opens the picker */}
          <button
            onClick={() => setEmojiOpen((o) => !o)}
            title="Emoji"
            className={`nm-icon-btn h-8 w-8 shrink-0 ${emojiOpen ? "active" : ""}`}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
          </button>

          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              cursorRef.current = e.target.selectionStart ?? cursorRef.current;
              handleTyping();
            }}
            onKeyUp={(e) => {
              cursorRef.current = e.target.selectionStart ?? cursorRef.current;
            }}
            onMouseUp={(e) => {
              cursorRef.current = e.target.selectionStart ?? cursorRef.current;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Message..."
            className="max-h-32 min-h-6 flex-1 resize-none bg-transparent py-1 text-[15px] outline-none"
            style={{ color: "var(--nm-text)" }}
          />

          {/* Attach icon — opens the file picker (images & videos) */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={sending || !!upload || !!pendingFile}
            title="Attach an image or video"
            className="nm-icon-btn h-8 w-8 shrink-0 disabled:opacity-40"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
        </div>

        {/* Send button — solid teal primary CTA when active, raised muted when inactive */}
        <button
          onClick={send}
          disabled={!canSend}
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition ${
            canSend
              ? "nm-btn-primary"
              : "nm-raised"
          }`}
          style={!canSend ? { color: "var(--nm-text-faint)" } : undefined}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </footer>
  );
}
