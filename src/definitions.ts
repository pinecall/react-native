export interface TranscriptMessage {
  id: number;
  role: 'user' | 'bot';
  text: string;
  /** User message still being spoken (interim STT). */
  isInterim?: boolean;
  /** Server-assigned id for word-by-word bot updates. */
  messageId?: string;
}

export type CallStatus =
  'idle' | 'ringing' | 'connecting' | 'connected' | 'error';

export type CallPhase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface CallState {
  status: CallStatus;
  phase: CallPhase;
  /** Your app-level id of who is being called (echo of startCall). */
  agentId: string | null;
  isMuted: boolean;
  /** Loudspeaker on. Earpiece is the default, like WhatsApp. */
  isSpeaker: boolean;
  duration: number;
  messages: TranscriptMessage[];
  error: string | null;
}

export interface StartCallOptions {
  /** Pinecall agent id to talk to. */
  agentId: string;
  /** Name shown in the native call UI. */
  callerName: string;
  /** Secondary line in the native call UI (e.g. "AI voice agent"). */
  handle?: string;
  /**
   * Your backend endpoint returning `{ token, server }` — mint it with
   * `agent.createToken("webrtc")`. Your Pinecall API key never reaches the app.
   */
  tokenUrl: string;
  /**
   * `'outgoing'` (default) — the user dials the agent: native outgoing-call
   * UI, connects immediately. `'incoming'` — the agent calls the user: native
   * ring, connects on answer. Ringing a killed/backgrounded app needs PushKit
   * (paid Apple Developer account) — see docs.
   */
  direction?: 'outgoing' | 'incoming';
}

/** Raw native events emitted by the plugin. */
export type NativeCallState =
  'ringing' | 'connecting' | 'connected' | 'ended' | 'declined' | 'error';
