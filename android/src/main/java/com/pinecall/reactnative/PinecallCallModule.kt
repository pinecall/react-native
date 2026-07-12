package com.pinecall.reactnative

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import io.pinecall.call.PinecallCallController

/**
 * React Native bridge for the native call stack (Android). Thin — all logic
 * lives in the shared io.pinecall.call.PinecallCallController. Legacy module
 * with a JS event emitter (mirrors the iOS RCTEventEmitter); works under the
 * New Architecture via RN's interop layer.
 */
class PinecallCallModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "PinecallCall"

    init {
        PinecallCallController.init(reactContext)
        PinecallCallController.onState = { state, reason ->
            val body = Arguments.createMap()
            body.putString("state", state)
            if (reason != null) body.putString("reason", reason)
            emit("state", body)
        }
        PinecallCallController.onServerEvent = { json ->
            val body = Arguments.createMap()
            body.putString("data", json)
            emit("serverEvent", body)
        }
    }

    private fun emit(event: String, body: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, body)
    }

    @ReactMethod
    fun isNativeCallSupported(promise: Promise) {
        val res = Arguments.createMap()
        res.putBoolean("supported", PinecallCallController.isSupported())
        promise.resolve(res)
    }

    @ReactMethod
    fun startCall(options: ReadableMap, promise: Promise) {
        val callId = options.getString("callId")
        val callerName = options.getString("callerName")
        val tokenUrl = options.getString("tokenUrl")
        if (callId == null || callerName == null || tokenUrl == null) {
            promise.reject("bad_args", "callId, callerName and tokenUrl are required")
            return
        }
        PinecallCallController.startCall(
            PinecallCallController.StartOptions(
                callId = callId,
                callerName = callerName,
                handle = options.getString("handle") ?: callerName,
                tokenUrl = tokenUrl,
                direction = options.getString("direction") ?: "outgoing",
            ),
        )
        promise.resolve(null)
    }

    @ReactMethod
    fun endCall(promise: Promise) {
        PinecallCallController.endCall()
        promise.resolve(null)
    }

    @ReactMethod
    fun setMuted(muted: Boolean, promise: Promise) {
        PinecallCallController.setMuted(muted)
        promise.resolve(null)
    }

    @ReactMethod
    fun setSpeaker(on: Boolean, promise: Promise) {
        PinecallCallController.setSpeaker(on)
        promise.resolve(null)
    }

    // Required so JS NativeEventEmitter doesn't warn on Android.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}
