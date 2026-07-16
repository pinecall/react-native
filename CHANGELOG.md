# Changelog

All notable changes to `@pinecall/react-native` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] — 2026-07-16

### Added — Android: native calls via self-managed ConnectionService

- Shared `io.pinecall.call.*` (identical to `@pinecall/ionic`'s):
  `PinecallCallController` (WebRTC via `io.github.webrtc-sdk:android`, the
  Pinecall protocol, and self-managed Telecom `PhoneAccount` / `placeCall` /
  `addNewIncomingCall`), `PinecallConnection` (a self-managed Telecom
  Connection handling speaker routing), and `PinecallConnectionService`.
- **RN bridge** — a legacy `PinecallCallModule` (`RCTDeviceEventEmitter`)
  replaces the turbo scaffold; `ReactNativePackage` is now a plain
  `ReactPackage`.
- Manifest merges `MANAGE_OWN_CALLS` / `RECORD_AUDIO` and the
  `ConnectionService`; the example requests `RECORD_AUDIO` at runtime.

Kotlin compiles clean (`gradle BUILD SUCCESSFUL` against real WebRTC/Telecom).

## [0.1.0] — 2026-06-24

First published release: native AI voice calls on iOS, porting the working
`@pinecall/ionic` architecture to React Native.

### Added

- **Native module** (`ios/`) — `PinecallCall` (`RCTEventEmitter`) bridges JS to
  the shared `PinecallCallController.swift` (CallKit `CXProvider` +
  `WebRTC.framework`), reused verbatim: CallKit UI plus native audio
  coordinated through `RTCAudioSession` manual mode + `didActivate`. The
  podspec pulls WebRTC-SDK. Runs under the New Architecture via RN's
  legacy-module interop.
- **Headless core** (`src/`) — a `CallClient` store and a `useCallClient` hook.
  The transcript is plain data streamed word-by-word off the DataChannel, so
  consumers own the UI entirely.
- **Outgoing and incoming call directions.**
