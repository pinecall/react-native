package io.pinecall.call

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.CallAudioState
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/**
 * PinecallCallController — the native call brain (Android analog of the iOS
 * PinecallCallController.swift). Owns both sides of a WhatsApp-style call:
 *
 *  - **Telecom (self-managed ConnectionService)** — registers a
 *    CAPABILITY_SELF_MANAGED PhoneAccount, places outgoing calls and reports
 *    incoming ones, and drives the native audio routing/focus/Bluetooth. The
 *    APP draws the in-call UI (unlike iOS CallKit, which draws the system UI).
 *  - **Native WebRTC (org.webrtc)** — mic capture, audio playout, and the
 *    Pinecall signaling protocol (token → POST /webrtc/offer → answer + an
 *    "events" DataChannel with 1s "ping" keepalive), identical wire protocol
 *    to @pinecall/web's VoiceSession.
 *
 * Singleton because ConnectionService is instantiated by the system and must
 * reach the same call state as the JS bridge.
 */
object PinecallCallController {

    const val PHONE_ACCOUNT_ID = "pinecall-self-managed"

    data class StartOptions(
        val callId: String,
        val callerName: String,
        val handle: String,
        val tokenUrl: String,
        val direction: String, // "outgoing" | "incoming"
    )

    /** state: ringing | connecting | connected | ended | declined | error */
    var onState: ((state: String, reason: String?) -> Unit)? = null
    /** raw JSON strings from the server DataChannel */
    var onServerEvent: ((json: String) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var appContext: Context? = null
    private var telecom: TelecomManager? = null
    private var accountHandle: PhoneAccountHandle? = null

    private var pending: StartOptions? = null
    private var current: StartOptions? = null
    private var connection: PinecallConnection? = null
    private var answered = false

    // WebRTC
    private val eglBase: EglBase by lazy { EglBase.create() }
    private var factory: PeerConnectionFactory? = null
    private var pc: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var dataChannel: DataChannel? = null
    private var pingTimer: java.util.Timer? = null

    // ---- lifecycle -----------------------------------------------------------

    /** True only on API 26+ where self-managed ConnectionService exists. */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    fun init(context: Context) {
        if (appContext != null) return
        appContext = context.applicationContext
        if (!isSupported()) return

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions
                .builder(appContext)
                .createInitializationOptions(),
        )
        val adm = JavaAudioDeviceModule.builder(appContext)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(adm)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()

        registerPhoneAccount()
    }

    private fun registerPhoneAccount() {
        val ctx = appContext ?: return
        val tm = ctx.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
        telecom = tm
        val cn = ComponentName(ctx, PinecallConnectionService::class.java)
        val handle = PhoneAccountHandle(cn, PHONE_ACCOUNT_ID)
        accountHandle = handle
        val account = PhoneAccount.builder(handle, "Pinecall")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .build()
        tm.registerPhoneAccount(account)
    }

    // ---- public API ----------------------------------------------------------

