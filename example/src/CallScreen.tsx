import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import type { UseCallResult } from '@pinecall/react-native';
import type { AgentContact } from './agents';

function fmt(s: number): string {
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

const STATUS_LABEL: Record<string, string> = {
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Call failed',
};

/**
 * Example in-call UI — 100% custom, built from the headless CallClient state.
 * A soft ring pulses while the agent speaks; the transcript streams below.
 */
export default function CallScreen({
  agent,
  call,
}: {
  agent: AgentContact;
  call: UseCallResult;
}) {
  const connected = call.status === 'connected';
  const speaking = call.phase === 'speaking';
  const statusLine = connected ? fmt(call.duration) : STATUS_LABEL[call.status] ?? '';

  // Pulse the halo while the agent is speaking.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!speaking) {
      pulse.stopAnimation();
      Animated.timing(pulse, { toValue: 0, duration: 250, useNativeDriver: true }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [speaking, pulse]);

  const haloStyle = {
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
  };

  return (
    <View style={styles.overlay}>
      {/* ambient glows */}
      <View style={[styles.glow, styles.glowTop]} />
      <View style={[styles.glow, styles.glowBottom]} />

      <View style={styles.header}>
        <View style={styles.avatarWrap}>
          <Animated.View style={[styles.halo, haloStyle]} />
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{agent.avatar}</Text>
          </View>
        </View>
        <Text style={styles.name}>{agent.name}</Text>
        <View style={styles.statusPill}>
          <View style={[styles.dot, connected && styles.dotLive]} />
          <Text style={styles.status}>{statusLine}</Text>
        </View>
      </View>

      <View style={styles.transcript}>
        {call.messages.slice(-6).map((m) => (
          <View
            key={m.id}
            style={[styles.bubble, m.role === 'bot' ? styles.bubbleBot : styles.bubbleUser]}
          >
            <Text style={m.role === 'bot' ? styles.bubbleBotText : styles.bubbleUserText}>
              {m.text}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <CircleButton
          icon="🔊"
          active={call.isSpeaker}
          disabled={!connected}
          onPress={call.toggleSpeaker}
        />
        <CircleButton
          icon={call.isMuted ? '🔇' : '🎙'}
          active={call.isMuted}
          disabled={!connected}
          onPress={call.toggleMute}
        />
        <CircleButton icon="📞" hangup onPress={() => call.endCall()} />
      </View>
    </View>
  );
}

function CircleButton({
  icon,
  active,
  hangup,
  disabled,
  onPress,
}: {
  icon: string;
  active?: boolean;
  hangup?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        active && styles.btnActive,
        hangup && styles.btnHangup,
        disabled && styles.btnDisabled,
        pressed && styles.btnPressed,
      ]}
    >
      <Text style={[styles.btnIcon, hangup && styles.btnIconHangup]}>{icon}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0b0b10',
    alignItems: 'center',
    paddingTop: 92,
    paddingBottom: 56,
    overflow: 'hidden',
  },
  glow: { position: 'absolute', width: 460, height: 460, borderRadius: 230 },
  glowTop: { top: -180, backgroundColor: 'rgba(120,86,255,0.22)' },
  glowBottom: { bottom: -220, backgroundColor: 'rgba(52,199,89,0.14)' },
  header: { alignItems: 'center' },
  avatarWrap: { alignItems: 'center', justifyContent: 'center', width: 160, height: 160 },
  halo: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#34c759',
  },
  avatar: {
    width: 132,
    height: 132,
    borderRadius: 66,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 62 },
  name: { color: '#fff', fontSize: 30, fontWeight: '700', marginTop: 22, letterSpacing: 0.2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.5)', marginRight: 8 },
  dotLive: { backgroundColor: '#34c759' },
  status: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontVariant: ['tabular-nums'] },
  transcript: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
    paddingHorizontal: 22,
    gap: 8,
    marginBottom: 12,
  },
  bubble: { paddingVertical: 11, paddingHorizontal: 15, borderRadius: 20, maxWidth: '82%' },
  bubbleBot: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderBottomLeftRadius: 6,
  },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#2f6bff', borderBottomRightRadius: 6 },
  bubbleBotText: { color: '#f2f2f7', fontSize: 15, lineHeight: 20 },
  bubbleUserText: { color: '#fff', fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: 28 },
  btn: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnActive: { backgroundColor: '#fff', borderColor: '#fff' },
  btnDisabled: { opacity: 0.35 },
  btnPressed: { transform: [{ scale: 0.92 }] },
  btnHangup: { backgroundColor: '#ff3b30', borderColor: '#ff3b30' },
  btnIcon: { fontSize: 27 },
  btnIconHangup: { transform: [{ rotate: '135deg' }] },
});
