/**
 * Playlists live on the machine that plays them.
 *
 * They used to be files in a GitHub repository, from a period when the repo
 * doubled as the server. That made a local app ask the internet for its own
 * library, demand a personal access token to save a list of songs, and hand
 * back state the person had already deleted on their own computer. The songs a
 * playlist points at are separated and analysed here; the list belongs here too.
 */

import { state } from "./state.js?v=170";

function serviceBaseUrl() {
  const base = String(state.processingServiceUrl || "http://127.0.0.1:8765").trim();
  return base.replace(/\/+$/, "");
}

function playlistUrl(slug = "") {
  const suffix = slug ? `/${encodeURIComponent(slug)}` : "";
  return `${serviceBaseUrl()}/v1/playlists${suffix}`;
}

/** Every playlist stored on this machine. */
export async function fetchLocalPlaylists() {
  const response = await fetch(`${playlistUrl()}?cache=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Playliste nisu dostupne");
  const payload = await response.json();
  return Array.isArray(payload?.playlists) ? payload.playlists : [];
}

export async function loadLocalPlaylist(slug) {
  const response = await fetch(`${playlistUrl(slug)}?cache=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Playlist nije ucitana");
  return await response.json();
}

export async function saveLocalPlaylist(slug, data) {
  const response = await fetch(playlistUrl(slug), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!response.ok) {
    const error = new Error("Playlist nije sacuvana");
    error.status = response.status;
    throw error;
  }
  return await response.json();
}

export async function deleteLocalPlaylist(slug) {
  const response = await fetch(playlistUrl(slug), { method: "DELETE" });
  return response.ok;
}

/** A file name that stays readable and cannot escape its directory. */
export function playlistSlug(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase()
    .slice(0, 80);
}
