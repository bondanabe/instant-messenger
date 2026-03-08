import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload script — jembatan aman antara renderer (React) dan main process (Node.js)
 * Renderer hanya bisa memanggil fungsi yang di-expose di sini
 * Tidak ada akses langsung ke Node.js API dari renderer
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // Identity
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  createIdentity: (data: {
    userId: string
    displayName: string
    deviceId: string
    relayUrl?: string
  }) => ipcRenderer.invoke('identity:create', data),

  // Contacts
  listContacts: () => ipcRenderer.invoke('contacts:list'),
  // Contacts (extended — accepts base64 pubkey string)
  addContact: (contact: {
    userId: string
    displayName: string
    publicKey: string
    deviceId?: string
    relayUrl?: string
  }) => ipcRenderer.invoke('contacts:add:full', contact),

  // Conversations
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  markConversationRead: (id: string) => ipcRenderer.invoke('conversations:markRead', id),

  // Messages
  listMessages: (params: {
    conversationId: string
    limit?: number
    before?: number
  }) => ipcRenderer.invoke('messages:list', params),
  saveMessage: (msg: unknown) => ipcRenderer.invoke('messages:save', msg),
  updateMessageStatus: (params: { messageId: string; status: string }) =>
    ipcRenderer.invoke('messages:updateStatus', params),

  // Outbox
  addToOutbox: (params: {
    messageId: string
    targetUserId: string
    payload: Buffer
  }) => ipcRenderer.invoke('outbox:add', params),
  getPendingOutbox: () => ipcRenderer.invoke('outbox:getPending'),
  removeFromOutbox: (id: string) => ipcRenderer.invoke('outbox:remove', id),

  // Notifications
  notify: (params: { title: string; body: string }) =>
    ipcRenderer.invoke('notify', params),

  // Events dari main process ke renderer
  onIncomingMessage: (cb: (data: unknown) => void) => {
    ipcRenderer.on('message:incoming', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('message:incoming')
  },
  onConnectionModeChange: (cb: (mode: string) => void) => {
    ipcRenderer.on('connection:mode', (_, mode) => cb(mode))
    return () => ipcRenderer.removeAllListeners('connection:mode')
  },
  onTyping: (cb: (data: { fromUserId: string; isTyping: boolean }) => void) => {
    ipcRenderer.on('typing:incoming', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('typing:incoming')
  },
  onReadReceipt: (cb: (data: { fromUserId: string; messageId: string }) => void) => {
    ipcRenderer.on('read_receipt:incoming', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('read_receipt:incoming')
  },

  // Connection Manager
  startCM: (opts?: { relayUrl?: string }) => ipcRenderer.invoke('cm:start', opts),
  sendMessage: (params: { targetUserId: string; message: unknown }) =>
    ipcRenderer.invoke('cm:send', params),
  sendTyping: (params: { targetUserId: string; isTyping: boolean }) =>
    ipcRenderer.invoke('cm:sendTyping', params),
  sendReadReceipt: (params: { targetUserId: string; messageId: string }) =>
    ipcRenderer.invoke('cm:sendReadReceipt', params),
  checkOnline: (userId: string) => ipcRenderer.invoke('cm:checkOnline', userId),
  getConnectionMode: () => ipcRenderer.invoke('cm:getMode'),

  // Phase 5 — message actions
  deleteMessage: (messageId: string) => ipcRenderer.invoke('messages:delete', messageId),

  // Phase 5 — identity & settings
  updateIdentityName: (displayName: string) =>
    ipcRenderer.invoke('identity:update', { displayName }),
  getStoredRelayUrl: () =>
    ipcRenderer.invoke('settings:get').then((s: { relayUrl: string }) => s.relayUrl),
  updateRelayUrl: (relayUrl: string) => ipcRenderer.invoke('settings:save', { relayUrl }),

  // Phase 6 — file attachment dialog
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // Phase 6 — WebRTC call signaling
  sendCallSignal: (payload: {
    callId: string
    toUserId: string
    type: string
    callType?: string
    sdp?: string
    candidate?: unknown
  }) => ipcRenderer.invoke('cm:call:send', payload),
  onCallSignal: (cb: (data: unknown) => void) => {
    ipcRenderer.on('call:signal', (_, data) => cb(data))
    return () => ipcRenderer.removeAllListeners('call:signal')
  },

  // Phase 7 — Auto-updater
  onUpdateAvailable: (cb: (info: { version: string }) => void) => {
    ipcRenderer.on('update:available', (_, info) => cb(info as { version: string }))
    return () => ipcRenderer.removeAllListeners('update:available')
  },
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => {
    ipcRenderer.on('update:downloaded', (_, info) => cb(info as { version: string }))
    return () => ipcRenderer.removeAllListeners('update:downloaded')
  },
  restartToUpdate: () => ipcRenderer.invoke('update:restart'),
})
