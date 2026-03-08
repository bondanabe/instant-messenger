import * as net from 'node:net'
import * as dgram from 'node:dgram'
import * as os from 'node:os'
import type { WireMessage, MessageDeliveryEvent, LANPeerInfo, E2EEPayload, PreKeyBundleWire } from '@im/core'
import { DesktopCryptoService } from './CryptoService'

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────

const TCP_PORT = 47823     // TCP server for messaging + prekey exchange
const UDP_PORT = 47824     // UDP broadcast for peer discovery
const ANNOUNCE_INTERVAL_MS = 5_000
const TCP_TIMEOUT_MS = 8_000
const DISCOVERY_TTL_MS = 30_000  // remove peer if not heard from in 30 s

// ─────────────────────────────────────────────────────────────────
// FRAME TYPES
// ─────────────────────────────────────────────────────────────────

interface AnnouncePacket {
  type: 'announce'
  userId: string
  port: number
  publicKey: string
}

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
// DESKTOP LAN TRANSPORT
// Uses Node.js built-in node:net (TCP) + node:dgram (UDP).
// No external dependencies.
// ─────────────────────────────────────────────────────────────────

interface PeerEntry extends LANPeerInfo {
  lastSeenAt: number
}

export class DesktopLANTransport {
  readonly mode = 'lan' as const

  private peers = new Map<string, PeerEntry>()

  private udpSocket: dgram.Socket | null = null
  private tcpServer: net.Server | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  private onMessageCb: ((msg: WireMessage, fromUserId: string) => void) | null = null
  private onTypingCb: ((fromUserId: string, isTyping: boolean) => void) | null = null
  private onReadReceiptCb: ((fromUserId: string, messageId: string) => void) | null = null

  private cryptoService: DesktopCryptoService

  constructor(
    private readonly userId: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
  ) {
    this.cryptoService = new DesktopCryptoService(
      userId,
      deviceId,
      (targetUserId) => this.fetchPreKeyBundleFromPeer(targetUserId),
    )
  }

  // ── ITransport interface ──────────────────────────────────────

  /** Available if there is at least one non-loopback IPv4 interface */
  async isAvailable(): Promise<boolean> {
    return this.getNonLoopbackIPv4Addresses().length > 0
  }

  async connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void> {
    this.onMessageCb = onMessage
    this.startTCPServer()
    this.startUDPDiscovery()
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
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.udpSocket?.close()
    this.udpSocket = null
    await new Promise<void>((resolve) => {
      if (this.tcpServer) {
        this.tcpServer.close(() => resolve())
      } else {
        resolve()
      }
    })
    this.tcpServer = null
    this.peers.clear()
  }

  // ── Extra methods (same shape as DesktopInternetTransport) ────

  sendTyping(targetUserId: string, isTyping: boolean): void {
    const peer = this.peers.get(targetUserId)
    if (!peer) return
    const frame: TypingFrame = { type: 'typing', fromUserId: this.userId, isTyping }
    this.sendTCPFrame(peer.host, peer.port, frame).catch(() => { /* fire-and-forget */ })
  }

