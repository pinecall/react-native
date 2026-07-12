/**
 * Where the app fetches WebRTC tokens from (the `server/` backend).
 *
 * - Real iOS/Android device → point at your Mac's LAN IP (`ipconfig getifaddr en0`).
 * - Android emulator → the host Mac is reachable at `http://10.0.2.2:8787`.
 * - iOS simulator → `http://localhost:8787` works.
 */
export const SERVER_BASE = 'http://172.20.10.3:8787';

export const TOKEN_ENDPOINT = `${SERVER_BASE}/api/token`;
