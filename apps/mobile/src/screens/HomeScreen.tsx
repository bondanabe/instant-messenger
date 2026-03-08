import React, { useEffect, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
  TextInput,
} from 'react-native'
import { useNavigation } from '@react-navigation/native'
import { useMessageStore } from '../stores/useMessageStore'
import { useAppStore } from '../stores/useAppStore'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Home'>

export function HomeScreen() {
  const navigation = useNavigation<Nav>()
  const { conversations, loadConversations } = useMessageStore()
  const { identity, connectionMode } = useAppStore()
  const [search, setSearch] = useState('')

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const filtered = conversations.filter((c) =>
    c.name?.toLowerCase().includes(search.toLowerCase()),
  )

  const connectionColor =
    connectionMode === 'internet'
      ? '#25D366'
      : connectionMode === 'lan' || connectionMode === 'wifi_direct'
        ? '#FFA500'
        : connectionMode === 'bluetooth'
          ? '#007AFF'
          : '#999'

  const connectionLabel =
    connectionMode === 'internet'
      ? 'Online'
      : connectionMode === 'lan'
        ? 'LAN'
        : connectionMode === 'wifi_direct'
          ? 'WiFi Direct'
          : connectionMode === 'bluetooth'
            ? 'Bluetooth'
            : 'Offline'

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#075E54" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Messenger</Text>
        <View style={[styles.connectionBadge, { backgroundColor: connectionColor }]}>
          <Text style={styles.connectionText}>{connectionLabel}</Text>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Cari percakapan..."
          placeholderTextColor="#999"
          value={search}
          onChangeText={setSearch}
        />
      </View>

      {/* Conversation List */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.convItem}
            onPress={() =>
              navigation.navigate('Chat', {
                conversationId: item.id,
                contactName: item.name ?? 'Unknown',
              })
            }
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(item.name ?? '?').charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.convInfo}>
              <View style={styles.convHeader}>
                <Text style={styles.convName} numberOfLines={1}>
                  {item.name ?? 'Unknown'}
                </Text>
                {item.lastMsgAt && (
                  <Text style={styles.convTime}>
                    {formatTime(item.lastMsgAt)}
                  </Text>
                )}
              </View>
              <View style={styles.convMeta}>
                <Text style={styles.convPreview} numberOfLines={1}>
                  {item.lastMsgPreview ?? 'Tidak ada pesan'}
                </Text>
                {item.unreadCount > 0 && (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadText}>{item.unreadCount}</Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Belum ada percakapan</Text>
            <Text style={styles.emptySubText}>
              Tambahkan kontak via QR Code untuk mulai chat
            </Text>
          </View>
        }
      />

      {/* FAB - New Chat */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('NewChat')}
      >
        <Text style={styles.fabIcon}>💬</Text>
      </TouchableOpacity>
    </View>
  )
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    backgroundColor: '#075E54',
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  connectionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  connectionText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  searchContainer: {
    margin: 8,
    backgroundColor: '#f2f2f2',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  searchInput: { height: 40, color: '#333', fontSize: 15 },
  convItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#075E54',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '600' },
  convInfo: { flex: 1 },
  convHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  convName: { fontSize: 16, fontWeight: '600', color: '#111', flex: 1 },
  convTime: { fontSize: 12, color: '#999', marginLeft: 8 },
  convMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  convPreview: { fontSize: 14, color: '#666', flex: 1 },
  unreadBadge: {
    backgroundColor: '#25D366',
    borderRadius: 10,
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { alignItems: 'center', marginTop: 80, paddingHorizontal: 32 },
  emptyText: { fontSize: 18, fontWeight: '600', color: '#333', marginBottom: 8 },
  emptySubText: { fontSize: 14, color: '#999', textAlign: 'center' },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabIcon: { fontSize: 24 },
})
