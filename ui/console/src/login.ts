// The one-time login token travels in the URL fragment (#login=…), which never reaches the server or the Referer.

/**
 * Takes the login token out of the address bar, or null when the fragment carries none. The history entry is
 * replaced too, so Back or a bookmark never brings the token back. Used both at page load and when a new link is
 * opened in an already loaded tab (same-document navigation only fires hashchange).
 */
export function takeLoginToken(): string | null {
  const hash = location.hash;
  if (!hash.startsWith("#login=")) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const raw = hash.slice("#login=".length);
  // A mangled paste may not decode; the server then refuses it like any other wrong token.
  try { return decodeURIComponent(raw); } catch { return raw; }
}
