import React, { useEffect, useState } from 'react'
import { HomeScreen } from './screens/HomeScreen'
import { ChatScreen } from './screens/ChatScreen'
import { SetupScreen } from './screens/SetupScreen'
import { AddContactScreen } from './screens/AddContactScreen'
import { ProfileScreen } from './screens/ProfileScreen'
import { ContactListScreen } from './screens/ContactListScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { CallScreen } from './screens/CallScreen'

export type Screen =
  | { name: 'Setup' }
  | { name: 'Home' }
  | { name: 'Chat'; conversationId: string; contactName: string }
  | { name: 'AddContact' }
  | { name: 'Profile' }
  | { name: 'Contacts' }
  | { name: 'Settings' }
  | {
      name: 'Call'
      callId: string
      contactUserId: string
      contactName: string
      callType: 'audio' | 'video'
      isIncoming: boolean
      sdpOffer?: string
    }

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'Setup' })
  const [isReady, setIsReady] = useState(false)
  const [connectionMode, setConnectionMode] = useState<string>('offline')
  const [updateInfo, setUpdateInfo] = useState<{ version: string; downloaded: boolean } | null>(null)

  useEffect(() => {
    // Cek apakah identitas sudah ada
    window.electronAPI.getIdentity().then((identity) => {
      setScreen(identity ? { name: 'Home' } : { name: 'Setup' })
      setIsReady(true)

      // Jika identity sudah ada, ambil mode koneksi saat ini
      if (identity) {
        window.electronAPI.getConnectionMode().then((mode) => setConnectionMode(mode))
      }
    })

    // Monitor perubahan mode koneksi dari main process
    const unsubMode = window.electronAPI.onConnectionModeChange((mode) => {
      setConnectionMode(mode)
    })

    // Monitor pesan masuk dari main process
    const unsubMsg = window.electronAPI.onIncomingMessage((data) => {
      const { message, fromUserId } = data as { message: unknown; fromUserId: string }
      console.log('[app] Incoming message from', fromUserId, message)
    })

    // Panggilan masuk (offer dari peer lain)
    const unsubCall = window.electronAPI.onCallSignal((raw) => {
      const payload = raw as {
        type: string
        callId: string
        fromUserId: string
        callType?: string
        sdp?: string
      }
      if (payload.type === 'offer') {
        setScreen({
          name: 'Call',
          callId: payload.callId,
          contactUserId: payload.fromUserId,
          contactName: payload.fromUserId,
          callType: (payload.callType ?? 'audio') as 'audio' | 'video',
          isIncoming: true,
          ...(payload.sdp !== undefined ? { sdpOffer: payload.sdp } : {}),
        })
      }
    })

    return () => {
      unsubMode()
      unsubMsg()
      unsubCall()
    }
  }, [])

  // Auto-updater listeners
  useEffect(() => {
    const unsubAvail = window.electronAPI.onUpdateAvailable?.((info) => {
      setUpdateInfo({ version: info.version, downloaded: false })
    })
    const unsubDl = window.electronAPI.onUpdateDownloaded?.((info) => {
      setUpdateInfo({ version: info.version, downloaded: true })
    })
    return () => {
      unsubAvail?.()
      unsubDl?.()
    }
  }, [])

  if (!isReady) {
    return (
      <div style={styles.loading}>
        <div style={styles.loadingText}>Memuat...</div>
      </div>
    )
  }

  return (
    <div style={styles.app}>
      {/* Update banner */}
      {updateInfo && (
        <div style={styles.updateBanner}>
          <span>
            {updateInfo.downloaded
              ? `✅ Versi ${updateInfo.version} siap diinstall`
              : `⬇️ Mengunduh versi ${updateInfo.version}...`}
          </span>
          {updateInfo.downloaded && (
            <button
              style={styles.updateBtn}
              onClick={() => window.electronAPI.restartToUpdate?.()}
            >
              Restart & Update
            </button>
          )}
          <button style={styles.updateClose} onClick={() => setUpdateInfo(null)}>✕</button>
        </div>
      )}
      {screen.name === 'Setup' && (
        <SetupScreen onComplete={() => setScreen({ name: 'Home' })} />
      )}
      {screen.name === 'Home' && (
        <HomeScreen
          connectionMode={connectionMode}
          onOpenChat={(conversationId, contactName) =>
            setScreen({ name: 'Chat', conversationId, contactName })
          }
          onAddContact={() => setScreen({ name: 'AddContact' })}
          onOpenProfile={() => setScreen({ name: 'Profile' })}
          onOpenContacts={() => setScreen({ name: 'Contacts' })}
          onOpenSettings={() => setScreen({ name: 'Settings' })}
        />
      )}
      {screen.name === 'Chat' && (
        <ChatScreen
          conversationId={screen.conversationId}
          contactName={screen.contactName}
          connectionMode={connectionMode}
          onBack={() => setScreen({ name: 'Home' })}
          onStartAudioCall={(callId) =>
            setScreen({
              name: 'Call',
              callId,
              contactUserId: screen.conversationId,
              contactName: screen.contactName,
              callType: 'audio',
              isIncoming: false,
            })
          }
          onStartVideoCall={(callId) =>
            setScreen({
              name: 'Call',
              callId,
              contactUserId: screen.conversationId,
              contactName: screen.contactName,
              callType: 'video',
              isIncoming: false,
            })
          }
        />
      )}
      {screen.name === 'Call' && (
        <CallScreen
          callId={screen.callId}
          contactUserId={screen.contactUserId}
          contactName={screen.contactName}
          callType={screen.callType}
          isIncoming={screen.isIncoming}
          {...(screen.sdpOffer !== undefined ? { sdpOffer: screen.sdpOffer } : {})}
          onEnd={() => setScreen({ name: 'Home' })}
        />
      )}
      {screen.name === 'AddContact' && (
        <AddContactScreen
          onBack={() => setScreen({ name: 'Home' })}
          onContactAdded={() => setScreen({ name: 'Home' })}
        />
      )}
      {screen.name === 'Profile' && (
        <ProfileScreen onBack={() => setScreen({ name: 'Home' })} />
      )}
      {screen.name === 'Contacts' && (
        <ContactListScreen
          onBack={() => setScreen({ name: 'Home' })}
          onStartChat={(contactUserId, contactName) =>
            setScreen({ name: 'Chat', conversationId: contactUserId, contactName })
          }
        />
      )}
      {screen.name === 'Settings' && (
        <SettingsScreen onBack={() => setScreen({ name: 'Home' })} />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100vh',
    backgroundColor: '#075E54',
  },
  loadingText: { color: '#fff', fontSize: 18 },
  updateBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 16px',
    background: '#1a73e8',
    color: '#fff',
    fontSize: 13,
    zIndex: 1000,
    flexShrink: 0,
  },
  updateBtn: {
    marginLeft: 8,
    padding: '4px 12px',
    background: '#fff',
    color: '#1a73e8',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 12,
  },
  updateClose: {
    marginLeft: 'auto',
    background: 'none',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  },
}

