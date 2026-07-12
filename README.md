# @pinecall/react-native

**Native WhatsApp-style AI voice calls for React Native.**

Your users get a real phone call — native CallKit ring, the iOS in-call screen,
lock-screen controls, earpiece/speaker routing — and on the other end is a
[Pinecall](https://pinecall.io) AI agent. The core is headless: the live
transcript is plain data, render it with whatever components you like.

```
tap "call" ──▶ CallKit rings / dials (native UI)
       answer ──▶ native WebRTC audio ⇄ voice.pinecall.io ⇄ your agent
                  DataChannel events ──▶ live transcript in YOUR components
```

Same architecture as [`@pinecall/ionic`](https://github.com/pinecall/ionic):
CallKit + **WebRTC.framework** natively, with audio started exactly when
CallKit activates the session — the piece a JS/webview WebRTC stack can't do
during a CXCall.

## Install

```bash
npm install @pinecall/react-native
cd ios && pod install
```

Add to `ios/<App>/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Microphone access is needed to talk to the agent.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
  <string>voip</string>
</array>
```

> iOS only for now (Android on the roadmap). CallKit does **not** work on the
> iOS simulator — test on a real device.

## Backend: mint call tokens

Your backend runs the agent and exposes a token endpoint; the app never sees
your Pinecall API key.

```js
import { Pinecall } from "@pinecall/sdk";

const pc = new Pinecall(); // PINECALL_API_KEY from env
const agent = pc.agent("assistant", {
  prompt: "You are a friendly voice assistant.",
  llm: "openai/gpt-5-chat-latest",
  voice: "elevenlabs/sarah",
  stt: "deepgram/flux",
  greeting: "Hey there! How can I help you today?",
});

app.get("/api/token", async (_req, res) => {
  const t = await agent.createToken("webrtc"); // 60s, single-use
  res.json({ token: t.token, server: t.server, expires_in: t.expiresIn });
});
```

## Use

```tsx
import { CallClient, useCallClient } from "@pinecall/react-native";

const client = new CallClient(); // one shared instance

function App() {
  const call = useCallClient(client);

  if (call.status === "idle") {
    return (
      <Button
        title="📞 Call the agent"
        onPress={() =>
          call.startCall({
            agentId: "assistant",
            callerName: "Assistant",
            handle: "AI voice agent",
            tokenUrl: "https://your-backend.com/api/token",
            // direction: "incoming"  // agent rings YOU instead
          })
        }
      />
    );
  }

  // Your UI, your components — the transcript is plain data:
  return (
    <View>
      <Text>{call.status} · {call.phase} · {call.duration}s</Text>
      {call.messages.map((m) => (
        <Text key={m.id}>{m.role === "bot" ? "🤖" : "🗣"} {m.text}</Text>
      ))}
      <Button title="🔊" onPress={call.toggleSpeaker} />
      <Button title="🎙" onPress={call.toggleMute} />
      <Button title="End" onPress={call.endCall} />
    </View>
  );
}
```

> During the native ring (`direction: 'incoming'`), CallKit owns the screen —
> render your in-call UI when `status` is `connecting`/`connected`.

### Direction

- `direction: 'outgoing'` (default) — the user dials the agent: native
  outgoing-call UI, connects immediately.
- `direction: 'incoming'` — the agent calls the user: native ring, connects on
  answer. Rings only while the app is running; a killed/backgrounded ring needs
  PushKit (paid Apple Developer account).

## API

### `CallClient` (headless core)

| Member | Description |
|---|---|
| `startCall(opts)` | `{ agentId, callerName, handle?, tokenUrl, direction? }` |
| `endCall()` | Hang up (syncs the native call UI). |
| `toggleMute()` | Mic on/off. |
| `toggleSpeaker()` | Loudspeaker ↔ earpiece (earpiece is the default). |
| `getState()` / `subscribe(cb)` | Reactive store: `{ status, phase, agentId, isMuted, isSpeaker, duration, messages, error }` |
| `destroy()` | Remove native listeners. |

`messages: TranscriptMessage[]` — `{ id, role: 'user' | 'bot', text, isInterim? }`,
updated live word-by-word while the agent speaks.

### `useCallClient(client?)`

React hook returning the state plus the actions. Pass a shared `CallClient` so
non-React code (push handlers) can start calls on the same instance.

## Example app

[`example/`](example) — agent list, native outgoing + incoming calls, custom
in-call screen with live transcript, plus a dev token backend (`example/server`).

```bash
cd example/server && cp .env.example .env   # add PINECALL_API_KEY
npm install && npm start                     # agent + token server on :8787

# point example/src/config.ts SERVER_BASE at your Mac's LAN IP, then:
cd example && yarn ios --device   # real device — CallKit needs it
```

## Platform support

| Target | Call UI | Audio | Status |
|---|---|---|---|
| iOS device | CallKit (native) | WebRTC.framework (native) | ✅ |
| iOS simulator | — | — | ⛔ CallKit unsupported by the simulator |
| Android device (API 26+) | your UI + self-managed Telecom | native WebRTC | ✅ (pending device test) |

### Android notes

Android's [self-managed `ConnectionService`](https://developer.android.com/reference/android/telecom/ConnectionService)
is the CallKit equivalent — it gives your call native **audio routing, focus,
Bluetooth, and Do-Not-Disturb** integration. The difference from iOS: **your app
draws the in-call UI** (the system doesn't), so the same `CallScreen` you render
from `CallClient` state *is* the call screen. WebRTC runs via
`io.github.webrtc-sdk:android` (the same 125.x family as iOS). The plugin's
manifest (permissions + the `ConnectionService`) auto-merges into your app; add
a runtime request for `RECORD_AUDIO` + `MANAGE_OWN_CALLS`. Ringing a
backgrounded/killed app still needs FCM (roadmap). Requires API 26+.

## Roadmap

- Background/killed-app ringing — PushKit (iOS, paid Apple account) + FCM
  high-priority push (Android) with a full-screen-intent notification
- Mid-call `configure()` (hot-swap voice/language), sealed token metadata
- Reconnection / ICE restarts, bluetooth route picker

## License

MIT
