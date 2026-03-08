import type { WireMessage, MessageDeliveryEvent, TransportMode } from '../protocol/types.js'
import type { ITransport, IConnectionManager } from './ITransport.js'

// ─────────────────────────────────────────────────────────────────
// BASE CONNECTION MANAGER
// Platform-specific implementation (mobile/desktop) akan extend ini
// ─────────────────────────────────────────────────────────────────

export abstract class BaseConnectionManager implements IConnectionManager {
  protected transports: ITransport[] = []
  protected activeTransport: ITransport | null = null
  private modeChangeHandlers = new Set<(mode: TransportMode) => void>()
  private messageHandlers = new Set<(msg: WireMessage, fromUserId: string) => void>()

  get currentMode(): TransportMode {
    return this.activeTransport?.mode ?? 'offline'
  }

  /**
   * Kirim pesan menggunakan transport terbaik yang tersedia.
   * Prioritas: internet → lan → wifi_direct → bluetooth → offline queue
   */
  async send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent> {
    for (const transport of this.transports) {
      const available = await transport.isAvailable()
      if (!available) continue

      try {
        const result = await transport.send(targetUserId, message)
        if (result.status === 'sent' || result.status === 'delivered') {
          return result
        }
      } catch {
        // Transport gagal, coba berikutnya
        continue
      }
    }

    // Semua transport gagal → simpan ke outbox queue
    await this.saveToOutbox(targetUserId, message)
    return {
      messageId: message.id,
      status: 'pending',
      transport: 'offline',
    }
  }

  async start(): Promise<void> {
    const onMessage = (msg: WireMessage, fromUserId: string) => {
      this.messageHandlers.forEach((h) => h(msg, fromUserId))
    }

    // Koneksi semua transport secara parallel
    await Promise.allSettled(
      this.transports.map((t) => t.connect(onMessage).catch(() => null))
    )

    // Deteksi transport terbaik
    await this.detectBestTransport()
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.transports.map((t) => t.disconnect()))
    this.activeTransport = null
  }

  onModeChange(handler: (mode: TransportMode) => void): () => void {
    this.modeChangeHandlers.add(handler)
    return () => this.modeChangeHandlers.delete(handler)
  }

  onMessage(handler: (msg: WireMessage, fromUserId: string) => void): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  protected async detectBestTransport(): Promise<void> {
    let best: ITransport | null = null

    for (const transport of this.transports) {
      if (await transport.isAvailable()) {
        best = transport
        break
      }
    }

    const newMode = best?.mode ?? 'offline'
    const prevMode = this.activeTransport?.mode ?? null

    if (newMode !== prevMode) {
      this.activeTransport = best
      this.modeChangeHandlers.forEach((h) => h(newMode))
    }
  }

  /** Simpan ke outbox — diimplementasikan di platform layer */
  protected abstract saveToOutbox(targetUserId: string, message: WireMessage): Promise<void>
}
