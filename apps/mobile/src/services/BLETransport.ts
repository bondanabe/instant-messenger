import { BleManager, type Device } from 'react-native-ble-plx'
import type { ITransport, WireMessage, MessageDeliveryEvent, E2EEPayload, PreKeyBundleWire } from '@im/core'
import { Buffer } from 'buffer'
import { CryptoService } from './CryptoService'

// UUID untuk service dan characteristic BLE
// Harus sama di semua device (generate once, hardcode)
const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0'
const CHAR_MESSAGE_UUID = '12345678-1234-5678-1234-56789abcdef1'
const CHAR_USER_ID_UUID = '12345678-1234-5678-1234-56789abcdef2'
const CHAR_PREKEY_UUID = '12345678-1234-5678-1234-56789abcdef3'  // baru: prekey bundle
const CHAR_CONTROL_UUID = '12345678-1234-5678-1234-56789abcdef4' // typing & read receipt

const BLE_SCAN_TIMEOUT_MS = 10_000
const BLE_MTU = 512  // bytes per BLE packet

export class BLETransport implements ITransport {
  readonly mode = 'bluetooth' as const
  private manager: BleManager = new BleManager()
  private connectedDevices = new Map<string, Device>()  // userId → BLE Device
  private deviceUserIdMap = new Map<string, string>()   // BLE deviceId → userId
  private onMessageCb: ((msg: WireMessage, fromUserId: string) => void) | null = null
  private onTypingCb: ((fromUserId: string, isTyping: boolean) => void) | null = null
  private onReadReceiptCb: ((fromUserId: string, messageId: string) => void) | null = null
  private cryptoService: CryptoService

  constructor(
    private readonly userId: string,
    private readonly deviceId: string,
  ) {
    this.cryptoService = new CryptoService(
      userId,
      deviceId,
      (targetUserId) => this.fetchPreKeyBundleFromBLE(targetUserId),
    )
  }

  private async fetchPreKeyBundleFromBLE(targetUserId: string): Promise<PreKeyBundleWire> {
    const device = this.connectedDevices.get(targetUserId)
    if (!device) throw new Error(`BLETransport: device ${targetUserId} tidak terhubung`)
    const char = await device.readCharacteristicForService(SERVICE_UUID, CHAR_PREKEY_UUID)
    return JSON.parse(Buffer.from(char.value ?? '', 'base64').toString('utf8')) as PreKeyBundleWire
  }

  async isAvailable(): Promise<boolean> {
    const state = await this.manager.state()
    return state === 'PoweredOn'
  }

  async connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void> {
    this.onMessageCb = onMessage
    await this.startScanning()
  }

  private async startScanning(): Promise<void> {
    const available = await this.isAvailable()
    if (!available) return

    this.manager.startDeviceScan([SERVICE_UUID], null, async (error, device) => {
      if (error || !device) return

      try {
        const connected = await device.connect()
        await connected.discoverAllServicesAndCharacteristics()

        // Ambil userId dari characteristic
        const char = await connected.readCharacteristicForService(
          SERVICE_UUID,
          CHAR_USER_ID_UUID,
        )
        const peerUserId = Buffer.from(char.value ?? '', 'base64').toString('utf8')

        if (peerUserId && peerUserId !== this.userId) {
          this.connectedDevices.set(peerUserId, connected)
          this.deviceUserIdMap.set(device.id, peerUserId)

          // Monitor incoming messages — E2EE decrypt
          connected.monitorCharacteristicForService(
            SERVICE_UUID,
            CHAR_MESSAGE_UUID,
            (err, c) => {
              if (err || !c?.value) return
              void (async () => {
                try {
                  const json = Buffer.from(c.value!, 'base64').toString('utf8')
                  const e2ee = JSON.parse(json) as E2EEPayload
                  const msg = await this.cryptoService.decrypt(peerUserId, e2ee)
                  this.onMessageCb?.(msg, peerUserId)
                } catch {
                  console.warn('[ble] Gagal mendekripsi pesan masuk')
                }
              })()
            },
          )

          // Monitor control frames (typing + read receipt)
          connected.monitorCharacteristicForService(
            SERVICE_UUID,
            CHAR_CONTROL_UUID,
            (err, c) => {
              if (err || !c?.value) return
              try {
                const frame = JSON.parse(
                  Buffer.from(c.value!, 'base64').toString('utf8'),
                ) as
                  | { type: 'typing'; isTyping: boolean }
                  | { type: 'read_receipt'; messageId: string }
                if (frame.type === 'typing') this.onTypingCb?.(peerUserId, frame.isTyping)
                else if (frame.type === 'read_receipt')
                  this.onReadReceiptCb?.(peerUserId, frame.messageId)
              } catch { /* ignore */ }
            },
          )

          console.log(`[ble] Connected to peer: ${peerUserId}`)
        }
      } catch {
        // Device tidak kompatibel atau gagal handshake
      }
    })
  }

  async send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent> {
    const device = this.connectedDevices.get(targetUserId)
    if (!device) {
      return { messageId: message.id, status: 'failed', transport: 'bluetooth' }
    }

    try {
      // E2EE enkripsi sebelum kirim
      const e2ee = await this.cryptoService.encryptFor(targetUserId, message)
      const json = JSON.stringify(e2ee)
      const payload = Buffer.from(json, 'utf8')
      const chunks = Math.ceil(payload.length / BLE_MTU)

      for (let i = 0; i < chunks; i++) {
        const chunk = payload.subarray(i * BLE_MTU, (i + 1) * BLE_MTU)
        await device.writeCharacteristicWithResponseForService(
          SERVICE_UUID,
          CHAR_MESSAGE_UUID,
          chunk.toString('base64'),
        )
      }

      return { messageId: message.id, status: 'delivered', transport: 'bluetooth' }
    } catch {
      this.connectedDevices.delete(targetUserId)
      return { messageId: message.id, status: 'failed', transport: 'bluetooth' }
    }
  }

  onTyping(cb: (fromUserId: string, isTyping: boolean) => void): void {
    this.onTypingCb = cb
  }

  onReadReceipt(cb: (fromUserId: string, messageId: string) => void): void {
    this.onReadReceiptCb = cb
  }

  sendTyping(targetUserId: string, isTyping: boolean): void {
    const device = this.connectedDevices.get(targetUserId)
    if (!device) return
    const payload = Buffer.from(
      JSON.stringify({ type: 'typing', isTyping }),
      'utf8',
    ).toString('base64')
    device
      .writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_CONTROL_UUID, payload)
      .catch(() => {})
  }

  sendReadReceipt(targetUserId: string, messageId: string): void {
    const device = this.connectedDevices.get(targetUserId)
    if (!device) return
    const payload = Buffer.from(
      JSON.stringify({ type: 'read_receipt', messageId }),
      'utf8',
    ).toString('base64')
    device
      .writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_CONTROL_UUID, payload)
      .catch(() => {})
  }

  async disconnect(): Promise<void> {
    this.manager.stopDeviceScan()
    for (const device of this.connectedDevices.values()) {
      await device.cancelConnection().catch(() => null)
    }
    this.connectedDevices.clear()
    this.deviceUserIdMap.clear()
    this.manager.destroy()
  }
}