    fun startCall(opts: StartOptions) {
        if (!isSupported()) {
            emitState("error", "Android 8.0+ required for native calls")
            return
        }
        endCurrent("replaced")
        pending = opts
        current = opts
        answered = false

        val tm = telecom ?: return
        val handle = accountHandle ?: return
        val extras = Bundle()

        if (opts.direction == "incoming") {
            extras.putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS,
                Uri.fromParts(PhoneAccount.SCHEME_SIP, opts.handle, null))
            tm.addNewIncomingCall(handle, extras)
        } else {
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
            val uri = Uri.fromParts(PhoneAccount.SCHEME_SIP, opts.handle, null)
            tm.placeCall(uri, Bundle().apply {
                putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, extras)
                @Suppress("DEPRECATION")
                putParcelable(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, extras)
                putParcelable("android.telecom.extra.ADDRESS", uri)
            })
        }
    }

    fun endCall() {
        connection?.let {
            it.setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
            it.destroy()
        }
        endCurrent("ended")
    }

    fun setMuted(muted: Boolean) {
        audioTrack?.setEnabled(!muted)
        sendOnDataChannel("{\"action\":\"${if (muted) "mute" else "unmute"}\"}")
    }

    fun setSpeaker(on: Boolean) {
        connection?.setAudioRoute(
            if (on) CallAudioState.ROUTE_SPEAKER else CallAudioState.ROUTE_EARPIECE,
        )
    }

    /** Consume the pending StartOptions for a callId the service is creating. */
    fun consumePending(): StartOptions? = pending

    // ---- called by PinecallConnection ----------------------------------------

    fun attachConnection(conn: PinecallConnection) {
        connection = conn
        val opts = current ?: return
        if (opts.direction == "outgoing") {
            // Outgoing: the connection is dialing — connect immediately.
            emitState("connecting", null)
            connectWebRTC()
        } else {
            emitState("ringing", null)
        }
    }

    fun onAnswered() {
        answered = true
        emitState("connecting", null)
        connectWebRTC()
    }

    /**
     * The system asked us to present the incoming-call UI (self-managed).
     * The JS layer already renders the in-app ring from the "ringing" state;
     * a production app would also post a full-screen-intent notification here
     * so the call rings on the lock screen. Left as a hook on purpose.
     */
    fun onIncomingUiRequested() {
        // no-op for the example; emitState("ringing") already fired
    }

    fun onEnded(fromUser: Boolean) {
        val declined = !answered && current?.direction == "incoming"
        endCurrent(if (declined) "declined" else "ended")
        emitState(if (declined) "declined" else "ended", if (fromUser) "user" else null)
    }

    // ---- WebRTC (Pinecall protocol) ------------------------------------------

    private fun connectWebRTC() {
        val opts = current ?: return
        io.execute {
            try {
                val tokenRes = getJson(opts.tokenUrl)
                val token = tokenRes.getString("token")
                val server = tokenRes.getString("server")

                val iceServers = mutableListOf(
                    PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                )
                runCatching {
                    val ice = getJson("$server/webrtc/ice-servers").optJSONArray("iceServers")
                    if (ice != null) {
                        iceServers.clear()
                        for (i in 0 until ice.length()) {
                            val e = ice.getJSONObject(i)
                            val urls = e.getJSONArray("urls")
                            val b = PeerConnection.IceServer.builder((0 until urls.length()).map { urls.getString(it) })
                            if (e.has("username")) b.setUsername(e.getString("username"))
                            if (e.has("credential")) b.setPassword(e.getString("credential"))
                            iceServers.add(b.createIceServer())
                        }
                    }
                }

                main.post { buildPeerAndOffer(iceServers, token, server) }
            } catch (e: Exception) {
                emitState("error", e.message)
                endCurrent("error")
            }
        }
    }

    private fun buildPeerAndOffer(iceServers: List<PeerConnection.IceServer>, token: String, server: String) {
        val f = factory ?: return
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }
        val peer = f.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate?) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
            override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
            override fun onAddStream(s: MediaStream?) {}
            override fun onRemoveStream(s: MediaStream?) {}
            override fun onDataChannel(d: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver?, s: Array<out MediaStream>?) {}
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                when (newState) {
                    PeerConnection.PeerConnectionState.CONNECTED -> {
                        connection?.setActive()
                        emitState("connected", null)
                    }
                    PeerConnection.PeerConnectionState.DISCONNECTED,
                    PeerConnection.PeerConnectionState.FAILED -> main.post {
                        if (pc != null) {
                            endCurrent("connection_lost")
                            emitState("ended", "connection_lost")
                        }
                    }
                    else -> {}
                }
            }
        }) ?: run { emitState("error", "failed to create peer connection"); return }
        pc = peer

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }
        val src = f.createAudioSource(audioConstraints)
        audioSource = src
        val track = f.createAudioTrack("audio0", src)
        audioTrack = track
        peer.addTrack(track, listOf("stream0"))

        val dcInit = DataChannel.Init().apply { ordered = true }
        val dc = peer.createDataChannel("events", dcInit)
        dataChannel = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(p: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) startPing()
            }
            override fun onMessage(buffer: DataChannel.Buffer?) {
                if (buffer == null || buffer.binary) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                onServerEvent?.invoke(String(bytes, StandardCharsets.UTF_8))
            }
        })

        val offerConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
        }
        peer.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                peer.setLocalDescription(object : SdpObserver {
                    override fun onSetSuccess() {
                        // Wait ≤2s for ICE gathering, then POST the offer.
                        main.postDelayed({ postOffer(peer, token, server) }, 2000)
                    }
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                    override fun onSetFailure(p0: String?) { fail(p0) }
                }, sdp)
            }
            override fun onSetSuccess() {}
            override fun onCreateFailure(err: String?) { fail(err) }
            override fun onSetFailure(p0: String?) {}
        }, offerConstraints)
    }

    private fun postOffer(peer: PeerConnection, token: String, server: String) {
        val localSdp = peer.localDescription?.description ?: return
        io.execute {
            try {
                val body = JSONObject()
                    .put("sdp", localSdp)
                    .put("type", "offer")
                    .put("token", token)
                val answer = postJson("$server/webrtc/offer", body)
                val answerSdp = answer.getString("sdp")
                main.post {
                    peer.setRemoteDescription(object : SdpObserver {
                        override fun onSetSuccess() {}
                        override fun onCreateSuccess(p0: SessionDescription?) {}
                        override fun onCreateFailure(p0: String?) {}
                        override fun onSetFailure(e: String?) { fail(e) }
                    }, SessionDescription(SessionDescription.Type.ANSWER, answerSdp))
                }
            } catch (e: Exception) {
                fail(e.message)
            }
        }
    }

    private fun startPing() {
        stopPing()
        pingTimer = java.util.Timer().apply {
            scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() { sendOnDataChannel("ping") }
            }, 1000, 1000)
        }
    }

    private fun stopPing() {
        pingTimer?.cancel()
        pingTimer = null
    }

    private fun sendOnDataChannel(text: String) {
        val dc = dataChannel ?: return
        if (dc.state() != DataChannel.State.OPEN) return
        val buf = java.nio.ByteBuffer.wrap(text.toByteArray(StandardCharsets.UTF_8))
        dc.send(DataChannel.Buffer(buf, false))
    }

    private fun fail(message: String?) {
        emitState("error", message)
        endCurrent("error")
    }

    private fun endCurrent(reason: String) {
        stopPing()
        dataChannel?.close(); dataChannel = null
        pc?.close(); pc = null
        audioTrack = null
        audioSource?.dispose(); audioSource = null
        connection = null
        current = null
        pending = null
    }

    private fun emitState(state: String, reason: String?) {
        main.post { onState?.invoke(state, reason) }
    }

    // ---- tiny HTTP+JSON (no extra deps) --------------------------------------

    private fun getJson(url: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000; conn.readTimeout = 8000
        return conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    }

    private fun postJson(url: String, body: JSONObject): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.connectTimeout = 8000; conn.readTimeout = 8000
        conn.outputStream.use { it.write(body.toString().toByteArray(StandardCharsets.UTF_8)) }
        if (conn.responseCode >= 400) throw RuntimeException("HTTP ${conn.responseCode} from $url")
        return conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    }
}
