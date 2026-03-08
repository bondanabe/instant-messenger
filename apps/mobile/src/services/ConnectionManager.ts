import { BaseConnectionManager } from '@im/core'
import { calculateNextRetry, MAX_RETRY_COUNT } from '@im/core'
import type { WireMessage, TransportMode, CallSignalPayload } from '@im/core'
import { InternetTransport } from './InternetTransport'
import { LANTransport } from './LANTransport'
import { BLETransport } from './BLETransport'
import { WiFiDirectTransport } from './WiFiDirectTransport'
import { getDatabase } from '../db'
import { outbox } from '@im/db-schema'
import { eq, lte, and, lt } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import NetInfo from '@react-native-community/netinfo'

export class MobileConnectionManager extends BaseConnectionManager {
  private outboxInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly userId: string,
    private readonly displayName: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
    private readonly relayUrl: string,
  ) {
    super()

    // Urutan prioritas: internet → lan → wifi_direct → bluetooth
    this.transports = [
      new InternetTransport(relayUrl, userId, publicKey, deviceId),
      new LANTransport(userId, displayName, publicKey, deviceId),
      new WiFiDirectTransport(userId, publicKey, deviceId),
      new BLETransport(userId, deviceId),
    ]
  }

  override async start(): Promise<void> {
    await super.start()
    this.startNetworkMonitoring()
    this.startOutboxProcessor()

    // Wire typing + read receipt from all transports that support it
    for (const t of this.transports) {
      if ('onTyping' in t && typeof (t as LANTransport).onTyping === 'function') {
        ;(t as LANTransport).onTyping((fromUserId, isTyping) => {
          this.onTypingCallback?.(fromUserId, isTyping)
        })
      }
      if ('onReadReceipt' in t && typeof (t as LANTransport).onReadReceipt === 'function') {
        ;(t as LANTransport).onReadReceipt((fromUserId, messageId) => {
          this.onReadReceiptCallback?.(fromUserId, messageId)
        })
      }
    }

    // Wire call signal from internet transport
    const internetTransport = this.transports.find((t) => t.mode === 'internet') as InternetTransport | undefined
    internetTransport?.onCallSignal((payload) => {
      for (const listener of this.callSignalListeners) listener(payload)
    })
  }

  private onTypingCallback: ((fromUserId: string, isTyping: boolean) => void) | null = null
  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCallback = cb
  }

  /** Register callback for incoming read receipts */
  private onReadReceiptCallback: ((fromUserId: string, messageId: string) => void) | null = null
  onReadReceiptEvent(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCallback = cb
  }

  /** Subscribe to incoming call signals (returns unsubscribe fn) */
  private callSignalListeners: ((payload: CallSignalPayload) => void)[] = []
  onCallSignal(cb: (payload: CallSignalPayload) => void): () => void {
    this.callSignalListeners.push(cb)
    return () => {
      this.callSignalListeners = this.callSignalListeners.filter((l) => l !== cb)
    }
  }

  /** Send call signal via internet transport */
  sendCallSignal(payload: Omit<CallSignalPayload, 'fromUserId'>): void {
    const internetTransport = this.transports.find((t) => t.mode === 'internet') as InternetTransport | undefined
    internetTransport?.sendCallSignal(payload)
  }

  /** Send typing indicator via all transports that support it */
  sendTyping(targetUserId: string, isTyping: boolean): void {
    for (const t of this.transports) {
      if ('sendTyping' in t && typeof (t as LANTransport).sendTyping === 'function') {
        ;(t as LANTransport).sendTyping(targetUserId, isTyping)
      }
    }
  }

  /** Send read receipt via all transports that support it */
  sendReadReceipt(targetUserId: string, messageId: string): void {
    for (const t of this.transports) {
      if ('sendReadReceipt' in t && typeof (t as LANTransport).sendReadReceipt === 'function') {
        ;(t as LANTransport).sendReadReceipt(targetUserId, messageId)
      }
    }
  }

  override async stop(): Promise<void> {
    await super.stop()
    if (this.outboxInterval) {
      clearInterval(this.outboxInterval)
      this.outboxInterval = null
    }
  }

  /**
   * Monitor perubahan jaringan dan switch transport otomatis
   */
  private startNetworkMonitoring(): void {
    NetInfo.addEventListener(async (state) => {
      let newMode: TransportMode = 'offline'

      if (state.isConnected && state.isInternetReachable) {
        newMode = 'internet'
      } else if (state.type === 'wifi') {
        newMode = 'lan'
      } else {
        newMode = 'offline'
      }

      if (newMode !== this.currentMode) {
        console.log(`[connection] Switching: ${this.currentMode} → ${newMode}`)
        await this.detectBestTransport()

        // Saat koneksi kembali, proses outbox
        if (newMode !== 'offline') {
          await this.processOutbox()
        }
      }
    })
  }

  /**
   * Proses outbox setiap 30 detik
   */
  private startOutboxProcessor(): void {
    this.outboxInterval = setInterval(() => {
      this.processOutbox().catch(console.warn)
    }, 30_000)
  }

  /**
   * Coba kirim ulang pesan yang ada di outbox
   */
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
        // Decode payload
        const payload = Buffer.from(entry.encryptedPayload).toString('utf8')
        const msg = JSON.parse(payload) as WireMessage

        const result = await this.send(entry.targetUserId, msg)

        if (result.status === 'sent' || result.status === 'delivered') {
          // Berhasil → hapus dari outbox
          await db.delete(outbox).where(eq(outbox.id, entry.id))
        } else {
          // Gagal → update retry
          await db
            .update(outbox)
            .set({
              retryCount: entry.retryCount + 1,
              nextRetryAt: calculateNextRetry(entry.retryCount + 1),
            })
            .where(eq(outbox.id, entry.id))
        }
      } catch {
        // Skip entry yang corrupt
        await db
          .update(outbox)
          .set({ retryCount: entry.retryCount + 1, nextRetryAt: calculateNextRetry(entry.retryCount + 1) })
          .where(eq(outbox.id, entry.id))
      }
    }
  }

  /**
   * Simpan pesan ke outbox SQLite lokal
   * Diimplementasikan dari abstract method di BaseConnectionManager
   */
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
}