  sendReadReceipt(targetUserId: string, messageId: string): void {
    const peer = this.peers.get(targetUserId)
    if (!peer) return
    const frame: ReadReceiptFrame = { type: 'read_receipt', fromUserId: this.userId, messageId }
    this.sendTCPFrame(peer.host, peer.port, frame).catch(() => { /* fire-and-forget */ })
  }

  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCb = cb
  }

  onReadReceipt(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCb = cb
  }

  getDiscoveredPeers(): LANPeerInfo[] {
    return Array.from(this.peers.values())
  }

  // ── UDP Discovery ─────────────────────────────────────────────

  private startUDPDiscovery(): void {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udpSocket = socket

    socket.on('error', (err) => {
      console.warn('[lan] UDP error:', err.message)
    })

    socket.on('message', (buf, rinfo) => {
      try {
        const packet = JSON.parse(buf.toString('utf8')) as AnnouncePacket
        if (packet.type !== 'announce') return
        if (packet.userId === this.userId) return  // ignore own broadcasts

        const peer: PeerEntry = {
          userId: packet.userId,
          displayName: packet.userId,  // filled later if needed
          publicKey: packet.publicKey,
          host: rinfo.address,
          port: packet.port,
          lastSeenAt: Date.now(),
        }
        this.peers.set(packet.userId, peer)
      } catch { /* ignore malformed packets */ }
    })

    socket.bind(UDP_PORT, () => {
      try {
        socket.setBroadcast(true)
      } catch { /* ignore on platforms that don't support */ }
      // Send first announce immediately, then on interval
      this.broadcastAnnounce()
      this.announceTimer = setInterval(() => this.broadcastAnnounce(), ANNOUNCE_INTERVAL_MS)
    })

    // Prune stale peers
    this.pruneTimer = setInterval(() => {
      const now = Date.now()
      for (const [userId, peer] of this.peers) {
        if (now - peer.lastSeenAt > DISCOVERY_TTL_MS) {
          this.peers.delete(userId)
        }
      }
    }, DISCOVERY_TTL_MS)
  }

  private broadcastAnnounce(): void {
    if (!this.udpSocket) return
    const packet: AnnouncePacket = {
      type: 'announce',
      userId: this.userId,
      port: TCP_PORT,
      publicKey: this.publicKey,
    }
    const buf = Buffer.from(JSON.stringify(packet), 'utf8')
    for (const addr of this.getBroadcastAddresses()) {
      this.udpSocket.send(buf, UDP_PORT, addr, (err) => {
        if (err) console.warn(`[lan] UDP send error to ${addr}:`, err.message)
      })
    }
  }

  private getBroadcastAddresses(): string[] {
    const addrs: string[] = []
    for (const iface of Object.values(os.networkInterfaces())) {
      if (!iface) continue
      for (const entry of iface) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        // Calculate broadcast: ip | (~mask)
        const ipParts = entry.address.split('.').map(Number)
        const maskParts = entry.netmask.split('.').map(Number)
        const broadcast = ipParts.map((b, i) => (b | (~maskParts[i]! & 0xff))).join('.')
        addrs.push(broadcast)
      }
    }
    return addrs.length > 0 ? addrs : ['255.255.255.255']
  }

  private getNonLoopbackIPv4Addresses(): string[] {
    const addrs: string[] = []
    for (const iface of Object.values(os.networkInterfaces())) {
      if (!iface) continue
      for (const entry of iface) {
        if (entry.family === 'IPv4' && !entry.internal) addrs.push(entry.address)
      }
    }
    return addrs
  }

  // ── TCP Server ────────────────────────────────────────────────

  private startTCPServer(): void {
    const server = net.createServer((socket) => {
      let buf = ''

      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''  // last piece might be incomplete

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const frame = JSON.parse(line) as TCPFrame
            void this.handleIncomingFrame(socket, frame)
          } catch { /* ignore malformed frame */ }
        }
      })

      socket.on('error', () => { /* ignore per-socket errors */ })
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[lan] TCP port ${TCP_PORT} already in use — LAN transport disabled`)
      } else {
        console.warn('[lan] TCP server error:', err.message)
      }
    })

    server.listen(TCP_PORT, '0.0.0.0', () => {
      console.log(`[lan] TCP server listening on port ${TCP_PORT}`)
    })

    this.tcpServer = server
  }

  private async handleIncomingFrame(socket: net.Socket, frame: TCPFrame): Promise<void> {
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
          console.warn('[lan] Failed to decrypt incoming message:', err)
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

  /**
   * Open a TCP connection to host:port, send a frame, optionally wait for
   * a response frame of the given type, then close.
   */
  private sendTCPFrame(
    host: string,
    port: number,
    frame: TCPFrame,
    waitForType?: string,
  ): Promise<TCPFrame | null> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port })
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

      socket.setTimeout(TCP_TIMEOUT_MS)
      socket.on('timeout', () => fail(new Error('TCP timeout')))
      socket.on('error', fail)

      socket.on('connect', () => {
        socket.write(JSON.stringify(frame) + '\n')
        if (!waitForType) {
          // Fire-and-forget: wait briefly then close
          setTimeout(() => finish(null), 100)
        }
      })

      socket.on('data', (chunk) => {
        if (!waitForType) return
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const response = JSON.parse(line) as TCPFrame
            if (response.type === waitForType) {
              finish(response)
              return
            }
          } catch { /* ignore */ }
        }
      })

      socket.on('close', () => {
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
