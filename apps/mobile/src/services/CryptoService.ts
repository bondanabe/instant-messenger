import { eq, and, isNull } from 'drizzle-orm'
import {
  signalSessions,
  prekeys as prekeysTable,
  identity as identityTable,
} from '@im/db-schema'
import {
  identityToDHKeyPair,
  x3dhInitiate,
  x3dhRespond,
  initRatchetAsSender,
  initRatchetAsReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchetState,
  deserializeRatchetState,
  type IdentityKeyPair,
  type DHKeyPair,
  type PreKeyBundle,
  type RatchetState,
  type X3DHInitHeader,
} from '@im/crypto'
import type { E2EEPayload, E2EEX3DHHeader, PreKeyBundleWire, WireMessage } from '@im/core'
import { getDatabase } from '../db'

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

function b64(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64')
}

function fromb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

function toBlob(data: ArrayBuffer | Uint8Array | null | undefined): Uint8Array | null {
  if (!data) return null
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}

// ─────────────────────────────────────────────────────────────────
// CRYPTO SERVICE
// ─────────────────────────────────────────────────────────────────

/**
 * Mengelola semua operasi kriptografi E2EE.
 * - Inisiasi sesi X3DH + Double Ratchet
 * - Enkripsi/dekripsi pesan
 * - Persistensi sesi ke SQLite
 */
export class CryptoService {
  private identityCache: IdentityKeyPair | null = null

  constructor(
    private readonly userId: string,
    private readonly deviceId: string,
    /** Callback untuk mengambil PreKeyBundle kontak dari transport (relay/BLE) */
    private readonly fetchRemoteBundle: (targetUserId: string) => Promise<PreKeyBundleWire>,
  ) {}

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Buat PreKeyBundle kita sendiri untuk dipublikasikan ke relay.
   * Hanya berisi public keys — private keys tidak pernah keluar.
   */
  async getOurPreKeyBundle(): Promise<PreKeyBundleWire> {
    const db = getDatabase()
    const identity = await this.loadIdentity()
    const dhKeyPair = identityToDHKeyPair(identity)

    // Ambil signed prekey yang masih aktif
    const spkRows = await db
      .select()
      .from(prekeysTable)
      .where(and(eq(prekeysTable.keyType, 'signed_prekey'), isNull(prekeysTable.usedAt)))
      .limit(1)

    if (!spkRows[0]) throw new Error('CryptoService: tidak ada signed prekey tersedia')
    const spk = spkRows[0]

    // Ambil satu one-time prekey yang tersedia
    const opkRows = await db
      .select()
      .from(prekeysTable)
      .where(and(eq(prekeysTable.keyType, 'one_time_prekey'), isNull(prekeysTable.usedAt)))
      .limit(1)
    const opk = opkRows[0]

    return {
      userId: this.userId,
      deviceId: this.deviceId,
      identityKey: b64(identity.publicKey),
      identityKeyX25519: b64(dhKeyPair.publicKey),
      signedPreKeyId: spk.id,
      signedPreKey: b64(toBlob(spk.publicKey as ArrayBuffer)!),
      signedPreKeySignature: b64(toBlob(spk.signature as ArrayBuffer)!),
      oneTimePreKeyId: opk?.id,
      oneTimePreKey: opk ? b64(toBlob(opk.publicKey as ArrayBuffer)!) : undefined,
    }
  }

  /**
   * Enkripsi WireMessage untuk targetUserId.
   * Secara otomatis:
   * - Jika sesi belum ada: jalankan X3DH, init Double Ratchet
   * - Jika sesi sudah ada: lanjutkan ratchet
   */
  async encryptFor(targetUserId: string, wireMessage: WireMessage): Promise<E2EEPayload> {
    const db = getDatabase()
    let session = await this.loadSession(targetUserId)
    let x3dhHeader: E2EEX3DHHeader | undefined

    if (!session) {
      // Sesi baru — ambil bundle dan jalankan X3DH
      const bundleWire = await this.fetchRemoteBundle(targetUserId)
      const bundle = this.wireToBundle(bundleWire)
      const identity = await this.loadIdentity()

      const { sessionKey, initHeader } = x3dhInitiate(identity, bundle)
      session = initRatchetAsSender(sessionKey, bundle.signedPreKey)

      x3dhHeader = {
        senderIdentityKey: b64(initHeader.senderIdentityKey),
        senderIdentityKeyX25519: b64(initHeader.senderIdentityKeyX25519),
        ephemeralPublicKey: b64(initHeader.ephemeralPublicKey),
        signedPreKeyId: initHeader.signedPreKeyId,
        oneTimePreKeyId: initHeader.oneTimePreKeyId,
      }

      // Tandai one-time prekey sebagai sudah dikonsumsi
      if (bundle.oneTimePreKeyId !== undefined) {
        await db
          .update(prekeysTable)
          .set({ usedAt: Date.now() })
          .where(eq(prekeysTable.id, bundle.oneTimePreKeyId))
      }
    }

    const plaintext = new TextEncoder().encode(JSON.stringify(wireMessage))
    const ad = new TextEncoder().encode(`${this.userId}→${targetUserId}`)
    const { state: newState, message } = ratchetEncrypt(session, plaintext, ad)

    await this.saveSession(targetUserId, newState)

    return {
      x3dh: x3dhHeader,
      header: {
        dhPublicKey: b64(message.header.dhPublicKey),
        prevChainCount: message.header.prevChainCount,
        messageNumber: message.header.messageNumber,
      },
      ciphertext: b64(message.ciphertext),
    }
  }

