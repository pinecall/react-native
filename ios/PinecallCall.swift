import Foundation
import React

/// React Native bridge for the native call stack. Thin — all logic lives in
/// PinecallCallController (shared, framework-agnostic).
///
/// Legacy RCTEventEmitter module: works under the New Architecture via RN's
/// interop layer (same approach as react-native-callkeep / react-native-webrtc).
@objc(PinecallCall)
final class PinecallCall: RCTEventEmitter {

    private let controller = PinecallCallController()
    private var hasListeners = false

    override init() {
        super.init()
        controller.onState = { [weak self] state, reason in
            guard let self, self.hasListeners else { return }
            var body: [String: Any] = ["state": state]
            if let reason { body["reason"] = reason }
            self.sendEvent(withName: "state", body: body)
        }
        controller.onServerEvent = { [weak self] json in
            guard let self, self.hasListeners else { return }
            self.sendEvent(withName: "serverEvent", body: ["data": json])
        }
    }

    override static func requiresMainQueueSetup() -> Bool { true }

    override func supportedEvents() -> [String]! { ["state", "serverEvent"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: JS-facing methods

    @objc(isNativeCallSupported:rejecter:)
    func isNativeCallSupported(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        #if targetEnvironment(simulator)
        resolve(["supported": false])
        #else
        resolve(["supported": true])
        #endif
    }

    @objc(startCall:resolver:rejecter:)
    func startCall(_ options: NSDictionary,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let callId = options["callId"] as? String,
              let callerName = options["callerName"] as? String,
              let tokenUrl = options["tokenUrl"] as? String else {
            reject("bad_args", "callId, callerName and tokenUrl are required", nil)
            return
        }
        let opts = PinecallCallController.StartOptions(
            callId: callId,
            callerName: callerName,
            handle: (options["handle"] as? String) ?? callerName,
            tokenUrl: tokenUrl,
            direction: (options["direction"] as? String) ?? "outgoing"
        )
        controller.startCall(opts) { error in
            if let error {
                reject("start_failed", error.localizedDescription, error)
            } else {
                resolve(nil)
            }
        }
    }

    @objc(endCall:rejecter:)
    func endCall(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        controller.endCall()
        resolve(nil)
    }

    @objc(setMuted:resolver:rejecter:)
    func setMuted(_ muted: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        controller.setMuted(muted)
        resolve(nil)
    }

    @objc(setSpeaker:resolver:rejecter:)
    func setSpeaker(_ on: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        controller.setSpeaker(on)
        resolve(nil)
    }
}
