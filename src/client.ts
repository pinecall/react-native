import { PinecallCall } from './native';
import type {
  CallState,
  NativeCallState,
  StartCallOptions,
} from './definitions';

const INITIAL_STATE: CallState = {
  status: 'idle',
  phase: 'idle',
  agentId: null,
  isMuted: false,
  isSpeaker: false,
  duration: 0,
  messages: [],
  error: null,
};

type Listener = () => void;

/**
 * CallClient — headless call store for React Native. Framework-agnostic:
 * subscribe to state changes and render ANY UI you want (the transcript is
 * plain data). Pair with `useCallClient` from `@pinecall/react-native`.
 *
 * iOS: CallKit UI + native WebRTC audio, coordinated through CallKit's
 * audio-session activation. Android: on the roadmap.
 */
export class CallClient {
  private state: CallState = { ...INITIAL_STATE };
  private listeners = new Set<Listener>();
  private wired = false;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private botWords: Record<string, string[]> = {};
  private offState: (() => void) | null = null;
  private offServer: (() => void) | null = null;

  getState = (): Readonly<CallState> => this.state;

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ── public API ─────────────────────────────────────────────────────────────

  startCall = async (opts: StartCallOptions): Promise<void> => {
    this.reset();
    const { supported } = await PinecallCall.isNativeCallSupported();
    if (!supported) {
      this.set({ error: 'Native calls require a physical iOS device.' });
      return;
    }
    this.wire();

    const direction = opts.direction ?? 'outgoing';
    this.set({
      agentId: opts.agentId,
      status: direction === 'incoming' ? 'ringing' : 'connecting',
      messages: [],
      error: null,
    });

    await PinecallCall.startCall({
      callId: `pc-${opts.agentId}-${Date.now().toString(36)}`,
      callerName: opts.callerName,
      handle: opts.handle,
      tokenUrl: opts.tokenUrl,
      direction,
    });
  };

  endCall = async (): Promise<void> => {
    await PinecallCall.endCall(); // 'ended' event runs reset()
  };

  toggleMute = (): void => {
    const muted = !this.state.isMuted;
    void PinecallCall.setMuted(muted);
    this.set({ isMuted: muted });
  };

  toggleSpeaker = (): void => {
    const on = !this.state.isSpeaker;
    void PinecallCall.setSpeaker(on);
    this.set({ isSpeaker: on });
  };

  // ── native events ────────────────────────────────────────────────────────

  private wire() {
    if (this.wired) return;
    this.wired = true;
    this.offState = PinecallCall.onState(({ state, reason }) =>
      this.onNativeState(state, reason),
    );
    this.offServer = PinecallCall.onServerEvent(({ data }) => {
      try {
        this.onServerEvent(JSON.parse(data));
      } catch {
        /* non-JSON frame */
      }
    });
  }

  /** Remove native listeners. Call when the client is no longer needed. */
  destroy(): void {
    this.offState?.();
    this.offServer?.();
    this.offState = null;
    this.offServer = null;
    this.wired = false;
    this.reset();
  }

  private onNativeState(state: NativeCallState, reason?: string) {
    switch (state) {
      case 'ringing':
        this.set({ status: 'ringing' });
        break;
      case 'connecting':
        this.set({ status: 'connecting' });
        break;
      case 'connected': {
        this.set({ status: 'connected', phase: 'listening', duration: 0 });
        const startedAt = Date.now();
        this.durationTimer = setInterval(() => {
          this.set({ duration: Math.floor((Date.now() - startedAt) / 1000) });
        }, 1000);
        break;
      }
      case 'error':
        this.set({ error: reason ?? 'call failed' });
        this.reset();
        break;
      case 'ended':
      case 'declined':
        this.reset();
        break;
    }
  }

  /** Pinecall DataChannel events → transcript. */
  private onServerEvent(d: Record<string, any>) {
    switch (d.event) {
      case 'user.speaking':
        if (d.text) this.upsertUser(d.text, true);
        this.set({ phase: 'listening' });
        break;
      case 'user.message':
        if (d.text) this.upsertUser(d.text, false);
        this.set({ phase: 'thinking' });
        break;
      case 'bot.word': {
        if (!d.message_id || !d.word) break;
        const words = (this.botWords[d.message_id] ??= []);
        words[d.word_index ?? words.length] = d.word;
        this.upsertBot(d.message_id, words.filter(Boolean).join(' '));
        this.set({ phase: 'speaking' });
        break;
      }
      case 'bot.finished':
        if (d.message_id && d.text) this.upsertBot(d.message_id, d.text);
        this.set({ phase: 'listening' });
        break;
    }
  }

  private upsertUser(text: string, isInterim: boolean) {
    const msgs = this.state.messages;
    const last = msgs[msgs.length - 1];
    if (last?.role === 'user' && last.isInterim) {
      this.set({ messages: [...msgs.slice(0, -1), { ...last, text, isInterim }] });
    } else {
      this.set({
        messages: [...msgs, { id: msgs.length + 1, role: 'user', text, isInterim }],
      });
    }
  }

  private upsertBot(messageId: string, text: string) {
    const msgs = this.state.messages;
    const idx = msgs.findIndex((m) => m.messageId === messageId);
    if (idx >= 0) {
      this.set({ messages: msgs.map((m, i) => (i === idx ? { ...m, text } : m)) });
    } else {
      this.set({
        messages: [...msgs, { id: msgs.length + 1, role: 'bot', text, messageId }],
      });
    }
  }

  private reset() {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    this.botWords = {};
    this.set({ ...INITIAL_STATE, error: this.state.error });
  }
}
