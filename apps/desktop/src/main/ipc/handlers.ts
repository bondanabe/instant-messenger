import { ipcMain, Notification, BrowserWindow, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { getDatabase } from '../db'
import { messages, conversations, contacts, outbox, identity, prekeys as prekeysTable } from '@im/db-schema'
import { eq, desc, and, lte, lt, isNull } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { calculateNextRetry, MAX_RETRY_COUNT } from '@im/core'
import type { WireMessage } from '@im/core'
import {
  generateIdentityKeyPair,
  generateDHKeyPair,
  identityToDHKeyPair,
  signBytes,
} from '@im/crypto'
import { getConnectionManager, setConnectionManager, storeRelayUrl, getStoredRelayUrl, restartCM } from '../index'
import { DesktopConnectionManager } from '../transport/ConnectionManager'

type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
type MessageType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'system'

/**
 * Semua IPC handler untuk komunikasi main ↔ renderer
 * Renderer (React UI) tidak mengakses DB langsung — semua lewat IPC
 */
export function registerIpcHandlers(): void {
  const db = getDatabase()

  /**
   * Wrapper aman untuk ipcMain.handle.
   * Menangkap semua exception dan mengembalikan { ok: false, error: string }
   * ke renderer alih-alih membiarkan promise rejected tidak tertangani.
   */
  function handle(
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>,
  ): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ipc:${channel}] unhandled error: ${message}`)
        return { ok: false as const, error: message }
      }
    })
  }

  // ── IDENTITY ────────────────────────────────────────────────────
  handle('identity:get', async () => {
    const result = await db.select().from(identity).limit(1)
    if (!result[0]) return null
    // Kembalikan tanpa private key ke renderer
    const { privateKey: _priv, ...safe } = result[0]
    return safe
  })

  /**
   * Buat identitas baru dari renderer.
   * Renderer mengirim nama + relay URL saja — semua kunci di-generate di main process.
   */
  handle(
    'identity:create',
    async (_, { userId, displayName, deviceId, relayUrl }: {
      userId: string
      displayName: string
      deviceId: string
      relayUrl?: string
    }) => {
      const now = Date.now()

      // 1. Generate Ed25519 identity keypair
      const identityKP = generateIdentityKeyPair()

      // 2. Generate signed prekey (X25519)
      const spk = generateDHKeyPair()
      const spkId = Math.floor(Math.random() * 0xffffff)
      const spkSignature = signBytes(identityKP.privateKey, spk.publicKey)

      // 3. Generate 10 one-time prekeys
      const oneTimePreKeys = Array.from({ length: 10 }, (_, i) => ({
        ...generateDHKeyPair(),
        id: spkId * 100 + i,
      }))

      // 4. Simpan identity (private key aman di main process, tidak dikirim ke renderer)
      await db.insert(identity).values({
        userId,
        displayName,
        deviceId,
        privateKey: identityKP.privateKey,
        publicKey: identityKP.publicKey,
        createdAt: now,
      })

      // 5. Simpan signed prekey
      await db.insert(prekeysTable).values({
        id: spkId,
        keyType: 'signed_prekey',
        privateKey: spk.privateKey,
        publicKey: spk.publicKey,
        signature: spkSignature,
        createdAt: now,
      })

      // 6. Simpan one-time prekeys
      for (const opk of oneTimePreKeys) {
        await db.insert(prekeysTable).values({
          id: opk.id,
          keyType: 'one_time_prekey',
          privateKey: opk.privateKey,
          publicKey: opk.publicKey,
          createdAt: now,
        })
      }

      // Kembalikan public key untuk renderer (base64)
      const dhKP = identityToDHKeyPair(identityKP)
      return {
        publicKey: Buffer.from(identityKP.publicKey).toString('base64'),
        identityKeyX25519: Buffer.from(dhKP.publicKey).toString('base64'),
        spkId,
        spkPublicKey: Buffer.from(spk.publicKey).toString('base64'),
        spkSignature: Buffer.from(spkSignature).toString('base64'),
      }
    },
  )

  // ── CONTACTS ─────────────────────────────────────────────────────
  handle('contacts:list', async () => {
    return db.select().from(contacts)
  })

  handle('contacts:add', async (_, contact: {
    userId: string
    displayName: string
    publicKey: Uint8Array
  }) => {
    await db.insert(contacts).values({ ...contact, addedAt: Date.now() }).onConflictDoNothing()
  })

  // ── CONVERSATIONS ─────────────────────────────────────────────────
  handle('conversations:list', async () => {
    return db.select().from(conversations).orderBy(desc(conversations.lastMsgAt))
  })

  handle('conversations:markRead', async (_, conversationId: string) => {
    await db
      .update(conversations)
      .set({ unreadCount: 0 })
      .where(eq(conversations.id, conversationId))
  })

  // ── MESSAGES ──────────────────────────────────────────────────────
  handle('messages:list', async (_, { conversationId, limit = 50, before }: {
    conversationId: string
    limit?: number
    before?: number
  }) => {
    const query = db
      .select()
      .from(messages)
      .where(
        before
          ? and(eq(messages.conversationId, conversationId), lt(messages.createdAt, before))
          : eq(messages.conversationId, conversationId),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit)

    return query
  })

  handle('messages:updateStatus', async (_, { messageId, status }: {
    messageId: string
    status: MessageStatus
  }) => {
    await db.update(messages).set({ status }).where(eq(messages.id, messageId))
  })

  handle('messages:save', async (_, msg: {
    id: string
    conversationId: string
    senderId: string
    type: MessageType
    content: string | null
    status: MessageStatus
    createdAt: number
    replyToId?: string | null
  }) => {
    const now = Date.now()
    // Upsert conversation
    const existing = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, msg.conversationId))

    if (existing.length === 0) {
      await db.insert(conversations).values({
        id: msg.conversationId,
        type: 'dm',
        lastMsgAt: now,
        lastMsgPreview: msg.content?.slice(0, 80) ?? '',
        unreadCount: 1,
        createdAt: now,
      })
    } else {
      await db
        .update(conversations)
        .set({
          lastMsgAt: now,
          lastMsgPreview: msg.content?.slice(0, 80) ?? '',
        })
        .where(eq(conversations.id, msg.conversationId))
    }

    await db.insert(messages).values({
      ...msg,
      replyToId: msg.replyToId ?? null,
      receivedAt: now,
    })
  })

  // ── OUTBOX ────────────────────────────────────────────────────────
  handle('outbox:add', async (_, { messageId, targetUserId, payload }: {
    messageId: string
    targetUserId: string
    payload: Buffer
  }) => {
    await db.insert(outbox).values({
      id: uuidv4(),
      messageId,
      targetUserId,
      encryptedPayload: payload,
      retryCount: 0,
      nextRetryAt: calculateNextRetry(0),
      createdAt: Date.now(),
    })
  })

  handle('outbox:getPending', async () => {
    return db
      .select()
      .from(outbox)
      .where(
        and(
          lte(outbox.nextRetryAt, Date.now()),
          lt(outbox.retryCount, MAX_RETRY_COUNT),
        ),
      )
      .limit(20)
  })

  handle('outbox:remove', async (_, id: string) => {
    await db.delete(outbox).where(eq(outbox.id, id))
  })

  // ── NOTIFICATIONS ─────────────────────────────────────────────────
  handle('notify', async (_, { title, body }: { title: string; body: string }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
    }
  })

  // ── CONNECTION MANAGER ────────────────────────────────────────────

  /**
   * Start CM setelah setup selesai (renderer trigger).
   * Dipanggil dari SetupScreen setelah identity:create.
   */
  handle('cm:start', async (_, opts?: { relayUrl?: string }) => {
    let cm = getConnectionManager()
    if (cm) return { ok: true } // Sudah running

    const rows = await db.select().from(identity).limit(1)
    if (!rows[0]) return { ok: false, error: 'no_identity' }

    const id = rows[0]
    const relayUrl = opts?.relayUrl || 'http://localhost:3000'
    const publicKey = Buffer.from(id.publicKey as Uint8Array).toString('base64')

    // Simpan relay URL untuk auto-start berikutnya
    storeRelayUrl(relayUrl)

    cm = new DesktopConnectionManager(
      id.userId,
      publicKey,
      id.deviceId,
      relayUrl,
    )
    setConnectionManager(cm)

    const win = BrowserWindow.getAllWindows()[0]
    if (win) cm.setMainWindow(win)

    await cm.start()
    return { ok: true }
  })

  /**
   * Kirim pesan via ConnectionManager.
   * Renderer mengirim WireMessage + targetUserId.
   */
  handle('cm:send', async (_, { targetUserId, message }: {
    targetUserId: string
    message: WireMessage
  }) => {
    const cm = getConnectionManager()
    if (!cm) return { status: 'failed', error: 'cm_not_started' }
    return cm.send(targetUserId, message)
  })

  /**
   * Ambil mode koneksi saat ini.
   */
  handle('cm:getMode', async () => {
    const cm = getConnectionManager()
    return cm?.currentMode ?? 'offline'
  })

  // ── TYPING & READ RECEIPTS ────────────────────────────────────

  handle('cm:sendTyping', async (_, { targetUserId, isTyping }: {
    targetUserId: string
    isTyping: boolean
  }) => {
    const cm = getConnectionManager()
    cm?.sendTyping(targetUserId, isTyping)
  })

  handle('cm:sendReadReceipt', async (_, { targetUserId, messageId }: {
    targetUserId: string
    messageId: string
  }) => {
    const cm = getConnectionManager()
    cm?.sendReadReceipt(targetUserId, messageId)
  })

  handle('cm:checkOnline', async (_, userId: string) => {
    const cm = getConnectionManager()
    if (!cm) return false
    return cm.checkOnline(userId)
  })

  handle('cm:call:send', async (_, payload: {
    callId: string
    toUserId: string
    type: string
    callType?: string
    sdp?: string
    candidate?: unknown
  }) => {
    const cm = getConnectionManager()
    cm?.sendCallSignal(payload as Parameters<typeof cm.sendCallSignal>[0])
  })

  // ── CONTACTS (extended) ───────────────────────────────────────

  handle('contacts:add:full', async (_, contact: {
    userId: string
    displayName: string
    publicKey: string
    deviceId?: string
    relayUrl?: string
  }) => {
    // Simpan kontak dengan publicKey sebagai base64 string (akan dikonversi ke buffer)
    const pubKeyBuf = Buffer.from(contact.publicKey, 'base64')
    await db.insert(contacts).values({
      userId: contact.userId,
      displayName: contact.displayName,
      publicKey: pubKeyBuf,
      relayUserId: contact.userId,
      addedAt: Date.now(),
    }).onConflictDoNothing()
  })

  // ── MESSAGES: DELETE ─────────────────────────────────────────────

  handle('messages:delete', async (_, messageId: string) => {
    await db
      .update(messages)
      .set({ isDeleted: true })
      .where(eq(messages.id, messageId))
  })

  // ── IDENTITY: UPDATE NAME ─────────────────────────────────────────

  handle('identity:update', async (_, { displayName }: { displayName: string }) => {
    await db
      .update(identity)
      .set({ displayName })
  })

  // ── SETTINGS ──────────────────────────────────────────────────────

  handle('settings:get', async () => {
    return { relayUrl: getStoredRelayUrl() }
  })

  /**
   * Simpan relay URL baru dan restart CM di background.
   * Renderer tidak perlu menunggu restart selesai.
   */
  handle('settings:save', async (_, { relayUrl }: { relayUrl: string }) => {
    void restartCM(relayUrl)
    return { ok: true }
  })

  // ── FILE ATTACHMENT ───────────────────────────────────────────────

  /**
   * Buka dialog file pilih, baca sebagai base64 data URI.
   * Batas: 5 MB raw data (~6.7 MB base64).
   */
  handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
        { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac'] },
        { name: 'Documents', extensions: ['pdf', 'doc', 'docx', 'txt', 'xlsx', 'pptx', 'zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePaths[0]) return null

    const filePath = result.filePaths[0]
    const stats = fs.statSync(filePath)
    const MAX_BYTES = 5 * 1024 * 1024  // 5 MB
    if (stats.size > MAX_BYTES) return { error: 'File terlalu besar (maks 5 MB)' }

    const data = fs.readFileSync(filePath)
    const ext = nodePath.extname(filePath).toLowerCase().slice(1)

    const MIME_MAP: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
      m4a: 'audio/mp4', aac: 'audio/aac',
      pdf: 'application/pdf', txt: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      zip: 'application/zip',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }
    const mimeType = MIME_MAP[ext] ?? 'application/octet-stream'
    const dataUri = `data:${mimeType};base64,${data.toString('base64')}`
    const type: 'image' | 'audio' | 'file' = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('audio/')
        ? 'audio'
        : 'file'

    return {
      dataUri,
      mimeType,
      type,
      name: nodePath.basename(filePath),
      sizeBytes: stats.size,
    }
  })
}
