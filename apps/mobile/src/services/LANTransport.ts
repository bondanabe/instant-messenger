import Zeroconf from 'react-native-zeroconf'
import TcpSocket from 'react-native-tcp-socket'
import type { ITransport, WireMessage, MessageDeliveryEvent, LANPeerInfo, E2EEPayload, PreKeyBundleWire } from '@im/core'
import { CryptoService } from './CryptoService'

const SERVICE_TYPE = '_imessenger._tcp.'
const SERVICE_DOMAIN = 'local.'
const P2P_PORT = 47823
const TCP_TIMEOUT_MS = 8_000

// ─────────────────────────────────────────────────────────────────
// FRAME TYPES (shared wire protocol with desktop)
// ─────────────────────────────────────────────────────────────────

interface PrekeyRequestFrame {
  type: 'prekey_request'
  requestId: string
}

interface PrekeyResponseFrame {
  type: 'prekey_response'
  requestId: string
  bundle: PreKeyBundleWire
}

interface MessageFrame {
  type: 'message'
  fromUserId: string
  messageId: string
  encryptedPayload: string  // base64(JSON(E2EEPayload))
}

interface AckFrame {
  type: 'ack'
  messageId: string
}

interface TypingFrame {
  type: 'typing'
  fromUserId: string
  isTyping: boolean
}

interface ReadReceiptFrame {
  type: 'read_receipt'
  fromUserId: string
  messageId: string
}

type TCPFrame =
  | PrekeyRequestFrame
  | PrekeyResponseFrame
  | MessageFrame
  | AckFrame
  | TypingFrame
  | ReadReceiptFrame

// ─────────────────────────────────────────────────────────────────
// MOBILE LAN TRANSPORT
// Discovery: react-native-zeroconf (mDNS)
// Messaging: react-native-tcp-socket (TCP on P2P_PORT)
// E2EE: same CryptoService as internet transport
// ─────────────────────────────────────────────────────────────────

export class LANTransport implements ITransport {
  readonly mode = 'lan' as const

  private zeroconf: Zeroconf = new Zeroconf()
  private peers = new Map<string, LANPeerInfo>()
  private tcpServer: ReturnType<typeof TcpSocket.createServer> | null = null

  private onMessageCb: ((msg: WireMessage, fromUserId: string) => void) | null = null
  private onTypingCb: ((fromUserId: string, isTyping: boolean) => void) | null = null
  private onReadReceiptCb: ((fromUserId: string, messageId: string) => void) | null = null

  private cryptoService: CryptoService

  constructor(
    private readonly userId: string,
    private readonly displayName: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
  ) {
    this.cryptoService = new CryptoService(
      userId,
      deviceId,
      (targetUserId) => this.fetchPreKeyBundleFromPeer(targetUserId),
    )
  }

  // ── ITransport interface ──────────────────────────────────────

  /** Available when TCP server is running (Zeroconf started) */
  async isAvailable(): Promise<boolean> {
    return this.tcpServer !== null
  }

  async connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void> {
    this.onMessageCb = onMessage
    this.startTCPServer()
    this.startDiscovery()
  }

  async send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent> {
    const peer = this.peers.get(targetUserId)
    if (!peer) {
      return { messageId: message.id, status: 'failed', transport: 'lan' }
    }

    try {
      const e2ee = await this.cryptoService.encryptFor(targetUserId, message)
      const encryptedPayload = Buffer.from(JSON.stringify(e2ee)).toString('base64')

      const frame: MessageFrame = {
        type: 'message',
        fromUserId: this.userId,
        messageId: message.id,
        encryptedPayload,
      }

      const response = await this.sendTCPFrame(peer.host, peer.port, frame, 'ack')
      const ack = response as AckFrame | null
      if (ack?.messageId === message.id) {
        return { messageId: message.id, status: 'delivered', transport: 'lan' }
      }
      return { messageId: message.id, status: 'failed', transport: 'lan' }
    } catch (err) {
      console.warn(`[lan] send failed to ${targetUserId}:`, err)
      return { messageId: message.id, status: 'failed', transport: 'lan' }
    }
  }

  async disconnect(): Promise<void> {
    this.zeroconf.unpublishService(this.displayName)
    this.zeroconf.stop()
    this.tcpServer?.destroy()
    this.tcpServer = null
    this.peers.clear()
  }

