/**
 * Where the app fetches WebRTC tokens from (the `server/` backend).
 *
 * A real device can't reach `localhost` (that's the phone) — point this at
 * your Mac's LAN IP. Find it with `ipconfig getifaddr en0`.
 */
export const SERVER_BASE = 'http://172.20.10.3:8787';

export const TOKEN_ENDPOINT = `${SERVER_BASE}/api/token`;
