import Foundation
import AVFoundation
import CallKit
import WebRTC

/// PinecallCallController — the native call brain.
///
/// Owns BOTH sides of a WhatsApp-style call:
///  - CallKit (CXProvider): native incoming-call UI, answer/end/mute actions,
///    audio-session activation.
///  - Native WebRTC (WebRTC.framework): mic capture, audio playout, and the
///    Pinecall signaling protocol (token → POST /webrtc/offer → answer +
///    an "events" DataChannel with 1s "ping" keepalive — same wire protocol
///    as @pinecall/web's VoiceSession).
///
/// Audio-session coordination (the whole reason this exists): RTCAudioSession
/// runs in MANUAL audio mode; audio units start only after CallKit hands us
/// the session in `provider(_:didActivate:)`. This is what a WKWebView-based
/// WebRTC stack can never do — and why webview audio is silent during a CXCall.
final class PinecallCallController: NSObject {

    // MARK: Types

    struct StartOptions {
        let callId: String
        let callerName: String
        let handle: String
        let tokenUrl: String
        /// "outgoing" (user dials the agent) or "incoming" (agent calls the user)
        let direction: String
    }

    /// state values emitted to JS: ringing | connecting | connected | ended | declined | error
    var onState: ((String, String?) -> Void)?
    /// raw JSON strings from the server DataChannel, forwarded to JS
    var onServerEvent: ((String) -> Void)?

    // MARK: CallKit

    private let provider: CXProvider
    private let callController = CXCallController()
    private var currentUUID: UUID?
    private var currentOptions: StartOptions?
    private var answered = false

    // MARK: WebRTC

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()
    private var pc: RTCPeerConnection?
    private var audioTrack: RTCAudioTrack?
    private var dataChannel: RTCDataChannel?
    private var pingTimer: Timer?
    private var iceGatheringDone: ((String) -> Void)?

