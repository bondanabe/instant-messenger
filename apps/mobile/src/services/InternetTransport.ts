import { io, Socket } from 'socket.io-client'
import type {
  ITransport,
  WireMessage,
  MessageDeliveryEvent,
  RelayEnvelope,
  E2EEPayload,
  PreKeyBundleWire,
  CallSignalPayload,
} from '@im/core'
import { CryptoService } from './CryptoService'

export class InternetTransport implements ITransport {
  readonly mode = 'internet' as const
  private socket: Socket | null = null
  private onMessageCb: ((msg: WireMessage, fromUserId: string) => void) | null = null
  private onTypingCb: ((fromUserId: string, isTyping: boolean) => void) | null = null
  private onReadReceiptCb: ((fromUserId: string, messageId: string) => void) | null = null
  private onCallSignalCb: ((payload: CallSignalPayload) => void) | null = null
  private cryptoService: CryptoService

  constructor(
    private readonly relayUrl: string,
    private readonly userId: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
  ) {
    // CryptoService mengambil prekey bundle via relay socket
    this.cryptoService = new CryptoService(
      userId,
      deviceId,
      (targetUserId) => this.fetchPreKeyBundle(targetUserId),
    )
  }

  private fetchPreKeyBundle(targetUserId: string): Promise<PreKeyBundleWire> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('InternetTransport: tidak terhubung ke relay'))
        return
      }
      this.socket.emit(
        'prekey:fetch',
        { targetUserId },
        (result: { ok?: boolean; bundle?: PreKeyBundleWire; error?: string }) => {
          if (result.bundle) resolve(result.bundle)
          else reject(new Error(result.error ?? 'prekey_not_found'))
        },
      )
    })
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const testSocket = io(this.relayUrl, {
        transports: ['websocket'],
        timeout: 3000,
        reconnection: false,
      })
      testSocket.once('connect', () => {
        testSocket.disconnect()
        resolve(true)
      })
      testSocket.once('connect_error', () => {
        testSocket.disconnect()
        resolve(false)
      })
    })
  }

  async connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void> {
    this.onMessageCb = onMessage

    this.socket = io(this.relayUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 10_000,
    })

    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Socket not initialized'))

      this.socket.once('connect', () => {
        // Daftarkan identitas ke relay server
        this.socket!.emit(
          'register',
          { userId: this.userId, publicKey: this.publicKey, deviceId: this.deviceId },
          (ack: { ok?: boolean; error?: string }) => {
            if (!ack?.ok) {
              reject(new Error(ack?.error ?? 'Registration failed'))
              return
            }
            // Publikasikan prekey bundle agar kontak bisa memulai sesi E2EE
            void this.cryptoService.getOurPreKeyBundle().then((bundle) => {
              this.socket?.emit('prekey:publish', bundle, () => {
                // Abaikan error — akan di-retry saat reconnect
              })
            })
            resolve()
          },
        )
      })

      this.socket.once('connect_error', reject)

      // Handle pesan masuk — E2EE decrypt via CryptoService
      this.socket.on(
        'message',
        (data: { fromUserId: string; messageId: string; encryptedPayload: string }) => {
          void (async () => {
            try {
              const e2ee = JSON.parse(
                Buffer.from(data.encryptedPayload, 'base64').toString('utf8'),
              ) as E2EEPayload
              const msg = await this.cryptoService.decrypt(data.fromUserId, e2ee)
              this.onMessageCb?.(msg, data.fromUserId)
            } catch (err) {
              console.warn('[internet] Gagal mendekripsi pesan masuk:', err)
            }
          })()
        },
      )

      // Handle typing & read receipt
      this.socket.on('typing', (data: { fromUserId: string; isTyping: boolean }) => {
        this.onTypingCb?.(data.fromUserId, data.isTyping)
      })

      this.socket.on('read_receipt', (data: { fromUserId: string; messageId: string }) => {
        this.onReadReceiptCb?.(data.fromUserId, data.messageId)
      })

      this.socket.on('call:signal', (data: CallSignalPayload) => {
        this.onCallSignalCb?.(data)
      })
    })
  }

  async send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent> {
    if (!this.socket?.connected) {
      return { messageId: message.id, status: 'failed', transport: 'internet' }
    }

    // E2EE: enkripsi via CryptoService (X3DH + Double Ratchet)
    const e2ee = await this.cryptoService.encryptFor(targetUserId, message)
    const payload = Buffer.from(JSON.stringify(e2ee)).toString('base64')

    const envelope: RelayEnvelope = {
      targetUserId,
      messageId: message.id,
      encryptedPayload: payload,
    }

    return new Promise((resolve) => {
      this.socket!.emit(
        'message',
        envelope,
        (ack: { ok?: boolean; delivered?: boolean; error?: string }) => {
          if (ack?.error) {
            resolve({ messageId: message.id, status: 'failed', transport: 'internet' })
          } else if (ack?.delivered) {
            resolve({ messageId: message.id, status: 'delivered', transport: 'internet' })
          } else {
            // Target offline — pengirim simpan ke outbox
            resolve({ messageId: message.id, status: 'sent', transport: 'internet' })
          }
        },
      )
    })
  }

  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCb = cb
  }

  onReadReceipt(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCb = cb
  }

  onCallSignal(cb: (payload: CallSignalPayload) => void): void {
    this.onCallSignalCb = cb
  }

  sendCallSignal(payload: Omit<CallSignalPayload, 'fromUserId'>): void {
    this.socket?.emit('call:signal', payload)
  }

  sendTyping(targetUserId: string, isTyping: boolean): void {
    this.socket?.emit('typing', { targetUserId, isTyping })
  }

  sendReadReceipt(targetUserId: string, messageId: string): void {
    this.socket?.emit('read_receipt', { targetUserId, messageId })
  }

  async disconnect(): Promise<void> {
    this.socket?.disconnect()
    this.socket = null
  }
}