  /**
   * Dekripsi E2EEPayload dari fromUserId.
   * Secara otomatis:
   * - Jika ada X3DH header dan sesi belum ada: respond X3DH, init Double Ratchet
   * - Selanjutnya: advance ratchet dan decrypt
   */
  async decrypt(fromUserId: string, payload: E2EEPayload): Promise<WireMessage> {
    const db = getDatabase()
    let session = await this.loadSession(fromUserId)

    if (!session && payload.x3dh) {
      // Sesi baru dimulai oleh pengirim — respond X3DH
      const x3dhHdr: X3DHInitHeader = {
        senderIdentityKey: fromb64(payload.x3dh.senderIdentityKey),
        senderIdentityKeyX25519: fromb64(payload.x3dh.senderIdentityKeyX25519),
        ephemeralPublicKey: fromb64(payload.x3dh.ephemeralPublicKey),
        signedPreKeyId: payload.x3dh.signedPreKeyId,
        oneTimePreKeyId: payload.x3dh.oneTimePreKeyId,
      }

      // Load signed prekey kita yang digunakan
      const spkRows = await db
        .select()
        .from(prekeysTable)
        .where(eq(prekeysTable.id, x3dhHdr.signedPreKeyId))
        .limit(1)

      if (!spkRows[0]) {
        throw new Error(`CryptoService: signed prekey #${x3dhHdr.signedPreKeyId} tidak ditemukan`)
      }

      const spkPair: DHKeyPair = {
        privateKey: toBlob(spkRows[0].privateKey as ArrayBuffer)!,
        publicKey: toBlob(spkRows[0].publicKey as ArrayBuffer)!,
      }

      // Load one-time prekey jika digunakan
      let opkPair: DHKeyPair | undefined
      if (x3dhHdr.oneTimePreKeyId !== undefined) {
        const opkRows = await db
          .select()
          .from(prekeysTable)
          .where(eq(prekeysTable.id, x3dhHdr.oneTimePreKeyId))
          .limit(1)

        if (opkRows[0]) {
          opkPair = {
            privateKey: toBlob(opkRows[0].privateKey as ArrayBuffer)!,
            publicKey: toBlob(opkRows[0].publicKey as ArrayBuffer)!,
          }
          // Konsumsi one-time prekey
          await db
            .update(prekeysTable)
            .set({ usedAt: Date.now() })
            .where(eq(prekeysTable.id, x3dhHdr.oneTimePreKeyId))
        }
      }

      const identity = await this.loadIdentity()
      const sessionKey = x3dhRespond({
        ourIdentityKeyPair: identity,
        ourSignedPreKeyPair: spkPair,
        ourOneTimePreKeyPair: opkPair,
        initHeader: x3dhHdr,
      })

      session = initRatchetAsReceiver(sessionKey, spkPair)
    }

    if (!session) {
      throw new Error(`CryptoService: tidak ada sesi untuk ${fromUserId} dan tidak ada X3DH header`)
    }

    const message = {
      header: {
        dhPublicKey: fromb64(payload.header.dhPublicKey),
        prevChainCount: payload.header.prevChainCount,
        messageNumber: payload.header.messageNumber,
      },
      ciphertext: fromb64(payload.ciphertext),
    }

    const ad = new TextEncoder().encode(`${fromUserId}→${this.userId}`)
    const { state: newState, plaintext } = ratchetDecrypt(session, message, ad)

    await this.saveSession(fromUserId, newState)

    return JSON.parse(new TextDecoder().decode(plaintext)) as WireMessage
  }

  // ── Private helpers ─────────────────────────────────────────────

  private wireToBundle(wire: PreKeyBundleWire): PreKeyBundle {
    return {
      userId: wire.userId,
      deviceId: wire.deviceId,
      identityKey: fromb64(wire.identityKey),
      identityKeyX25519: fromb64(wire.identityKeyX25519),
      signedPreKeyId: wire.signedPreKeyId,
      signedPreKey: fromb64(wire.signedPreKey),
      signedPreKeySignature: fromb64(wire.signedPreKeySignature),
      oneTimePreKeyId: wire.oneTimePreKeyId,
      oneTimePreKey: wire.oneTimePreKey ? fromb64(wire.oneTimePreKey) : undefined,
    }
  }

  private async loadIdentity(): Promise<IdentityKeyPair> {
    if (this.identityCache) return this.identityCache
    const db = getDatabase()
    const rows = await db.select().from(identityTable).limit(1)
    if (!rows[0]) throw new Error('CryptoService: identitas tidak ditemukan di database')
    this.identityCache = {
      privateKey: toBlob(rows[0].privateKey as ArrayBuffer)!,
      publicKey: toBlob(rows[0].publicKey as ArrayBuffer)!,
    }
    return this.identityCache
  }

  private async loadSession(userId: string): Promise<RatchetState | null> {
    const db = getDatabase()
    const rows = await db
      .select()
      .from(signalSessions)
      .where(and(eq(signalSessions.userId, userId), eq(signalSessions.deviceId, 'default')))
      .limit(1)

    if (!rows[0]) return null
    return deserializeRatchetState(toBlob(rows[0].sessionData as ArrayBuffer)!)
  }

  private async saveSession(userId: string, state: RatchetState): Promise<void> {
    const db = getDatabase()
    const sessionData = serializeRatchetState(state)

    await db
      .insert(signalSessions)
      .values({
        userId,
        deviceId: 'default',
        sessionData,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [signalSessions.userId, signalSessions.deviceId],
        set: { sessionData, updatedAt: Date.now() },
      })
  }
}