// Type augmentation untuk window.electronAPI
declare global {
  interface Window {
    electronAPI: {
      getIdentity: () => Promise<unknown>
      createIdentity: (data: unknown) => Promise<void>
      listContacts: () => Promise<unknown[]>
      addContact: (contact: unknown) => Promise<void>
      listConversations: () => Promise<unknown[]>
      markConversationRead: (id: string) => Promise<void>
      listMessages: (params: unknown) => Promise<unknown[]>
      saveMessage: (msg: unknown) => Promise<void>
      updateMessageStatus: (params: unknown) => Promise<void>
      addToOutbox: (params: unknown) => Promise<void>
      getPendingOutbox: () => Promise<unknown[]>
      removeFromOutbox: (id: string) => Promise<void>
      notify: (params: { title: string; body: string }) => Promise<void>
      onIncomingMessage: (cb: (data: unknown) => void) => () => void
      onConnectionModeChange: (cb: (mode: string) => void) => () => void
      onTyping: (cb: (data: { fromUserId: string; isTyping: boolean }) => void) => () => void
      onReadReceipt: (cb: (data: { fromUserId: string; messageId: string }) => void) => () => void
      startCM: (opts?: { relayUrl?: string }) => Promise<{ ok: boolean; error?: string }>
      sendMessage: (params: { targetUserId: string; message: unknown }) => Promise<unknown>
      sendTyping: (params: { targetUserId: string; isTyping: boolean }) => Promise<void>
      sendReadReceipt: (params: { targetUserId: string; messageId: string }) => Promise<void>
      checkOnline: (userId: string) => Promise<boolean>
      getConnectionMode: () => Promise<string>
      // Phase 5
      deleteMessage: (messageId: string) => Promise<void>
      updateIdentityName: (displayName: string) => Promise<void>
      getStoredRelayUrl: () => Promise<string>
      updateRelayUrl: (relayUrl: string) => Promise<{ ok: boolean }>
      // Phase 6
      openFileDialog: () => Promise<{
        dataUri: string; mimeType: string
        type: 'image' | 'audio' | 'file'
        name: string; sizeBytes: number
      } | { error: string } | null>
      sendCallSignal: (payload: {
        callId: string; toUserId: string; type: string
        callType?: string; sdp?: string; candidate?: unknown
      }) => Promise<void>
      onCallSignal: (cb: (data: unknown) => void) => () => void
      // Phase 7 — Auto-updater
      onUpdateAvailable?: (cb: (info: { version: string }) => void) => () => void
      onUpdateDownloaded?: (cb: (info: { version: string }) => void) => () => void
      restartToUpdate?: () => Promise<void>
    }
  }
}
