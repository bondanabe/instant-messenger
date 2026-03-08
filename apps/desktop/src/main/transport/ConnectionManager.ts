import { BaseConnectionManager } from '@im/core'
import { calculateNextRetry, MAX_RETRY_COUNT } from '@im/core'
import type { WireMessage, TransportMode, CallSignalPayload } from '@im/core'
import { DesktopInternetTransport } from './InternetTransport'
import { DesktopLANTransport } from './LANTransport'
import { getDatabase } from '../db'
import { outbox } from '@im/db-schema'
import { eq, lte, and, lt } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import type { BrowserWindow } from 'electron'

// ─────────────────────────────────────────────────────────────────
// DESKTOP CONNECTION MANAGER
// Berjalan di main process Electron.
// Meneruskan pesan masuk + mode changes ke renderer via IPC.
// ─────────────────────────────────────────────────────────────────

export class DesktopConnectionManager extends BaseConnectionManager {
  private outboxInterval: ReturnType<typeof setInterval> | null = null
  private redetectInterval: ReturnType<typeof setInterval> | null = null
  private mainWindow: BrowserWindow | null = null

  constructor(
    private readonly userId: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
    private readonly relayUrl: string,
  ) {
    super()

    this.transports = [
      new DesktopInternetTransport(relayUrl, userId, publicKey, deviceId),
      new DesktopLANTransport(userId, publicKey, deviceId),
    ]
  }

  /** Set BrowserWindow agar bisa forward event ke renderer */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  override async start(): Promise<void> {
    await super.start()

    // Forward incoming messages ke renderer
    this.onMessage((msg, fromUserId) => {
      this.mainWindow?.webContents.send('message:incoming', { message: msg, fromUserId })
    })

    // Forward mode changes ke renderer
    this.onModeChange((mode) => {
      this.mainWindow?.webContents.send('connection:mode', mode)
    })

    // Forward typing + read receipts from all transports that support it
    for (const t of this.transports) {
      if ('onTyping' in t && typeof (t as DesktopInternetTransport).onTyping === 'function') {
        ;(t as DesktopInternetTransport).onTyping((fromUserId, isTyping) => {
          this.mainWindow?.webContents.send('typing:incoming', { fromUserId, isTyping })
        })
      }
      if ('onReadReceipt' in t && typeof (t as DesktopInternetTransport).onReadReceipt === 'function') {
        ;(t as DesktopInternetTransport).onReadReceipt((fromUserId, messageId) => {
          this.mainWindow?.webContents.send('read_receipt:incoming', { fromUserId, messageId })
        })
      }
    }

    // Forward call signals from internet transport to renderer
    const internetTransport = this.transports[0] as DesktopInternetTransport | undefined
    internetTransport?.onCallSignal((payload) => {
      this.mainWindow?.webContents.send('call:signal', payload)
    })

    this.startOutboxProcessor()
    this.startRedetectInterval()
  }

  override async stop(): Promise<void> {
    await super.stop()
    if (this.outboxInterval) {
      clearInterval(this.outboxInterval)
      this.outboxInterval = null
    }
    if (this.redetectInterval) {
      clearInterval(this.redetectInterval)
      this.redetectInterval = null
    }
  }

  private startOutboxProcessor(): void {
    this.outboxInterval = setInterval(() => {
      this.processOutbox().catch(console.warn)
    }, 30_000)
  }

  /** Re-run transport detection every 30 s so desktop reacts to network changes */
  private startRedetectInterval(): void {
    this.redetectInterval = setInterval(() => {
      this.detectBestTransport().catch(console.warn)
    }, 30_000)
  }

  async processOutbox(): Promise<void> {
    if (this.currentMode === 'offline') return

    const db = getDatabase()
    const now = Date.now()

    const pending = await db
      .select()
      .from(outbox)
      .where(
        and(
          lte(outbox.nextRetryAt, now),
          lt(outbox.retryCount, MAX_RETRY_COUNT),
        ),
      )
      .limit(20)

    for (const entry of pending) {
      try {
        const payload = Buffer.from(entry.encryptedPayload as Uint8Array).toString('utf8')
        const msg = JSON.parse(payload) as WireMessage

        const result = await this.send(entry.targetUserId, msg)

        if (result.status === 'sent' || result.status === 'delivered') {
          await db.delete(outbox).where(eq(outbox.id, entry.id))
        } else {
          await db
            .update(outbox)
            .set({
              retryCount: entry.retryCount + 1,
              nextRetryAt: calculateNextRetry(entry.retryCount + 1),
            })
            .where(eq(outbox.id, entry.id))
        }
      } catch {
        await db
          .update(outbox)
          .set({ retryCount: entry.retryCount + 1, nextRetryAt: calculateNextRetry(entry.retryCount + 1) })
          .where(eq(outbox.id, entry.id))
      }
    }
  }

  protected override async saveToOutbox(
    targetUserId: string,
    message: WireMessage,
  ): Promise<void> {
    const db = getDatabase()
    const payload = Buffer.from(JSON.stringify(message), 'utf8')

    await db.insert(outbox).values({
      id: uuidv4(),
      messageId: message.id,
      targetUserId,
      encryptedPayload: payload,
      retryCount: 0,
      nextRetryAt: calculateNextRetry(0),
      createdAt: Date.now(),
    })

    console.log(`[outbox] Message ${message.id} saved to outbox (target: ${targetUserId})`)
  }

  /** Send call signal via internet transport */
  sendCallSignal(payload: Omit<CallSignalPayload, 'fromUserId'>): void {
    const internetTransport = this.transports[0] as DesktopInternetTransport | undefined
    internetTransport?.sendCallSignal(payload)
  }

  /** Send typing indicator via active transport(s) that support it */
  sendTyping(targetUserId: string, isTyping: boolean): void {
    for (const t of this.transports) {
      if ('sendTyping' in t && typeof (t as DesktopInternetTransport).sendTyping === 'function') {
        ;(t as DesktopInternetTransport).sendTyping(targetUserId, isTyping)
      }
    }
  }

  /** Send read receipt via active transport(s) that support it */
  sendReadReceipt(targetUserId: string, messageId: string): void {
    for (const t of this.transports) {
      if ('sendReadReceipt' in t && typeof (t as DesktopInternetTransport).sendReadReceipt === 'function') {
        ;(t as DesktopInternetTransport).sendReadReceipt(targetUserId, messageId)
      }
    }
  }

  /** Check if a user is online via internet transport */
  async checkOnline(userId: string): Promise<boolean> {
    const transport = this.transports[0] as DesktopInternetTransport | undefined
    if (!transport) return false
    return transport.checkOnline(userId)
  }
}
