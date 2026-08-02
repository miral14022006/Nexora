/**
 * Thin REST client for the API gateway. Automatically refreshes the access
 * token on 401 and retries the request once.
 *
 * VITE_API_BASE_URL — When deployed to Render (or any separate origin), set
 * this build-time env var to the api-gateway's public URL, e.g.
 * https://api-gateway-xxxx.onrender.com. When unset (local dev), relative
 * paths work via Vite's dev proxy.
 */

export const API_BASE = import.meta.env.VITE_API_BASE_URL
  ? import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "")
  : (import.meta.env.PROD ? "https://nexora-mwyg.onrender.com" : "");

const SESSION_KEY = "nexora.session";

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) ?? null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

let session = loadSession();

export function getSession() {
  return session;
}

export function setSession(next) {
  session = next;
  if (next) saveSession(next);
  else clearSession();
}

async function request(path, { method = "GET", body, auth = true, retried = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && session?.accessToken) {
    headers["Authorization"] = `Bearer ${session.accessToken}`;
  }

  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && auth && session?.refreshToken && !retried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request(path, { method, body, auth, retried: true });
    return { status: 401, ok: false, error: "Session expired" };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const data =
    res.status === 204
      ? null
      : contentType.includes("application/json")
        ? await res.json()
        : await res.text();

  if (!res.ok) {
    return { status: res.status, ok: false, error: data?.error ?? `Request failed (${res.status})` };
  }
  return { status: res.status, ok: true, data };
}

async function refreshAccessToken() {
  const old = session;
  const res = await fetch(`${API_BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: old.refreshToken }),
  });
  if (!res.ok) {
    setSession(null);
    return false;
  }
  const tokens = await res.json();
  setSession({ ...old, ...tokens });
  return true;
}

import { useStore } from "./store.js";

export const api = {
  signup: (payload) => request("/auth/signup", { method: "POST", body: payload, auth: false }),
  login: (payload) => request("/auth/login", { method: "POST", body: payload, auth: false }),
  logout: () => request("/auth/logout", { method: "POST", body: { refreshToken: session?.refreshToken }, auth: false }),

  conversations: () => request("/conversations"),
  directHistory: (userId, cursor) =>
    request(`/messages/direct/${userId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  groupHistory: (groupId, cursor) =>
    request(`/messages/group/${groupId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
  sendMessage: (payload) => request("/messages", { method: "POST", body: payload }),
  markRead: (messageId) => request(`/messages/${messageId}/read`, { method: "PATCH" }),
  messageStatus: (messageId) => request(`/messages/${messageId}/status`),

  mediaUploadUrl: (payload) => request("/media/upload-url", { method: "POST", body: payload }),
  mediaConfirm: (mediaId) => request(`/media/${mediaId}/confirm`, { method: "POST" }),
  mediaCancel: (mediaId) => request(`/media/${mediaId}/cancel`, { method: "POST" }),
  mediaGetUrl: (mediaId) => request(`/media/${mediaId}/url`),
  mediaInfo: (mediaId) => request(`/media/${mediaId}`),

  searchUsers: (q) => request(`/users/search?q=${encodeURIComponent(q)}`),
  presence: (userIds) =>
    request(`/presence?userIds=${userIds.map(encodeURIComponent).join(",")}`, { auth: false }),

  createGroup: (payload) => request("/groups", { method: "POST", body: payload }),
  myGroups: () => request("/groups"),
  groupMembers: (groupId) => request(`/groups/${groupId}/members`),
  addMember: (groupId, userId) =>
    request(`/groups/${groupId}/members`, { method: "POST", body: { userId } }),
  removeMember: (groupId, userId) =>
    request(`/groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  leaveGroup: (groupId) => request(`/groups/${groupId}/leave`, { method: "POST" }),
};

export const wsUrl = () => {
  const base = API_BASE || window.location.origin;
  const proto = base.startsWith("https") ? "wss" : "ws";
  const host = base.replace(/^https?:\/\//, "");
  const maxSeq = useStore.getState().maxSequence;
  return `${proto}://${host}/ws?token=${encodeURIComponent(session?.accessToken ?? "")}&last_received_sequence=${maxSeq}`;
};
