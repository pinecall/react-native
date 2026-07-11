import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import type { NativeCallState } from './definitions';

const LINKING_ERROR =
  `The package '@pinecall/react-native' doesn't seem to be linked. Make sure:\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: '' }) +
  '- You rebuilt the app after installing the package\n';

const PinecallCallModule = NativeModules.PinecallCall
  ? NativeModules.PinecallCall
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      },
    );

const emitter = NativeModules.PinecallCall
  ? new NativeEventEmitter(PinecallCallModule)
  : null;

export interface StateEvent {
  state: NativeCallState;
  reason?: string;
}
export interface ServerEvent {
  data: string;
}

/** Typed wrapper over the native module + its event emitter. */
export const PinecallCall = {
  isNativeCallSupported(): Promise<{ supported: boolean }> {
    return PinecallCallModule.isNativeCallSupported();
  },
  startCall(options: {
    callId: string;
    callerName: string;
    handle?: string;
    tokenUrl: string;
    direction?: 'outgoing' | 'incoming';
  }): Promise<void> {
    return PinecallCallModule.startCall(options);
  },
  endCall(): Promise<void> {
    return PinecallCallModule.endCall();
  },
  setMuted(muted: boolean): Promise<void> {
    return PinecallCallModule.setMuted(muted);
  },
  setSpeaker(on: boolean): Promise<void> {
    return PinecallCallModule.setSpeaker(on);
  },
  onState(cb: (e: StateEvent) => void): () => void {
    const sub = emitter?.addListener('state', (e) => cb(e as StateEvent));
    return () => sub?.remove();
  },
  onServerEvent(cb: (e: ServerEvent) => void): () => void {
    const sub = emitter?.addListener('serverEvent', (e) => cb(e as ServerEvent));
    return () => sub?.remove();
  },
};
