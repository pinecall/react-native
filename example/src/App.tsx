import { useEffect, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  StyleSheet,
  Pressable,
  StatusBar,
  Platform,
  PermissionsAndroid,
} from 'react-native';
import { CallClient, useCallClient } from '@pinecall/react-native';
import { AGENTS, type AgentContact } from './agents';
import { TOKEN_ENDPOINT } from './config';
import CallScreen from './CallScreen';

// One shared client — non-React code (push/SSE handlers) could use it too.
const client = new CallClient();

export default function App() {
  const call = useCallClient(client);
  const [activeAgent, setActiveAgent] = useState<AgentContact | null>(null);

  // Android needs the mic granted at runtime (MANAGE_OWN_CALLS is a normal
  // permission, auto-granted at install).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    ).catch(() => {});
  }, []);

  function start(agent: AgentContact, direction: 'outgoing' | 'incoming') {
    setActiveAgent(agent);
    call.startCall({
      agentId: agent.id,
      callerName: agent.name,
      handle: agent.tagline,
      tokenUrl: `${TOKEN_ENDPOINT}?agent=${encodeURIComponent(agent.id)}`,
      direction,
    });
  }

  // Show the in-call UI once we're past the native ring.
  const inCall = call.status === 'connecting' || call.status === 'connected';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.head}>
        <Text style={styles.kicker}>PINECALL</Text>
        <Text style={styles.title}>Agents</Text>
        <Text style={styles.subtitle}>Call an AI agent — natively.</Text>
      </View>

      <View style={styles.list}>
        {AGENTS.map((a) => (
          <View key={a.id} style={styles.card}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{a.avatar}</Text>
            </View>
            <View style={styles.cardText}>
              <Text style={styles.cardName}>{a.name}</Text>
              <Text style={styles.cardTag}>{a.tagline}</Text>
            </View>
            {/* Agent calls YOU — native incoming ring */}
            <Pressable
              style={({ pressed }) => [
                styles.action,
                styles.actionRing,
                pressed && styles.pressed,
              ]}
              onPress={() => start(a, 'incoming')}
            >
              <Text style={styles.actionIcon}>🔔</Text>
            </Pressable>
            {/* You call the agent — native outgoing call */}
            <Pressable
              style={({ pressed }) => [
                styles.action,
                styles.actionCall,
                pressed && styles.pressed,
              ]}
              onPress={() => start(a, 'outgoing')}
            >
              <Text style={styles.actionIcon}>📞</Text>
            </Pressable>
          </View>
        ))}
      </View>

      <View style={styles.legend}>
        <Text style={styles.legendText}>
          📞 you call · 🔔 the agent calls you
        </Text>
      </View>

      {call.error ? <Text style={styles.error}>{call.error}</Text> : null}

      {inCall && activeAgent ? (
        <CallScreen agent={activeAgent} call={call} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f6f6f8', paddingHorizontal: 20 },
  head: { paddingTop: 16, paddingBottom: 20 },
  kicker: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    color: '#7856ff',
  },
  title: { fontSize: 36, fontWeight: '800', color: '#0b0b10', marginTop: 4 },
  subtitle: { fontSize: 15, color: '#8a8a8e', marginTop: 4 },
  list: { gap: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#f0eefe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 28 },
  cardText: { flex: 1, marginLeft: 14 },
  cardName: { fontSize: 18, fontWeight: '700', color: '#0b0b10' },
  cardTag: { fontSize: 14, color: '#8a8a8e', marginTop: 2 },
  action: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  actionRing: { backgroundColor: '#fff3e0' },
  actionCall: { backgroundColor: '#e4f8ea' },
  actionIcon: { fontSize: 20 },
  pressed: { opacity: 0.6, transform: [{ scale: 0.94 }] },
  legend: { alignItems: 'center', marginTop: 18 },
  legendText: { fontSize: 13, color: '#a0a0a6' },
  error: { color: '#ff3b30', marginTop: 16, textAlign: 'center' },
});
