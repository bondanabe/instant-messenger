/**
 * WiFiDirectTransport — Android WiFi P2P transport using react-native-wifi-p2p.
 *
 * Topology:
 *  - One device becomes the Group Owner (GO), the other is a Client.
 *  - GO listens on a TCP server (port 47823).
 *  - Client connects to GO at fixed IP 192.168.49.1:47823.
 *  - Each connection starts with a Hello frame to exchange userId.
 *  - All messages are E2EE (X3DH + Double Ratchet via CryptoService).
 */

import TcpSocket from 'react-native-tcp-socket'
import type { ITransport, WireMessage, MessageDeliveryEvent, E2EEPayload, PreKeyBundleWire } from '@im/core'
import { Buffer } from 'buffer'
import { CryptoService } from './CryptoService'

// ─── Manual type declarations for react-native-wifi-p2p (no @types package) ──

interface WDDevice {
  deviceName: string
  deviceAddress: string
  status: number // 0=connected 3=available
}

interface WDConnectionInfo {
  groupFormed: boolean
  isGroupOwner: boolean
  groupOwnerAddress: string
}

type WDPeersEvent = { devices: WDDevice[] }
type WDConnectionEvent = WDConnectionInfo

declare module 'react-native-wifi-p2p' {
  export function initialize(): Promise<void>
  export function startDiscoveringPeers(): Promise<void>
  export function stopDiscoveringPeers(): Promise<void>
  export function connect(deviceAddress: string): Promise<void>
  export function disconnect(): Promise<void>
  export function subscribeOnPeersUpdates(cb: (e: WDPeersEvent) => void): void
  export function unsubscribeFromPeersUpdates(cb: (e: WDPeersEvent) => void): void
  export function subscribeOnConnectionInfoUpdates(cb: (e: WDConnectionEvent) => void): void
  export function unsubscribeFromConnectionInfoUpdates(cb: (e: WDConnectionEvent) => void): void
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WifiP2p = require('react-native-wifi-p2p') as typeof import('react-native-wifi-p2p')

// ─── Frame types ──────────────────────────────────────────────────────────────

interface HelloFrame {
  type: 'hello'
  userId: string
  publicKey: string
}

interface PrekeyReqFrame {
  type: 'prekey_req'
  fromUserId: string
}

interface PrekeyRespFrame {
  type: 'prekey_resp'
  bundle: PreKeyBundleWire
}

interface MessageFrame {
  type: 'message'
  messageId: string
  encryptedPayload: string
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

type DataFrame =
  | HelloFrame
  | PrekeyReqFrame
  | PrekeyRespFrame
  | MessageFrame
  | AckFrame
  | TypingFrame
  | ReadReceiptFrame

// ─── Constants ────────────────────────────────────────────────────────────────

const TCP_PORT = 47823
const GO_IP = '192.168.49.1' // fixed IP of Group Owner on WiFi Direct network
const CONNECT_TIMEOUT_MS = 8_000
const PREKEY_TIMEOUT_MS = 5_000

// ─── WiFiDirectTransport ──────────────────────────────────────────────────────

export class WiFiDirectTransport implements ITransport {
  readonly mode = 'wifi_direct' as const

  // Registered callbacks
  private onMessageCb: ((msg: WireMessage, fromUserId: string) => void) | null = null
  private onTypingCb: ((fromUserId: string, isTyping: boolean) => void) | null = null
  private onReadReceiptCb: ((fromUserId: string, messageId: string) => void) | null = null

  // State
  private cryptoService: CryptoService
  private isGroupOwner = false
  private peers = new Map<string, { host: string; port: number }>() // userId → addr
  private activeConnections = new Map<string, ReturnType<typeof TcpSocket.createConnection>>()
  private server: ReturnType<typeof TcpSocket.createServer> | null = null
  private pendingAcks = new Map<string, (ok: boolean) => void>() // messageId → resolve
  private pendingPrekeys = new Map<
    string,
    (bundle: PreKeyBundleWire) => void
  >() // targetUserId → resolve
  private ourPreKeyBundleCache: PreKeyBundleWire | null = null
  private started = false

  constructor(
    private readonly userId: string,
    private readonly publicKey: string,
    private readonly deviceId: string,
  ) {
    this.cryptoService = new CryptoService(
      userId,
      deviceId,
      (targetUserId) => this.fetchPreKeyBundleFromPeer(targetUserId),
    )
  }

  async isAvailable(): Promise<boolean> {
    // WiFi Direct is Android-only; Platform check done at ConnectionManager level.
    // Always return true here — WifiP2p.initialize() will throw on unsupported platforms.
    try {
      await WifiP2p.initialize()
      return true
    } catch {
      return false
    }
  }

