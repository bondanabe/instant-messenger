import {
  ed25519,
  x25519,
  edwardsToMontgomeryPriv,
  edwardsToMontgomeryPub,
} from '@noble/curves/ed25519'

// ─────────────────────────────────────────────────────────────────
// KEY TYPES
// ─────────────────────────────────────────────────────────────────

/** Ed25519 keypair — digunakan untuk signing (identitas) */
export interface IdentityKeyPair {
  /** Ed25519 public key — 32 bytes */
  publicKey: Uint8Array
  /** Ed25519 private key — 32 bytes */
  privateKey: Uint8Array
}

/** X25519 keypair — digunakan untuk Diffie-Hellman key exchange */
export interface DHKeyPair {
  /** X25519 public key — 32 bytes */
  publicKey: Uint8Array
  /** X25519 private key — 32 bytes */
  privateKey: Uint8Array
}

/**
 * PreKey bundle — kumpulan public key yang dibagikan ke kontak lain.
 * Digunakan saat inisiasi sesi X3DH.
 * HANYA berisi public key — private key tidak pernah meninggalkan device.
 */
export interface PreKeyBundle {
  userId: string
  deviceId: string
  /** Ed25519 identity public key (32 bytes) */
  identityKey: Uint8Array
  /** X25519 identity public key — diderivasi dari Ed25519 (32 bytes) */
  identityKeyX25519: Uint8Array
  /** ID untuk signed prekey yang aktif */
  signedPreKeyId: number
  /** X25519 signed prekey public key (32 bytes) */
  signedPreKey: Uint8Array
  /** Ed25519 signature dari signedPreKey.publicKey (64 bytes) */
  signedPreKeySignature: Uint8Array
  /** ID satu one-time prekey yang dikirim dalam bundle (opsional) */
  oneTimePreKeyId?: number
  /** X25519 one-time prekey public key (32 bytes) — digunakan sekali, lalu dibuang */
  oneTimePreKey?: Uint8Array
}

// ─────────────────────────────────────────────────────────────────
// KEY GENERATION
// ─────────────────────────────────────────────────────────────────

/** Generate keypair Ed25519 untuk identitas. */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const privateKey = ed25519.utils.randomPrivateKey()
  const publicKey = ed25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** Generate keypair X25519 untuk DH key exchange. */
export function generateDHKeyPair(): DHKeyPair {
  const privateKey = x25519.utils.randomPrivateKey()
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

/** Konversi Ed25519 keypair → X25519 keypair via birational equivalence. */
export function identityToDHKeyPair(kp: IdentityKeyPair): DHKeyPair {
  return {
    privateKey: edwardsToMontgomeryPriv(kp.privateKey),
    publicKey: edwardsToMontgomeryPub(kp.publicKey),
  }
}

// ─────────────────────────────────────────────────────────────────
// SIGNING
// ─────────────────────────────────────────────────────────────────

/** Sign data dengan Ed25519 private key. Hasilnya 64 bytes. */
export function signBytes(privateKey: Uint8Array, data: Uint8Array): Uint8Array {
  return ed25519.sign(data, privateKey)
}

/** Verifikasi Ed25519 signature. */
export function verifySignature(
  publicKey: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, data, publicKey)
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────
// DIFFIE-HELLMAN
// ─────────────────────────────────────────────────────────────────

/** X25519 Diffie-Hellman: output 32-byte shared secret. */
export function dhExchange(privateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, theirPublicKey)
}
