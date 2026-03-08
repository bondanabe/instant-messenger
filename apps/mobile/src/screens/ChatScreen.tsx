import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  View,
  Text,
  Image,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native'
import { useRoute, useNavigation } from '@react-navigation/native'
import type { NativeStackRouteProp, NativeStackNavigationProp } from '@react-navigation/native-stack'
import { launchImageLibrary } from 'react-native-image-picker'
import DocumentPicker from 'react-native-document-picker'
import AudioRecorderPlayer from 'react-native-audio-recorder-player'
import { useMessageStore } from '../stores/useMessageStore'
import { useAppStore } from '../stores/useAppStore'
import type { RootStackParamList } from '../../App'
import type { WireMessage } from '@im/core'
import { getConnectionManager } from '../services/cmSingleton'
import { v4 as uuidv4 } from 'uuid'

type Route = NativeStackRouteProp<RootStackParamList, 'Chat'>
type Nav = NativeStackNavigationProp<RootStackParamList, 'Chat'>

// Module-level singleton (one ChatScreen active at a time)
const audioRecorderPlayer = new AudioRecorderPlayer()

// Helper: read a local file URI as base64
async function fileUriToBase64(uri: string): Promise<string> {
  const response = await fetch(uri)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ChatScreen() {
  const route = useRoute<Route>()
  const navigation = useNavigation<Nav>()
  const { conversationId, contactName } = route.params

  const { identity, connectionMode } = useAppStore()
  const { messages, loadMessages, setActiveConversation, markConversationRead, receiveMessage, updateMessageStatus } =
    useMessageStore()

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const flatRef = useRef<FlatList>(null)

  const msgs = messages[conversationId] ?? []

  useEffect(() => {
    navigation.setOptions({
      title: contactName,
      headerRight: () => (
        <View style={{ flexDirection: 'row', gap: 8, marginRight: 8 }}>
          <TouchableOpacity
            onPress={() =>
              navigation.navigate('Call', {
                callId: uuidv4(),
                contactUserId: conversationId,
                contactName,
                callType: 'audio',
                isIncoming: false,
              })
            }
          >
            <Text style={{ fontSize: 20 }}>📞</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              navigation.navigate('Call', {
                callId: uuidv4(),
                contactUserId: conversationId,
                contactName,
                callType: 'video',
                isIncoming: false,
              })
            }
          >
            <Text style={{ fontSize: 20 }}>📹</Text>
          </TouchableOpacity>
        </View>
      ),
    })
    setActiveConversation(conversationId)
    loadMessages(conversationId)
    markConversationRead(conversationId)

    return () => setActiveConversation(null)
  }, [conversationId, contactName, navigation, setActiveConversation, loadMessages, markConversationRead])

  const handleSend = useCallback(async () => {
    if (!text.trim() || !identity) return

    const trimmed = text.trim()
    setText('')
    setSending(true)

    try {
      const now = Date.now()
      const messageId = uuidv4()

      // 1. Buat WireMessage
      const wireMsg: WireMessage = {
        id: messageId,
        conversationId,
        senderId: identity.userId,
        type: 'text',
        content: trimmed,
        createdAt: now,
      }

      // 2. Simpan pesan lokal dulu (optimistic)
      await receiveMessage({
        ...wireMsg,
        // Override: kita pengirim, status pending
      })
      await updateMessageStatus(messageId, 'pending')

      // 3. Kirim via ConnectionManager (E2EE + relay/LAN/BLE)
      const cm = getConnectionManager()
      // targetUserId = conversationId untuk DM (1-on-1)
      const result = await cm.send(conversationId, wireMsg)

      // 4. Update status berdasarkan hasil
      await updateMessageStatus(messageId, result.status)
    } catch (err) {
      console.warn('[chat] Send failed:', err)
    } finally {
      setSending(false)
    }
  }, [text, identity, conversationId, receiveMessage, updateMessageStatus])

  // ── Media helpers ──────────────────────────────────────────────────

  const sendMedia = useCallback(async (
    type: 'image' | 'audio' | 'file',
    dataUri: string,
    mimeType: string,
    fileName?: string,
    sizeBytes?: number,
  ) => {
    if (!identity) return
    const now = Date.now()
    const messageId = uuidv4()

    const content = type === 'file'
      ? JSON.stringify({ uri: dataUri, name: fileName ?? 'file', size: sizeBytes ?? 0 })
      : dataUri

    const wireMsg: WireMessage = {
      id: messageId, conversationId,
      senderId: identity.userId,
      type, content, createdAt: now,
    }

    await receiveMessage({ ...wireMsg })
    await updateMessageStatus(messageId, 'pending')
    const cm = getConnectionManager()
    const result = await cm.send(conversationId, wireMsg)
    await updateMessageStatus(messageId, result.status)
  }, [identity, conversationId, receiveMessage, updateMessageStatus])

  const handlePickImage = useCallback(async () => {
    setShowAttachMenu(false)
    const result = await launchImageLibrary({
      mediaType: 'photo',
      includeBase64: true,
      maxWidth: 1200,
      maxHeight: 1200,
      quality: 0.8,
    })
    const asset = result.assets?.[0]
    if (!asset?.base64) return
    const mimeType = asset.type ?? 'image/jpeg'
    await sendMedia('image', `data:${mimeType};base64,${asset.base64}`, mimeType)
  }, [sendMedia])

  const handlePickDocument = useCallback(async () => {
    setShowAttachMenu(false)
    try {
      const doc = await DocumentPicker.pickSingle({
        type: [DocumentPicker.types.allFiles],
        copyTo: 'cachesDirectory',
      })
      const uri = doc.fileCopyUri ?? doc.uri
      const MAX_BYTES = 5 * 1024 * 1024
      if (doc.size && doc.size > MAX_BYTES) {
        console.warn('[chat] Document too large')
        return
      }
      const base64 = await fileUriToBase64(uri)
      const mimeType = doc.type ?? 'application/octet-stream'
      await sendMedia(
        'file',
        `data:${mimeType};base64,${base64}`,
        mimeType,
        doc.name ?? 'file',
        doc.size ?? 0,
      )
    } catch (e) {
      if (DocumentPicker.isCancel(e)) return
      console.warn('[chat] Document pick error:', e)
    }
  }, [sendMedia])

  const handleVoiceToggle = useCallback(async () => {
    if (isRecording) {
      // Stop & send
      const path = await audioRecorderPlayer.stopRecorder()
      audioRecorderPlayer.removeRecordBackListener()
      if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
      setIsRecording(false)
      setRecordingSeconds(0)
      try {
        const base64 = await fileUriToBase64(`file://${path}`)
        await sendMedia('audio', `data:audio/mpeg;base64,${base64}`, 'audio/mpeg')
      } catch (err) {
        console.warn('[chat] Failed to read audio:', err)
      }
    } else {
      // Start recording
      await audioRecorderPlayer.startRecorder()
      setIsRecording(true)
      setRecordingSeconds(0)
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000)
    }
  }, [isRecording, sendMedia])

  const renderMessage = ({ item }: { item: (typeof msgs)[0] }) => {
    const isOwn = item.senderId === identity?.userId

    const renderContent = () => {
      if (item.isDeleted) {
        return <Text style={styles.deletedText}>Pesan dihapus</Text>
      }
      if (item.type === 'image') {
        return (
          <Image
            source={{ uri: item.content ?? '' }}
            style={styles.mediaImage}
            resizeMode="cover"
          />
        )
      }
      if (item.type === 'audio') {
        return (
          <View style={styles.audioBubble}>
            <Text style={styles.audioIcon}>🎵</Text>
            <Text style={[styles.bubbleText, isOwn ? styles.textOwn : styles.textOther]}>
              Audio ({item.content?.length ? `${Math.round(item.content.length * 0.75 / 1024)} KB` : '?'})
            </Text>
          </View>
        )
      }
      if (item.type === 'file') {
        let name = 'Attachment'; let size = 0
        try { const m = JSON.parse(item.content ?? '{}') as { name: string; size: number }; name = m.name; size = m.size } catch {}
        return (
          <View style={styles.fileBubble}>
            <Text style={{ fontSize: 24 }}>📎</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.bubbleText, isOwn ? styles.textOwn : styles.textOther]} numberOfLines={2}>{name}</Text>
              {size > 0 && <Text style={styles.fileSizeText}>{formatBytes(size)}</Text>}
            </View>
          </View>
        )
      }
      return (
        <Text style={[styles.bubbleText, isOwn ? styles.textOwn : styles.textOther]}>
          {item.content}
        </Text>
      )
    }

    return (
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {renderContent()}
        <View style={styles.bubbleMeta}>
          <Text style={styles.timeText}>{formatTime(item.createdAt)}</Text>
          {isOwn && <Text style={styles.statusText}>{statusIcon(item.status)}</Text>}
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={88}
    >
      {/* Connection mode indicator */}
      {connectionMode !== 'internet' && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>
            {connectionMode === 'offline'
              ? '⏳ Offline — pesan akan dikirim saat ada koneksi'
              : `📡 ${connectionMode.toUpperCase()} mode`}
          </Text>
        </View>
      )}

      <FlatList
        ref={flatRef}
        data={msgs}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        inverted
        contentContainerStyle={styles.list}
        onEndReached={() => {
          /* TODO: load more messages */
        }}
      />

      {/* Input Bar */}
      <View style={styles.inputBar}>
        <TouchableOpacity
          style={styles.attachBtn}
          onPress={() => setShowAttachMenu(true)}
        >
          <Text style={styles.attachIcon}>📎</Text>
        </TouchableOpacity>

        <TextInput
          style={styles.input}
          placeholder="Tulis pesan..."
          placeholderTextColor="#999"
          value={text}
          onChangeText={setText}
          multiline
          maxLength={4000}
        />

        {text.trim() ? (
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!text.trim() || sending}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.sendIcon}>➤</Text>
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, { backgroundColor: isRecording ? '#e53e3e' : '#128C7E' }]}
            onPress={handleVoiceToggle}
          >
            <Text style={styles.sendIcon}>{isRecording ? '⏹' : '🎤'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Recording indicator */}
      {isRecording && (
        <View style={styles.recordingBar}>
          <Text style={styles.recordingText}>● Merekam... {recordingSeconds}s</Text>
          <Text style={styles.recordingHint}>Ketuk ⏹ untuk kirim</Text>
        </View>
      )}

      {/* Attachment menu modal */}
      <Modal
        transparent
        visible={showAttachMenu}
        animationType="fade"
        onRequestClose={() => setShowAttachMenu(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowAttachMenu(false)}>
          <View style={styles.attachMenuBox}>
            <TouchableOpacity style={styles.attachMenuItem} onPress={handlePickImage}>
              <Text style={styles.attachMenuIcon}>🖼️</Text>
              <Text style={styles.attachMenuText}>Foto / Galeri</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachMenuItem} onPress={handlePickDocument}>
              <Text style={styles.attachMenuIcon}>📄</Text>
              <Text style={styles.attachMenuText}>Dokumen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.attachMenuItem, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#eee', marginTop: 4, paddingTop: 12 }]}
              onPress={() => setShowAttachMenu(false)}
            >
              <Text style={[styles.attachMenuText, { color: '#e53e3e', textAlign: 'center' }]}>Batal</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  )
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
}

