import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, SafeAreaView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { createSmartRetry, type QueuedRequest } from 'react-native-smart-retry';
import { installMockApi, MOCK_API_BASE_URL } from '../api/mockApi';

// A dedicated instance (rather than the default singleton) keeps the example
// self-contained and easy to copy into a host app.
const SmartRetry = createSmartRetry();
const mockApi = installMockApi();

let employeeCounter = 1;

export default function QueueDemoScreen(): React.JSX.Element {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [isApiOffline, setIsApiOffline] = useState(false);
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [lastMessage, setLastMessage] = useState('');

  const refreshQueue = useCallback(async () => {
    const items = await SmartRetry.getQueue();
    setQueue(items.sort((a, b) => a.createdAt - b.createdAt));
  }, []);

  useEffect(() => {
    SmartRetry.configure({
      debug: true,
      onQueued: () => {
        setLastMessage('Request queued (offline or unreachable)');
        void refreshQueue();
      },
      onSuccess: () => {
        setLastMessage('Queued request synced successfully');
        void refreshQueue();
      },
      onFailure: (_request, error) => {
        setLastMessage(`Request failed permanently: ${error.message}`);
        void refreshQueue();
      },
      onRetry: (info) => {
        setLastMessage(`Retrying ${info.requestId} (attempt ${info.attempt}/${info.maxRetries})`);
      },
      onNetworkChange: (state) => {
        setIsOnline(state.isConnected && state.isInternetReachable !== false);
      },
      onQueueComplete: () => {
        void refreshQueue();
      },
    });

    SmartRetry.initialize()
      .then(async () => {
        setIsOnline(await SmartRetry.isOnline());
        await refreshQueue();
      })
      .catch((error: unknown) => {
        Alert.alert('Failed to initialize SmartRetry', String(error));
      });

    return () => {
      SmartRetry.destroy();
    };
  }, [refreshQueue]);

  const createRequest = useCallback(async () => {
    const employeeId = employeeCounter++;
    const result = await SmartRetry.request({
      url: `${MOCK_API_BASE_URL}/attendance`,
      method: 'POST',
      data: { employeeId, timestamp: Date.now() },
      queue: true,
      uniqueKey: `attendance-${employeeId}`,
    });

    if (result.status === 'success') {
      setLastMessage(`Request ${employeeId} succeeded immediately`);
    } else if (result.status === 'queued') {
      setLastMessage(`Request ${employeeId} queued as ${result.queueId}`);
    } else {
      setLastMessage(`Request ${employeeId} failed: ${result.error.message}`);
    }

    await refreshQueue();
  }, [refreshQueue]);

  const toggleSimulatedOffline = useCallback((value: boolean) => {
    setIsApiOffline(value);
    mockApi.setForcedOffline(value);
  }, []);

  const processQueue = useCallback(async () => {
    await SmartRetry.processQueue();
    await refreshQueue();
  }, [refreshQueue]);

  const clearQueue = useCallback(async () => {
    await SmartRetry.clearQueue();
    await refreshQueue();
  }, [refreshQueue]);

  const networkLabel = useMemo(() => {
    if (isOnline === null) {
      return 'CHECKING…';
    }
    return isOnline ? 'ONLINE' : 'OFFLINE';
  }, [isOnline]);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>react-native-smart-retry</Text>

      <View style={styles.card}>
        <Row label="Device network" value={networkLabel} />
        <Row label="Queue count" value={String(queue.length)} />
        <View style={styles.row}>
          <Text style={styles.label}>Simulate API offline</Text>
          <Switch value={isApiOffline} onValueChange={toggleSimulatedOffline} />
        </View>
      </View>

      {lastMessage ? <Text style={styles.message}>{lastMessage}</Text> : null}

      <View style={styles.buttonRow}>
        <Button label="Create API Request" onPress={createRequest} />
        <Button label="Process Queue" onPress={processQueue} />
      </View>
      <View style={styles.buttonRow}>
        <Button label="Refresh" onPress={refreshQueue} />
        <Button label="Clear Queue" onPress={clearQueue} destructive />
      </View>

      <Text style={styles.subtitle}>Queued requests</Text>
      <FlatList
        data={queue}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.empty}>Queue is empty</Text>}
        renderItem={({ item }) => (
          <View style={styles.queueItem}>
            <Text style={styles.queueItemTitle}>
              {item.method} {item.url.replace(MOCK_API_BASE_URL, '')}
            </Text>
            <Text style={styles.queueItemMeta}>id: {item.id}</Text>
            <Text style={styles.queueItemMeta}>status: {item.status}</Text>
            <Text style={styles.queueItemMeta}>created: {new Date(item.createdAt).toLocaleTimeString()}</Text>
            <Text style={styles.queueItemMeta}>retryCount: {item.retryCount}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  destructive,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.button, destructive && styles.buttonDestructive]}
      onPress={() => {
        onPress();
      }}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0f14', paddingHorizontal: 16, paddingTop: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  subtitle: { color: '#9fb0c0', fontSize: 14, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  card: { backgroundColor: '#141b22', borderRadius: 12, padding: 14, marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  label: { color: '#9fb0c0', fontSize: 14 },
  value: { color: '#fff', fontSize: 14, fontWeight: '600' },
  message: { color: '#f6c453', fontSize: 13, marginBottom: 8 },
  buttonRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  button: { flex: 1, backgroundColor: '#2b6cf6', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  buttonDestructive: { backgroundColor: '#8a2b2b' },
  buttonText: { color: '#fff', fontWeight: '600' },
  listContent: { paddingBottom: 32 },
  empty: { color: '#5c6b78', fontStyle: 'italic' },
  queueItem: { backgroundColor: '#141b22', borderRadius: 10, padding: 12, marginBottom: 8 },
  queueItemTitle: { color: '#fff', fontWeight: '600', marginBottom: 4 },
  queueItemMeta: { color: '#9fb0c0', fontSize: 12 },
});
