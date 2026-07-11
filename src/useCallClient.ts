import { useState, useSyncExternalStore } from 'react';
import { CallClient } from './client';
import type { CallState, StartCallOptions } from './definitions';

export interface UseCallResult extends CallState {
  startCall: (opts: StartCallOptions) => Promise<void>;
  endCall: () => Promise<void>;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  client: CallClient;
}

/**
 * React binding for a `CallClient`. Headless — you own the UI entirely:
 * render `messages` (the live transcript), `status`, `phase`, `duration`
 * with whatever components you like.
 *
 * Pass a shared `CallClient` instance (recommended — lets non-React code like
 * push handlers start calls too), or omit it to create a local one.
 */
export function useCallClient(client?: CallClient): UseCallResult {
  const [owned] = useState(() => client ?? new CallClient());
  const state = useSyncExternalStore(owned.subscribe, owned.getState);

  return {
    ...state,
    startCall: owned.startCall,
    endCall: owned.endCall,
    toggleMute: owned.toggleMute,
    toggleSpeaker: owned.toggleSpeaker,
    client: owned,
  };
}