function statusIcon(status: string): string {
  switch (status) {
    case 'pending': return '⏳'
    case 'sent': return '✓'
    case 'delivered': return '✓✓'
    case 'read': return '✓✓'
    case 'failed': return '✗'
    default: return ''
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ECE5DD' },
  offlineBanner: {
    backgroundColor: '#FFF3CD',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#FFEAA7',
  },
  offlineBannerText: { color: '#856404', fontSize: 12, textAlign: 'center' },
  list: { paddingHorizontal: 12, paddingVertical: 8 },
  bubble: {
    maxWidth: '78%',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginVertical: 2,
  },
  bubbleOwn: {
    alignSelf: 'flex-end',
    backgroundColor: '#DCF8C6',
    borderBottomRightRadius: 2,
  },
  bubbleOther: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderBottomLeftRadius: 2,
  },
  bubbleText: { fontSize: 16, lineHeight: 22 },
  textOwn: { color: '#111' },
  textOther: { color: '#111' },
  deletedText: { color: '#999', fontStyle: 'italic', fontSize: 14 },
  bubbleMeta: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4, gap: 4 },
  timeText: { fontSize: 11, color: '#666' },
  statusText: { fontSize: 11, color: '#666' },
  // Media bubbles
  mediaImage: { width: 220, height: 180, borderRadius: 8 },
  audioBubble: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 140 },
  audioIcon: { fontSize: 22 },
  fileBubble: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 160 },
  fileSizeText: { fontSize: 12, color: '#666', marginTop: 1 },
  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#f2f2f2',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ddd',
    gap: 8,
  },
  attachBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#fff',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    justifyContent: 'center',
    alignItems: 'center',
  },
  attachIcon: { fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 120,
    color: '#111',
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#25D366',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#ccc' },
  sendIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  // Recording indicator
  recordingBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff0f0',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#ffcdd2',
  },
  recordingText: { color: '#e53e3e', fontSize: 13, fontWeight: '600' },
  recordingHint: { color: '#666', fontSize: 12 },
  // Attach menu modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  attachMenuBox: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
  },
  attachMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 14,
  },
  attachMenuIcon: { fontSize: 26, width: 36, textAlign: 'center' },
  attachMenuText: { fontSize: 16, color: '#111' },
})