  async connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void> {
    this.onMessageCb = onMessage
    this.started = true

    // Pre-cache our own prekey bundle so we can respond to prekey_req quickly
    this.cryptoService
      .getOurPreKeyBundle()
      .then((b) => {
        this.ourPreKeyBundleCache = b
      })
      .catch(() => {})

    await WifiP2p.initialize()
    await WifiP2p.startDiscoveringPeers()

    WifiP2p.subscribeOnPeersUpdates(this.handlePeersUpdate)
    WifiP2p.subscribeOnConnectionInfoUpdates(this.handleConnectionInfo)
  }

  // ─── Event handlers ────────────────────────────────────────────────────────

  private handlePeersUpdate = (event: WDPeersEvent) => {
    const available = event.devices.filter((d) => d.status === 3)
    if (available.length > 0 && !this.isGroupOwner && this.activeConnections.size === 0) {
      // Auto-connect to the first available peer
      WifiP2p.connect(available[0]!.deviceAddress).catch(() => {})
    }
  }

  private handleConnectionInfo = (info: WDConnectionEvent) => {
    if (!info.groupFormed) return

    this.isGroupOwner = info.isGroupOwner

    if (info.isGroupOwner) {
      // Start TCP server — clients will connect to us
      this.startTCPServer()
    } else {
      // Connect to Group Owner
      this.connectTCPToPeer(GO_IP, TCP_PORT)
    }
  }

  // ─── TCP server (Group Owner) ──────────────────────────────────────────────

  private startTCPServer(): void {
    if (this.server) return

    this.server = TcpSocket.createServer((socket) => {
      let peerUserId: string | null = null
      let buffer = ''

      socket.on('data', (data: Buffer | string) => {
        buffer += typeof data === 'string' ? data : data.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const frame = JSON.parse(line) as DataFrame
            void this.handleFrame(frame, socket, peerUserId, (uid) => {
              peerUserId = uid
              this.activeConnections.set(uid, socket as ReturnType<typeof TcpSocket.createConnection>)
              this.peers.set(uid, { host: (socket as unknown as { remoteAddress?: string }).remoteAddress ?? GO_IP, port: TCP_PORT })
            })
          } catch { /* malformed frame */ }
        }
      })

      socket.on('error', () => {
        if (peerUserId) {
          this.activeConnections.delete(peerUserId)
          this.peers.delete(peerUserId)
        }
      })

      socket.on('close', () => {
        if (peerUserId) {
          this.activeConnections.delete(peerUserId)
        }
      })
    }).listen({ port: TCP_PORT, host: '0.0.0.0' })
  }

  // ─── TCP client (non-GO) ──────────────────────────────────────────────────

