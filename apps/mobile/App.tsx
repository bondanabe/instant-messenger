import React, { useEffect } from 'react'
import { AppState } from 'react-native'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { HomeScreen } from './src/screens/HomeScreen'
import { ChatScreen } from './src/screens/ChatScreen'
import { SetupScreen } from './src/screens/SetupScreen'
import { CallScreen } from './src/screens/CallScreen'
import { useAppStore } from './src/stores/useAppStore'
import { useMessageStore } from './src/stores/useMessageStore'
import { initDatabase } from './src/db'
import { startConnectionManager, stopConnectionManager } from './src/services/cmSingleton'
import notifee, { AndroidImportance, EventType } from '@notifee/react-native'

export type RootStackParamList = {
  Setup: undefined
  Home: undefined
  Chat: { conversationId: string; contactName: string }
  NewChat: undefined
  Call: {
    callId: string
    contactUserId: string
    contactName: string
    callType: 'audio' | 'video'
    isIncoming: boolean
    sdpOffer?: string
  }
}

export const navigationRef = createNavigationContainerRef<RootStackParamList>()

const Stack = createNativeStackNavigator<RootStackParamList>()

// ─────────────────────────────────────────────────────────────────
// NOTIFIKASI LOKAL
// ─────────────────────────────────────────────────────────────────

async function createNotificationChannels(): Promise<void> {
  await notifee.createChannel({
    id: 'messages',
    name: 'Pesan',
    importance: AndroidImportance.HIGH,
  })
  await notifee.createChannel({
    id: 'calls',
    name: 'Panggilan Masuk',
    importance: AndroidImportance.HIGH,
    vibration: true,
  })
}

async function showMessageNotification(senderName: string, preview: string): Promise<void> {
  await notifee.displayNotification({
    title: senderName,
    body: preview.length > 50 ? preview.slice(0, 50) + '…' : preview,
    android: {
      channelId: 'messages',
      pressAction: { id: 'default' },
      smallIcon: 'ic_launcher',
    },
    ios: { sound: 'default' },
  })
}

async function showCallNotification(callerName: string, callId: string): Promise<void> {
  await notifee.displayNotification({
    id: `call-${callId}`,
    title: `📞 Panggilan dari ${callerName}`,
    body: 'Ketuk untuk menjawab',
    android: {
      channelId: 'calls',
      importance: AndroidImportance.HIGH,
      pressAction: { id: 'default' },
      actions: [
        { title: 'Angkat ✅', pressAction: { id: 'answer' } },
        { title: 'Tolak ❌', pressAction: { id: 'reject' } },
      ],
      smallIcon: 'ic_launcher',
    },
    ios: {
      sound: 'default',
      critical: true,
    },
  })
}

export default function App() {
  const { isSetupComplete, identity, connectionMode, setConnectionMode, relayUrl } = useAppStore()
  const { receiveMessage } = useMessageStore()

  useEffect(() => {
    // Inisialisasi database SQLite lokal
    initDatabase().then(() => {
      console.log('[app] Database initialized')
    })
  }, [])

  // Request permission notifikasi saat setup selesai
  useEffect(() => {
    if (!isSetupComplete) return
    notifee.requestPermission().catch(console.warn)
    createNotificationChannels().catch(console.warn)

    // Handle aksi notifikasi (angkat/tolak saat app di background)
    return notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.ACTION_PRESS && detail.pressAction?.id === 'answer') {
        const data = detail.notification?.data as { callId?: string; fromUserId?: string; callType?: string } | undefined
        if (data?.callId && navigationRef.isReady()) {
          navigationRef.navigate('Call', {
            callId: data.callId,
            contactUserId: data.fromUserId ?? '',
            contactName: data.fromUserId ?? '',
            callType: (data.callType ?? 'audio') as 'audio' | 'video',
            isIncoming: true,
          })
        }
      }
    })
  }, [isSetupComplete])

  useEffect(() => {
    if (!isSetupComplete || !identity) return

    let mounted = true

    void (async () => {
      try {
        const cm = await startConnectionManager({
          userId: identity.userId,
          displayName: identity.displayName,
          publicKey: identity.publicKey,
          deviceId: identity.deviceId,
          relayUrl,
        })

        if (!mounted) return

        // Subscribe ke perubahan mode koneksi
        const unsubMode = cm.onModeChange((mode) => {
          setConnectionMode(mode)
        })

        // Subscribe ke pesan masuk
        const unsubMsg = cm.onMessage((msg, fromUserId) => {
          void receiveMessage(msg)
          // Notifikasi lokal saat app di background
          if (AppState.currentState !== 'active') {
            const preview = (msg as { content?: string }).content ?? '\ud83d\udcce Pesan baru'
            void showMessageNotification(fromUserId, preview)
          }
        })

        // Subscribe ke panggilan masuk (offer dari peer)
        const unsubCall = cm.onCallSignal((payload) => {
          if (payload.type === 'offer' && navigationRef.isReady()) {
            if (AppState.currentState !== 'active') {
              // App di background — tampilkan notifikasi dengan tombol Angkat/Tolak
              void showCallNotification(payload.fromUserId, payload.callId)
            } else {
              // App aktif — langsung navigasi ke CallScreen
              navigationRef.navigate('Call', {
                callId: payload.callId,
                contactUserId: payload.fromUserId,
                contactName: payload.fromUserId,
                callType: payload.callType ?? 'audio',
                isIncoming: true,
                sdpOffer: payload.sdp,
              })
            }
          }
        })

        console.log(`[app] ConnectionManager started: ${cm.currentMode}`)
        setConnectionMode(cm.currentMode)

        // Cleanup
        return () => {
          unsubMode()
          unsubMsg()
          unsubCall()
        }
      } catch (err) {
        console.warn('[app] ConnectionManager start failed:', err)
      }
    })()

    return () => {
      mounted = false
      void stopConnectionManager()
    }
  }, [isSetupComplete, identity, relayUrl])

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: '#075E54' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        {!isSetupComplete ? (
          <Stack.Screen
            name="Setup"
            component={SetupScreen}
            options={{ headerShown: false }}
          />
        ) : (
          <>
            <Stack.Screen
              name="Home"
              component={HomeScreen}
              options={{ title: 'Messenger', headerShown: false }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={({ route }) => ({ title: route.params.contactName })}
            />
            <Stack.Screen
              name="Call"
              component={CallScreen}
              options={{ headerShown: false }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  )
}
