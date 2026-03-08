import { gcm } from '@noble/ciphers/aes'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

// ─────────────────────────────────────────────────────────────────
// CIPHER — AES-256-GCM dengan message key dari Double Ratchet
// ─────────────────────────────────────────────────────────────────

const MESSAGE_KEY_INFO = new TextEncoder().encode('IM-DR-MessageKey-v1')

/**
 * Enkripsi plaintext dengan Double Ratchet message key.
 * AES key (32B) dan IV (12B) diderivasi secara deterministik dari mk via HKDF.
 * Output: ciphertext (plaintext + 16B GCM auth tag)
 */
export function encryptWithMessageKey(
  mk: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const expanded = hkdf(sha256, mk, undefined, MESSAGE_KEY_INFO, 44)
  const aesKey = expanded.slice(0, 32)
  const iv = expanded.slice(32, 44)
  return gcm(aesKey, iv, aad).encrypt(plaintext)
}

/**
 * Dekripsi ciphertext dengan Double Ratchet message key.
 * @throws jika auth tag tidak valid
 */
export function decryptWithMessageKey(
  mk: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const expanded = hkdf(sha256, mk, undefined, MESSAGE_KEY_INFO, 44)
  const aesKey = expanded.slice(0, 32)
  const iv = expanded.slice(32, 44)
  return gcm(aesKey, iv, aad).decrypt(ciphertext)
}

// ─────────────────────────────────────────────────────────────────
// AEAD umum — untuk enkripsi key material di storage
// ─────────────────────────────────────────────────────────────────

export interface EncryptedData {
  iv: Uint8Array        // 12 bytes random nonce
  ciphertext: Uint8Array  // plaintext + 16 byte GCM tag
}

function secureRandom(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  globalThis.crypto.getRandomValues(buf)
  return buf
}

/** Enkripsi dengan AES-256-GCM menggunakan random IV */
export function aeadEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): EncryptedData {
  const iv = secureRandom(12)
  const ciphertext = gcm(key, iv, aad).encrypt(plaintext)
  return { iv, ciphertext }
}

/** Dekripsi AES-256-GCM */
export function aeadDecrypt(
  key: Uint8Array,
  data: EncryptedData,
  aad?: Uint8Array,
): Uint8Array {
  return gcm(key, data.iv, aad).decrypt(data.ciphertext)
}
