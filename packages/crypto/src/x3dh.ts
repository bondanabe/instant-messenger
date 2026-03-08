import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  dhExchange,
  generateDHKeyPair,
  verifySignature,
  identityToDHKeyPair,
  type DHKeyPair,
  type IdentityKeyPair,
  type PreKeyBundle,
} from './keys.js'

// ─────────────────────────────────────────────────────────────────
// X3DH — Extended Triple Diffie-Hellman (Signal Protocol)
// Ref: https://signal.org/docs/specifications/x3dh/
// ─────────────────────────────────────────────────────────────────

const X3DH_INFO = new TextEncoder().encode('IM-X3DH-v1')
// 32 bytes 0xFF — domain separation prefix (Signal spec, §3.3)
const F = new Uint8Array(32).fill(0xff)

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

// ─────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────

export interface X3DHSendResult {
  /** 32-byte session key — diteruskan ke initRatchetAsSender */
  sessionKey: Uint8Array
  /** Header yang dikirim bersama pesan pertama ke penerima */
  initHeader: X3DHInitHeader
}

export interface X3DHInitHeader {
  /** Ed25519 identity public key pengirim (32 bytes) */
  senderIdentityKey: Uint8Array
  /** X25519 identity public key pengirim (32 bytes) */
  senderIdentityKeyX25519: Uint8Array
  /** X25519 ephemeral public key (32 bytes) */
  ephemeralPublicKey: Uint8Array
  /** ID signed prekey penerima yang digunakan */
  signedPreKeyId: number
  /** ID one-time prekey penerima yang dikonsumsi (jika ada) */
  oneTimePreKeyId?: number | undefined
}

// ─────────────────────────────────────────────────────────────────
// INITIATOR (Alice)
// ─────────────────────────────────────────────────────────────────

/**
 * X3DH sisi pengirim (Alice).
 * Verifikasi bundle Bob, kompute 3–4 DH, derive session key.
 *
 * @throws jika signature signed prekey tidak valid
 */
export function x3dhInitiate(
  ourIdentityKeyPair: IdentityKeyPair,
  theirBundle: PreKeyBundle,
): X3DHSendResult {
  if (
    !verifySignature(
      theirBundle.identityKey,
      theirBundle.signedPreKey,
      theirBundle.signedPreKeySignature,
    )
  ) {
    throw new Error('X3DH: signed prekey signature tidak valid — bundle mungkin dimanipulasi')
  }

  const ourDHKeyPair = identityToDHKeyPair(ourIdentityKeyPair)
  const ephKey = generateDHKeyPair()

  // DH1 = DH(IK_A_x25519, SPK_B)
  const dh1 = dhExchange(ourDHKeyPair.privateKey, theirBundle.signedPreKey)
  // DH2 = DH(EK_A, IK_B_x25519)
  const dh2 = dhExchange(ephKey.privateKey, theirBundle.identityKeyX25519)
  // DH3 = DH(EK_A, SPK_B)
  const dh3 = dhExchange(ephKey.privateKey, theirBundle.signedPreKey)

  const ikmParts: Uint8Array[] = [F, dh1, dh2, dh3]
  if (theirBundle.oneTimePreKey) {
    // DH4 = DH(EK_A, OPK_B)
    ikmParts.push(dhExchange(ephKey.privateKey, theirBundle.oneTimePreKey))
  }

  const sessionKey = hkdf(sha256, concat(...ikmParts), undefined, X3DH_INFO, 32)

  return {
    sessionKey,
    initHeader: {
      senderIdentityKey: ourIdentityKeyPair.publicKey,
      senderIdentityKeyX25519: ourDHKeyPair.publicKey,
      ephemeralPublicKey: ephKey.publicKey,
      signedPreKeyId: theirBundle.signedPreKeyId,
      oneTimePreKeyId: theirBundle.oneTimePreKeyId,
    },
  }
}

// ─────────────────────────────────────────────────────────────────
// RESPONDER (Bob)
// ─────────────────────────────────────────────────────────────────

export interface X3DHRespondParams {
  ourIdentityKeyPair: IdentityKeyPair
  ourSignedPreKeyPair: DHKeyPair
  /** Jika one-time prekey digunakan, sertakan keypair-nya */
  ourOneTimePreKeyPair?: DHKeyPair
  initHeader: X3DHInitHeader
}

/**
 * X3DH sisi penerima (Bob).
 * Compute DH yang sama dengan Alice untuk mendapatkan session key yang identik.
 */
export function x3dhRespond(params: X3DHRespondParams): Uint8Array {
  const { ourIdentityKeyPair, ourSignedPreKeyPair, ourOneTimePreKeyPair, initHeader } = params
  const ourDHKeyPair = identityToDHKeyPair(ourIdentityKeyPair)

  // DH1 = DH(SPK_B, IK_A_x25519) — simetri dengan DH(IK_A_x25519, SPK_B)
  const dh1 = dhExchange(ourSignedPreKeyPair.privateKey, initHeader.senderIdentityKeyX25519)
  // DH2 = DH(IK_B_x25519, EK_A)
  const dh2 = dhExchange(ourDHKeyPair.privateKey, initHeader.ephemeralPublicKey)
  // DH3 = DH(SPK_B, EK_A)
  const dh3 = dhExchange(ourSignedPreKeyPair.privateKey, initHeader.ephemeralPublicKey)

  const ikmParts: Uint8Array[] = [F, dh1, dh2, dh3]
  if (ourOneTimePreKeyPair && initHeader.oneTimePreKeyId !== undefined) {
    // DH4 = DH(OPK_B, EK_A)
    ikmParts.push(dhExchange(ourOneTimePreKeyPair.privateKey, initHeader.ephemeralPublicKey))
  }

  return hkdf(sha256, concat(...ikmParts), undefined, X3DH_INFO, 32)
}
