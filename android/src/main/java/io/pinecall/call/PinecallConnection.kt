package io.pinecall.call

import android.os.Build
import android.telecom.Connection
import android.telecom.DisconnectCause
import androidx.annotation.RequiresApi

/**
 * A single self-managed Telecom call. The system routes native audio/focus
 * through it; the app draws the actual in-call UI. Callbacks (answer / reject /
 * disconnect) are forwarded to the shared PinecallCallController.
 */
@RequiresApi(Build.VERSION_CODES.O)
class PinecallConnection : Connection() {

    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        connectionCapabilities = CAPABILITY_MUTE or CAPABILITY_SUPPORT_HOLD
    }

    override fun onAnswer() {
        setActive()
        PinecallCallController.onAnswered()
    }

    override fun onReject() {
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        PinecallCallController.onEnded(fromUser = true)
    }

    override fun onDisconnect() {
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        PinecallCallController.onEnded(fromUser = true)
    }

    override fun onAbort() {
        setDisconnected(DisconnectCause(DisconnectCause.CANCELED))
        destroy()
        PinecallCallController.onEnded(fromUser = false)
    }

    override fun onShowIncomingCallUi() {
        // Self-managed: WE present the incoming UI. The JS layer already shows
        // the in-app ring via the "ringing" state; a production app would also
        // post a full-screen-intent notification here for the lock screen.
        PinecallCallController.onIncomingUiRequested()
    }

    override fun onStateChanged(state: Int) {
        // no-op; state is mirrored through the controller
    }
}