  private connectTCPToPeer(host: string, port: number): void {
    const socket = TcpSocket.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS })

    let peerUserId: string | null = null
    let buffer = ''
    let helloDone = false

    socket.on('connect', () => {
      // Send our Hello first
      const hello: HelloFrame = { type: 'hello', userId: this.userId, publicKey: this.publicKey }
      socket.write(JSON.stringify(hello) + '\n')
      helloDone = true
    })

    socket.on('data', (data: Buffer | string) => {
      buffer += typeof data === 'string' ? data : data.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const frame = JSON.parse(line) as DataFrame
          void this.handleFrame(frame, socket, peerUserId, (uid) => {
            peerUserId = uid
            this.activeConnections.set(uid, socket)
            this.peers.set(uid, { host, port })
          })
        } catch { /* malformed frame */ }
      }
    })

    socket.on('error', () => {
      if (peerUserId) {
        this.activeConnections.delete(peerUserId)
        this.peers.delete(peerUserId)
      }
    })

    socket.on('close', () => {
      if (peerUserId) {
        this.activeConnections.delete(peerUserId)
      }
      // Retry connection after a delay if we're still running
      if (this.started && !this.isGroupOwner) {
        setTimeout(() => this.connectTCPToPeer(host, port), 3000)
      }
    })

    void helloDone // suppress lint
  }

  // ─── Frame routing ────────────────────────────────────────────────────────

  private async handleFrame(
    frame: DataFrame,
    socket: ReturnType<typeof TcpSocket.createConnection>,
    currentPeerUserId: string | null,
    registerPeer: (userId: string) => void,
  ): Promise<void> {
    if (frame.type === 'hello') {
      if (frame.userId !== this.userId) {
        registerPeer(frame.userId)
        // Reply with our own Hello if we're the server (GO)
        if (this.isGroupOwner) {
          const reply: HelloFrame = { type: 'hello', userId: this.userId, publicKey: this.publicKey }
          socket.write(JSON.stringify(reply) + '\n')
        }
      }
      return
    }

    if (frame.type === 'prekey_req') {
      const bundle =
        this.ourPreKeyBundleCache ?? (await this.cryptoService.getOurPreKeyBundle())
      this.ourPreKeyBundleCache = bundle
      const resp: PrekeyRespFrame = { type: 'prekey_resp', bundle }
      socket.write(JSON.stringify(resp) + '\n')
      return
    }

    if (frame.type === 'prekey_resp') {
      const resolve = this.pendingPrekeys.get(currentPeerUserId ?? '')
      if (resolve) {
        this.pendingPrekeys.delete(currentPeerUserId ?? '')
        resolve(frame.bundle)
      }
      return
    }

    if (frame.type === 'message') {
      if (!currentPeerUserId) return
      try {
        const e2ee = JSON.parse(
          Buffer.from(frame.encryptedPayload, 'base64').toString('utf8'),
        ) as E2EEPayload
        const msg = await this.cryptoService.decrypt(currentPeerUserId, e2ee)
        this.onMessageCb?.(msg, currentPeerUserId)
        // Send ack
        const ack: AckFrame = { type: 'ack', messageId: frame.messageId }
        socket.write(JSON.stringify(ack) + '\n')
      } catch {
        console.warn('[wifi-direct] Gagal mendekripsi pesan')
      }
      return
    }

    if (frame.type === 'ack') {
      const resolve = this.pendingAcks.get(frame.messageId)
      if (resolve) {
        this.pendingAcks.delete(frame.messageId)
        resolve(true)
      }
      return
    }

    if (frame.type === 'typing') {
      if (currentPeerUserId) this.onTypingCb?.(currentPeerUserId, frame.isTyping)
      return
    }

    if (frame.type === 'read_receipt') {
      if (currentPeerUserId) this.onReadReceiptCb?.(currentPeerUserId, frame.messageId)
      return
    }
  }

  // ─── Prekey fetch via TCP ─────────────────────────────────────────────────

  private fetchPreKeyBundleFromPeer(targetUserId: string): Promise<PreKeyBundleWire> {
    return new Promise((resolve, reject) => {
      const socket = this.activeConnections.get(targetUserId)
      if (!socket) {
        reject(new Error(`WiFiDirectTransport: no connection to ${targetUserId}`))
        return
      }
      const timer = setTimeout(() => {
        this.pendingPrekeys.delete(targetUserId)
        reject(new Error('prekey_req timeout'))
      }, PREKEY_TIMEOUT_MS)

      this.pendingPrekeys.set(targetUserId, (bundle) => {
        clearTimeout(timer)
        resolve(bundle)
      })

      const req: PrekeyReqFrame = { type: 'prekey_req', fromUserId: this.userId }
      socket.write(JSON.stringify(req) + '\n')
    })
  }

  // ─── ITransport: send ─────────────────────────────────────────────────────

  async send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent> {
    const socket = this.activeConnections.get(targetUserId)
    if (!socket) {
      return { messageId: message.id, status: 'failed', transport: 'wifi_direct' }
    }

    try {
      const e2ee = await this.cryptoService.encryptFor(targetUserId, message)
      const encryptedPayload = Buffer.from(JSON.stringify(e2ee), 'utf8').toString('base64')

      const frame: MessageFrame = { type: 'message', messageId: message.id, encryptedPayload }

      return await new Promise<MessageDeliveryEvent>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingAcks.delete(message.id)
          resolve({ messageId: message.id, status: 'failed', transport: 'wifi_direct' })
        }, 10_000)

        this.pendingAcks.set(message.id, (_ok) => {
          clearTimeout(timer)
          resolve({ messageId: message.id, status: 'delivered', transport: 'wifi_direct' })
        })

        socket.write(JSON.stringify(frame) + '\n')
      })
    } catch {
      return { messageId: message.id, status: 'failed', transport: 'wifi_direct' }
    }
  }

  // ─── Typing & read receipt ────────────────────────────────────────────────

  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCb = cb
  }

  onReadReceipt(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCb = cb
  }

  sendTyping(targetUserId: string, isTyping: boolean): void {
    const socket = this.activeConnections.get(targetUserId)
    if (!socket) return
    const frame: TypingFrame = { type: 'typing', fromUserId: this.userId, isTyping }
    socket.write(JSON.stringify(frame) + '\n')
  }

  sendReadReceipt(targetUserId: string, messageId: string): void {
    const socket = this.activeConnections.get(targetUserId)
    if (!socket) return
    const frame: ReadReceiptFrame = { type: 'read_receipt', fromUserId: this.userId, messageId }
    socket.write(JSON.stringify(frame) + '\n')
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.started = false
    WifiP2p.unsubscribeFromPeersUpdates(this.handlePeersUpdate)
    WifiP2p.unsubscribeFromConnectionInfoUpdates(this.handleConnectionInfo)
    await WifiP2p.stopDiscoveringPeers().catch(() => {})
    await WifiP2p.disconnect().catch(() => {})

    for (const socket of this.activeConnections.values()) {
      socket.destroy()
    }
    this.activeConnections.clear()
    this.peers.clear()

    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}