  // ── Extra callbacks (same shape as InternetTransport) ─────────

  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCb = cb
  }

  onReadReceipt(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCb = cb
  }

  sendTyping(targetUserId: string, isTyping: boolean): void {
    const peer = this.peers.get(targetUserId)
    if (!peer) return
    const frame: TypingFrame = { type: 'typing', fromUserId: this.userId, isTyping }
    this.sendTCPFrame(peer.host, peer.port, frame).catch(() => {/* fire-and-forget */})
  }

  sendReadReceipt(targetUserId: string, messageId: string): void {
    const peer = this.peers.get(targetUserId)
    if (!peer) return
    const frame: ReadReceiptFrame = { type: 'read_receipt', fromUserId: this.userId, messageId }
    this.sendTCPFrame(peer.host, peer.port, frame).catch(() => {/* fire-and-forget */})
  }

  getDiscoveredPeers(): LANPeerInfo[] {
    return Array.from(this.peers.values())
  }

  // ── mDNS Discovery ────────────────────────────────────────────

  private startDiscovery(): void {
    this.zeroconf.scan(SERVICE_TYPE, SERVICE_DOMAIN)

    this.zeroconf.on('resolved', (service) => {
      const uid = service.txt?.userId
      if (!uid || uid === this.userId) return
      const peer: LANPeerInfo = {
        userId: uid,
        displayName: service.txt?.displayName ?? uid,
        publicKey: service.txt?.publicKey ?? '',
        host: service.addresses?.[0] ?? service.host,
        port: service.port ?? P2P_PORT,
      }
      this.peers.set(uid, peer)
      console.log(`[lan] Discovered peer: ${peer.displayName} (${peer.host})`)
    })

    this.zeroconf.on('removed', (service) => {
      this.peers.delete(service.txt?.userId ?? '')
    })

    // Publish our own service so peers can discover us
    this.zeroconf.publishService(
      SERVICE_TYPE,
      SERVICE_DOMAIN,
      this.displayName,
      P2P_PORT,
      {
        userId: this.userId,
        displayName: this.displayName,
        publicKey: this.publicKey,
      },
    )
  }

  // ── TCP Server ────────────────────────────────────────────────

  private startTCPServer(): void {
    const server = TcpSocket.createServer((socket) => {
      let buf = ''

      socket.on('data', (data: Buffer | string) => {
        buf += typeof data === 'string' ? data : data.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const frame = JSON.parse(line) as TCPFrame
            void this.handleIncomingFrame(socket, frame)
          } catch { /* ignore malformed */ }
        }
      })

      socket.on('error', () => {/* ignore per-socket errors */})
    })

    server.on('error', (err: Error) => {
      console.warn('[lan] TCP server error:', err.message)
    })

    server.listen({ port: P2P_PORT, host: '0.0.0.0' }, () => {
      console.log(`[lan] TCP server listening on port ${P2P_PORT}`)
    })

    this.tcpServer = server
  }

  private async handleIncomingFrame(
    socket: ReturnType<typeof TcpSocket.createConnection>,
    frame: TCPFrame,
  ): Promise<void> {
    switch (frame.type) {
      case 'prekey_request': {
        try {
          const bundle = await this.cryptoService.getOurPreKeyBundle()
          const response: PrekeyResponseFrame = {
            type: 'prekey_response',
            requestId: frame.requestId,
            bundle,
          }
          socket.write(JSON.stringify(response) + '\n')
        } catch (err) {
          console.warn('[lan] Failed to build prekey bundle:', err)
        }
        break
      }
      case 'message': {
        try {
          const e2ee = JSON.parse(
            Buffer.from(frame.encryptedPayload, 'base64').toString('utf8'),
          ) as E2EEPayload
          const msg = await this.cryptoService.decrypt(frame.fromUserId, e2ee)
          this.onMessageCb?.(msg, frame.fromUserId)
          const ack: AckFrame = { type: 'ack', messageId: frame.messageId }
          socket.write(JSON.stringify(ack) + '\n')
        } catch (err) {
          console.warn('[lan] Failed to decrypt message:', err)
        }
        break
      }
      case 'typing': {
        this.onTypingCb?.(frame.fromUserId, frame.isTyping)
        break
      }
      case 'read_receipt': {
        this.onReadReceiptCb?.(frame.fromUserId, frame.messageId)
        break
      }
      default:
        break
    }
  }

  // ── TCP Client helpers ────────────────────────────────────────

  private sendTCPFrame(
    host: string,
    port: number,
    frame: TCPFrame,
    waitForType?: string,
  ): Promise<TCPFrame | null> {
    return new Promise((resolve, reject) => {
      const socket = TcpSocket.createConnection({ host, port })
      let buf = ''
      let settled = false

      const finish = (result: TCPFrame | null) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(result)
      }

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(err)
      }

      const timer = setTimeout(() => fail(new Error('TCP timeout')), TCP_TIMEOUT_MS)

      socket.on('error', (err) => { clearTimeout(timer); fail(err) })

      socket.on('connect', () => {
        socket.write(JSON.stringify(frame) + '\n')
        if (!waitForType) {
          setTimeout(() => { clearTimeout(timer); finish(null) }, 100)
        }
      })

      socket.on('data', (data: Buffer | string) => {
        if (!waitForType) return
        buf += typeof data === 'string' ? data : data.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const response = JSON.parse(line) as TCPFrame
            if (response.type === waitForType) {
              clearTimeout(timer)
              finish(response)
              return
            }
          } catch { /* ignore */ }
        }
      })

      socket.on('close', () => {
        clearTimeout(timer)
        if (!settled) finish(null)
      })
    })
  }

  private async fetchPreKeyBundleFromPeer(targetUserId: string): Promise<PreKeyBundleWire> {
    const peer = this.peers.get(targetUserId)
    if (!peer) throw new Error(`[lan] Peer ${targetUserId} not discovered yet`)

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const request: PrekeyRequestFrame = { type: 'prekey_request', requestId }

    const response = await this.sendTCPFrame(peer.host, peer.port, request, 'prekey_response') as PrekeyResponseFrame | null
    if (!response?.bundle) throw new Error(`[lan] Prekey request to ${targetUserId} failed`)
    return response.bundle
  }
}

