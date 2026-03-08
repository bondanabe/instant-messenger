import { create } from 'zustand'
import { MMKV } from 'react-native-mmkv'

const storage = new MMKV({ id: 'app-store' })

interface Identity {
  userId: string
  displayName: string
  deviceId: string
  publicKey: string
}

interface AppState {
  // Identitas user (null = belum setup)
  identity: Identity | null
  isSetupComplete: boolean

  // Status koneksi saat ini
  connectionMode: 'internet' | 'lan' | 'wifi_direct' | 'bluetooth' | 'offline'

  // Relay server URL
  relayUrl: string

  // Actions
  setIdentity: (identity: Identity) => void
  setConnectionMode: (mode: AppState['connectionMode']) => void
  setRelayUrl: (url: string) => void
  clearIdentity: () => void
}

const DEFAULT_RELAY_URL = 'wss://your-relay.up.railway.app'

export const useAppStore = create<AppState>((set) => ({
  identity: loadIdentity(),
  isSetupComplete: !!loadIdentity(),
  connectionMode: 'offline',
  relayUrl: storage.getString('relayUrl') ?? DEFAULT_RELAY_URL,

  setIdentity: (identity) => {
    saveIdentity(identity)
    set({ identity, isSetupComplete: true })
  },

  setConnectionMode: (mode) => set({ connectionMode: mode }),

  setRelayUrl: (url) => {
    storage.set('relayUrl', url)
    set({ relayUrl: url })
  },

  clearIdentity: () => {
    storage.delete('identity')
    set({ identity: null, isSetupComplete: false })
  },
}))

function loadIdentity(): Identity | null {
  const raw = storage.getString('identity')
  if (!raw) return null
  try {
    return JSON.parse(raw) as Identity
  } catch {
    return null
  }
}

function saveIdentity(identity: Identity): void {
  storage.set('identity', JSON.stringify(identity))
}