    // MARK: Init

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: nil)
        // Manual audio: WebRTC must NOT start audio units on its own — it waits
        // for CallKit's didActivate. Set once, before any peer connection.
        RTCAudioSession.sharedInstance().useManualAudio = true
    }

    // MARK: Public API (called from the plugin)

    func startCall(_ opts: StartOptions, completion: @escaping (Error?) -> Void) {
        endCurrent(reason: "replaced") // one call at a time

        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                completion(NSError(domain: "PinecallCall", code: 1,
                                   userInfo: [NSLocalizedDescriptionKey: "Microphone permission denied"]))
                return
            }
            let uuid = UUID()
            self.currentUUID = uuid
            self.currentOptions = opts
            self.answered = false

            if opts.direction == "outgoing" {
                self.startOutgoing(uuid: uuid, opts: opts, completion: completion)
            } else {
                self.reportIncoming(uuid: uuid, opts: opts, completion: completion)
            }
        }
    }

    /// User dials the agent — native OUTGOING call UI (no ring).
    private func startOutgoing(uuid: UUID, opts: StartOptions, completion: @escaping (Error?) -> Void) {
        let handle = CXHandle(type: .generic, value: opts.handle)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.contactIdentifier = opts.callerName
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let self else { return }
            if error == nil {
                // Name the call in the system UI.
                let update = CXCallUpdate()
                update.localizedCallerName = opts.callerName
                self.provider.reportCall(with: uuid, updated: update)
                self.onState?("connecting", nil)
            }
            completion(error)
        }
    }

    private func reportIncoming(uuid: UUID, opts: StartOptions, completion: @escaping (Error?) -> Void) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: opts.handle)
        update.localizedCallerName = opts.callerName
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error == nil { self?.onState?("ringing", nil) }
            completion(error)
        }
    }

    func endCall() {
        guard let uuid = currentUUID else { return }
        // Route through CallKit so the system UI stays in sync.
        let action = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: action)) { [weak self] error in
            if error != nil { self?.endCurrent(reason: "ended") } // fallback
        }
    }

    func setMuted(_ muted: Bool) {
        audioTrack?.isEnabled = !muted
        sendOnDataChannel("{\"action\":\"\(muted ? "mute" : "unmute")\"}")
    }

    /// Route audio to the loudspeaker (true) or back to the earpiece (false).
    func setSpeaker(_ on: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.overrideOutputAudioPort(on ? .speaker : .none)
        session.unlockForConfiguration()
    }

    // MARK: WebRTC connect (Pinecall protocol)

    private func connectWebRTC() {
        guard let opts = currentOptions else { return }
        onState?("connecting", nil)

        Task {
            do {
                // 1. Short-lived token from OUR backend (never the API key)
                let tokenRes = try await self.getJSON(opts.tokenUrl)
                guard let token = tokenRes["token"] as? String,
                      let server = tokenRes["server"] as? String else {
                    throw self.err("token response missing token/server")
                }

                // 2. ICE servers (fallback: Google STUN)
                var iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
                if let iceRes = try? await self.getJSON("\(server)/webrtc/ice-servers"),
                   let list = iceRes["iceServers"] as? [[String: Any]] {
                    iceServers = list.compactMap { entry in
                        guard let urls = entry["urls"] as? [String] else { return nil }
                        return RTCIceServer(urlStrings: urls,
                                            username: entry["username"] as? String,
                                            credential: entry["credential"] as? String)
                    }
                }

                // 3. PeerConnection + mic track + DataChannel (before the offer)
                let sdp = try await self.buildPeerAndOffer(iceServers: iceServers)

                // 4. POST offer → apply answer
                let answer = try await self.postJSON("\(server)/webrtc/offer",
                                                     body: ["sdp": sdp, "type": "offer", "token": token])
                guard let answerSdp = answer["sdp"] as? String else {
                    throw self.err("offer response missing sdp")
                }
                let remote = RTCSessionDescription(type: .answer, sdp: answerSdp)
                try await self.pc?.setRemoteDescription(remote)
            } catch {
                self.onState?("error", error.localizedDescription)
                self.endCurrent(reason: "error")
            }
        }
    }

    /// Create PC, add mic, create DataChannel, create offer, wait for ICE
    /// gathering (2s cap — same as the web SDK), return the local SDP.
    private func buildPeerAndOffer(iceServers: [RTCIceServer]) async throws -> String {
        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan

        let pcConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = Self.factory.peerConnection(with: config, constraints: pcConstraints, delegate: self) else {
            throw err("failed to create peer connection")
        }
        self.pc = pc

        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: ["echoCancellation": "true",
                                   "noiseSuppression": "true",
                                   "autoGainControl": "true"],
            optionalConstraints: nil)
        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "audio0")
        self.audioTrack = track
        pc.add(track, streamIds: ["stream0"])

        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        self.dataChannel = pc.dataChannel(forLabel: "events", configuration: dcConfig)
        self.dataChannel?.delegate = self

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true"],
            optionalConstraints: nil)
        let offer = try await pc.offer(for: offerConstraints)
        try await pc.setLocalDescription(offer)

        // Vanilla ICE: wait for gathering complete, capped at 2s.
        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            var resumed = false
            let finish: (String) -> Void = { sdp in
                guard !resumed else { return }
                resumed = true
                cont.resume(returning: sdp)
            }
            self.iceGatheringDone = { sdp in finish(sdp) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                finish(self?.pc?.localDescription?.sdp ?? offer.sdp)
            }
            if pc.iceGatheringState == .complete {
                finish(pc.localDescription?.sdp ?? offer.sdp)
            }
        }
    }

    // MARK: teardown

    private func endCurrent(reason: String) {
        pingTimer?.invalidate()
        pingTimer = nil
        dataChannel?.close()
        dataChannel = nil
        audioTrack = nil
        pc?.close()
        pc = nil
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        if let uuid = currentUUID {
            provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        }
        currentUUID = nil
        currentOptions = nil
        iceGatheringDone = nil
    }

    // MARK: helpers

    private func sendOnDataChannel(_ text: String) {
        guard let dc = dataChannel, dc.readyState == .open,
              let data = text.data(using: .utf8) else { return }
        dc.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    private func err(_ message: String) -> NSError {
        NSError(domain: "PinecallCall", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func getJSON(_ url: String) async throws -> [String: Any] {
        guard let u = URL(string: url) else { throw err("bad url \(url)") }
        let (data, _) = try await URLSession.shared.data(from: u)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    private func postJSON(_ url: String, body: [String: Any]) async throws -> [String: Any] {
        guard let u = URL(string: url) else { throw err("bad url \(url)") }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, res) = try await URLSession.shared.data(for: req)
        if let http = res as? HTTPURLResponse, http.statusCode >= 400 {
            throw err("HTTP \(http.statusCode) from \(url)")
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
}

// MARK: - CXProviderDelegate

extension PinecallCallController: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        endCurrent(reason: "reset")
        onState?("ended", "provider_reset")
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        answered = true
        configureCallAudioSession()
        connectWebRTC()
        action.fulfill()
    }

    /// Outgoing call — CallKit asks us to start it: same audio + WebRTC path,
    /// then report the dialing progress so the system UI shows "calling…".
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        answered = true // hanging up an outgoing call is "ended", not "declined"
        configureCallAudioSession()
        connectWebRTC()
        action.fulfill()
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    }

    /// Configure the shared audio session for a voice call; the audio units
    /// start in didActivate.
    private func configureCallAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.setCategory(AVAudioSession.Category.playAndRecord, with: [.allowBluetooth])
        try? session.setMode(AVAudioSession.Mode.voiceChat)
        session.unlockForConfiguration()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let wasAnswered = answered
        endCurrent(reason: wasAnswered ? "ended" : "declined")
        onState?(wasAnswered ? "ended" : "declined", "user")
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        setMuted(action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit handed us the audio session — NOW WebRTC may run audio I/O.
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
        RTCAudioSession.sharedInstance().isAudioEnabled = true
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    }
}

// MARK: - RTCPeerConnectionDelegate

extension PinecallCallController: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete, let sdp = peerConnection.localDescription?.sdp {
            iceGatheringDone?(sdp)
            iceGatheringDone = nil
        }
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        switch newState {
        case .connected:
            // Outgoing calls: tell CallKit the call is live (stops "calling…").
            if currentOptions?.direction == "outgoing", let uuid = currentUUID {
                provider.reportOutgoingCall(with: uuid, connectedAt: Date())
            }
            onState?("connected", nil)
        case .disconnected, .failed:
            DispatchQueue.main.async { [weak self] in
                guard let self, self.pc != nil else { return }
                self.endCurrent(reason: "connection_lost")
                self.onState?("ended", "connection_lost")
            }
        default:
            break
        }
    }
}

// MARK: - RTCDataChannelDelegate

extension PinecallCallController: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        if dataChannel.readyState == .open {
            DispatchQueue.main.async { [weak self] in
                self?.pingTimer?.invalidate()
                self?.pingTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
                    self?.sendOnDataChannel("ping")
                }
            }
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else { return }
        onServerEvent?(text)
    }
}
