import { hmac } from '@noble/hashes/hmac'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { generateDHKeyPair, dhExchange, type DHKeyPair } from './keys.js'
import { encryptWithMessageKey, decryptWithMessageKey } from './cipher.js'

// ─────────────────────────────────────────────────────────────────
// DOUBLE RATCHET — Signal Protocol
// Ref: https://signal.org/docs/specifications/doubleratchet/
// ─────────────────────────────────────────────────────────────────

const RK_INFO = new TextEncoder().encode('IM-DR-RatchetKey-v1')

/** Batas pesan yang bisa dilewati tanpa memutus sesi (anti-DoS) */
const MAX_SKIP = 1000

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export interface RatchetHeader {
  /** X25519 DH ratchet public key pengirim (32 bytes) */
  dhPublicKey: Uint8Array
  /** Jumlah pesan di sending chain sebelumnya */
  prevChainCount: number
  /** Nomor pesan di current sending chain */
  messageNumber: number
}

export interface RatchetMessage {
  header: RatchetHeader
  /** Ciphertext = AES-256-GCM(plaintext) termasuk 16-byte GCM tag */
  ciphertext: Uint8Array
}

export interface RatchetState {
  rootKey: Uint8Array
  sendChainKey: Uint8Array | null
  recvChainKey: Uint8Array | null
  sendDHKey: DHKeyPair
  recvDHKey: Uint8Array | null
  sendMessageN: number
  recvMessageN: number
  prevSendChainN: number
  /** 'hex(dhKey):msgNumber' → message key */
  skippedMessageKeys: Map<string, Uint8Array>
}

// ─────────────────────────────────────────────────────────────────
// KDF primitives
// ─────────────────────────────────────────────────────────────────

/** KDF chain step: [new_chain_key, message_key] = HMAC(ck, 0x02/0x01) */
function kdfChain(ck: Uint8Array): [chainKey: Uint8Array, messageKey: Uint8Array] {
  return [
    hmac(sha256, ck, new Uint8Array([0x02])),
    hmac(sha256, ck, new Uint8Array([0x01])),
  ]
}

/** KDF root step: [new_root_key, new_chain_key] = HKDF(rk, dh_out) */
function kdfRoot(rk: Uint8Array, dhOut: Uint8Array): [rootKey: Uint8Array, chainKey: Uint8Array] {
  const out = hkdf(sha256, dhOut, rk, RK_INFO, 64)
  return [out.slice(0, 32), out.slice(32, 64)]
}

// ─────────────────────────────────────────────────────────────────
// SESSION INIT
// ─────────────────────────────────────────────────────────────────

/**
 * Inisialisasi ratchet sebagai pengirim (Alice).
 * Dipanggil setelah X3DH dengan session key dan Bob's SPK public key.
 */
export function initRatchetAsSender(
  sessionKey: Uint8Array,
  theirRatchetPublicKey: Uint8Array,
): RatchetState {
  const ourDHKey = generateDHKeyPair()
  const dhOut = dhExchange(ourDHKey.privateKey, theirRatchetPublicKey)
  const [rootKey, sendChainKey] = kdfRoot(sessionKey, dhOut)

  return {
    rootKey,
    sendChainKey,
    recvChainKey: null,
    sendDHKey: ourDHKey,
    recvDHKey: theirRatchetPublicKey,
    sendMessageN: 0,
    recvMessageN: 0,
    prevSendChainN: 0,
    skippedMessageKeys: new Map(),
  }
}

/**
 * Inisialisasi ratchet sebagai penerima (Bob).
 * Dipanggil setelah X3DH respond dengan session key dan signed prekey kita.
 */
export function initRatchetAsReceiver(
  sessionKey: Uint8Array,
  ourSignedPreKey: DHKeyPair,
): RatchetState {
  return {
    rootKey: sessionKey,
    sendChainKey: null,
    recvChainKey: null,
    sendDHKey: ourSignedPreKey,
    recvDHKey: null,
    sendMessageN: 0,
    recvMessageN: 0,
    prevSendChainN: 0,
    skippedMessageKeys: new Map(),
  }
}

// ─────────────────────────────────────────────────────────────────
// ENCRYPT / DECRYPT
// ─────────────────────────────────────────────────────────────────

/** Enkripsi plaintext. Kembalikan state baru + RatchetMessage untuk dikirim. */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array,
): { state: RatchetState; message: RatchetMessage } {
  if (!state.sendChainKey) {
    throw new Error('Double Ratchet: tidak ada send chain key — sesi belum terinisialisasi')
  }

  const [newChainKey, mk] = kdfChain(state.sendChainKey)
  const header: RatchetHeader = {
    dhPublicKey: state.sendDHKey.publicKey,
    prevChainCount: state.prevSendChainN,
    messageNumber: state.sendMessageN,
  }
  const headerBytes = encodeHeader(header)
  const ciphertext = encryptWithMessageKey(mk, plaintext, concat(ad, headerBytes))

  return {
    state: { ...state, sendChainKey: newChainKey, sendMessageN: state.sendMessageN + 1 },
    message: { header, ciphertext },
  }
}

