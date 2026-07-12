package io.pinecall.call

import android.os.Build
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.PhoneAccountHandle
import androidx.annotation.RequiresApi

/**
 * Self-managed ConnectionService. The system binds to this to create a
 * Connection for each outgoing (placeCall) / incoming (addNewIncomingCall)
 * request; we hand back a PinecallConnection wired to the controller.
 */
@RequiresApi(Build.VERSION_CODES.O)
class PinecallConnectionService : ConnectionService() {

    override fun onCreateOutgoingConnection(
        accountHandle: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection = makeConnection(request)

    override fun onCreateIncomingConnection(
        accountHandle: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection = makeConnection(request)

    private fun makeConnection(request: ConnectionRequest?): Connection {
        val opts = PinecallCallController.consumePending()
        val conn = PinecallConnection()
        conn.setAddress(request?.address, android.telecom.TelecomManager.PRESENTATION_ALLOWED)
        if (opts != null) conn.setCallerDisplayName(opts.callerName, android.telecom.TelecomManager.PRESENTATION_ALLOWED)
        conn.setInitializing()
        conn.setInitialized()
        PinecallCallController.attachConnection(conn)
        return conn
    }
}