/** Dekripsi RatchetMessage. Kembalikan state baru + plaintext. */
export function ratchetDecrypt(
  state: RatchetState,
  message: RatchetMessage,
  ad: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  const headerBytes = encodeHeader(message.header)
  const aad = concat(ad, headerBytes)

  // 1. Cek skipped message keys dulu
  const skipKey = `${toHex(message.header.dhPublicKey)}:${message.header.messageNumber}`
  const skippedMk = state.skippedMessageKeys.get(skipKey)
  if (skippedMk) {
    const plaintext = decryptWithMessageKey(skippedMk, message.ciphertext, aad)
    const newSkipped = new Map(state.skippedMessageKeys)
    newSkipped.delete(skipKey)
    return { state: { ...state, skippedMessageKeys: newSkipped }, plaintext }
  }

  let s = state

  // 2. DH ratchet baru? Advance root + chains
  if (!bufEqual(s.recvDHKey, message.header.dhPublicKey)) {
    s = skipMessageKeys(s, message.header.prevChainCount, ad)
    s = dhRatchetStep(s, message.header.dhPublicKey)
  }

  // 3. Skip ke message number yang benar
  s = skipMessageKeys(s, message.header.messageNumber, ad)

  // 4. Decrypt dengan chain key saat ini
  const [newChainKey, mk] = kdfChain(s.recvChainKey!)
  const plaintext = decryptWithMessageKey(mk, message.ciphertext, aad)

  return {
    state: { ...s, recvChainKey: newChainKey, recvMessageN: message.header.messageNumber + 1 },
    plaintext,
  }
}

// ─────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────

function dhRatchetStep(state: RatchetState, theirNewDHKey: Uint8Array): RatchetState {
  const prevSendChainN = state.sendMessageN

  // Advance receiving chain
  const dhOut1 = dhExchange(state.sendDHKey.privateKey, theirNewDHKey)
  const [rootKey1, recvChainKey] = kdfRoot(state.rootKey, dhOut1)

  // Generate new sending DH key + advance sending chain
  const newSendDHKey = generateDHKeyPair()
  const dhOut2 = dhExchange(newSendDHKey.privateKey, theirNewDHKey)
  const [rootKey2, sendChainKey] = kdfRoot(rootKey1, dhOut2)

  return {
    ...state,
    rootKey: rootKey2,
    sendChainKey,
    recvChainKey,
    sendDHKey: newSendDHKey,
    recvDHKey: theirNewDHKey,
    sendMessageN: 0,
    recvMessageN: 0,
    prevSendChainN,
  }
}

function skipMessageKeys(state: RatchetState, until: number, _ad: Uint8Array): RatchetState {
  if (!state.recvChainKey || state.recvMessageN >= until) return state
  if (until - state.recvMessageN > MAX_SKIP) {
    throw new Error(`Double Ratchet: terlalu banyak pesan terlewat (${until - state.recvMessageN})`)
  }

  let ck = state.recvChainKey
  const newSkipped = new Map(state.skippedMessageKeys)
  const dhHex = state.recvDHKey ? toHex(state.recvDHKey) : 'null'

  for (let i = state.recvMessageN; i < until; i++) {
    const [newCk, mk] = kdfChain(ck)
    newSkipped.set(`${dhHex}:${i}`, mk)
    ck = newCk
  }

  return { ...state, recvChainKey: ck, skippedMessageKeys: newSkipped }
}

function bufEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

/** Header encoding: [32B dhPubKey][4B prevChainCount BE][4B messageNumber BE] */
function encodeHeader(header: RatchetHeader): Uint8Array {
  const out = new Uint8Array(40)
  out.set(header.dhPublicKey, 0)
  const view = new DataView(out.buffer)
  view.setUint32(32, header.prevChainCount, false)
  view.setUint32(36, header.messageNumber, false)
  return out
}

// ─────────────────────────────────────────────────────────────────
// SERIALIZATION — persistensi sesi ke SQLite
// ─────────────────────────────────────────────────────────────────

interface SerializedState {
  rk: string
  sck: string | null
  rck: string | null
  sdp: string
  sdu: string
  rdk: string | null
  sn: number
  rn: number
  pn: number
  sk: Record<string, string>
}

function h(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function u(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < hex.length; i += 2) b[i >> 1] = parseInt(hex.slice(i, i + 2), 16)
  return b
}

/** Serialize RatchetState ke Uint8Array (JSON) untuk disimpan ke SQLite */
export function serializeRatchetState(state: RatchetState): Uint8Array {
  const sk: Record<string, string> = {}
  state.skippedMessageKeys.forEach((v, k) => {
    sk[k] = h(v)
  })
  const obj: SerializedState = {
    rk: h(state.rootKey),
    sck: state.sendChainKey ? h(state.sendChainKey) : null,
    rck: state.recvChainKey ? h(state.recvChainKey) : null,
    sdp: h(state.sendDHKey.privateKey),
    sdu: h(state.sendDHKey.publicKey),
    rdk: state.recvDHKey ? h(state.recvDHKey) : null,
    sn: state.sendMessageN,
    rn: state.recvMessageN,
    pn: state.prevSendChainN,
    sk,
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Deserialize RatchetState dari SQLite blob */
export function deserializeRatchetState(data: Uint8Array): RatchetState {
  const obj = JSON.parse(new TextDecoder().decode(data)) as SerializedState
  const skipped = new Map<string, Uint8Array>()
  Object.entries(obj.sk).forEach(([k, v]) => skipped.set(k, u(v)))
  return {
    rootKey: u(obj.rk),
    sendChainKey: obj.sck ? u(obj.sck) : null,
    recvChainKey: obj.rck ? u(obj.rck) : null,
    sendDHKey: { privateKey: u(obj.sdp), publicKey: u(obj.sdu) },
    recvDHKey: obj.rdk ? u(obj.rdk) : null,
    sendMessageN: obj.sn,
    recvMessageN: obj.rn,
    prevSendChainN: obj.pn,
    skippedMessageKeys: skipped,
  }
}
