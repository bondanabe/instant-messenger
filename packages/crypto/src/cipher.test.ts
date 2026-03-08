import { describe, it, expect } from 'vitest'
import { encryptWithMessageKey, decryptWithMessageKey } from './cipher'

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))

describe('encryptWithMessageKey / decryptWithMessageKey', () => {
  it('round-trips plaintext correctly', () => {
    const mk = randomBytes(32)
    const plaintext = new TextEncoder().encode('Hello, instant messenger!')
    const aad = new TextEncoder().encode('conversation-id-123')

    const ciphertext = encryptWithMessageKey(mk, plaintext, aad)
    const decrypted = decryptWithMessageKey(mk, ciphertext, aad)

    expect(decrypted).toEqual(plaintext)
  })

  it('ciphertext is longer than plaintext (GCM auth tag is 16 bytes)', () => {
    const mk = randomBytes(32)
    const plaintext = new TextEncoder().encode('test')
    const aad = new TextEncoder().encode('aad')
    const ciphertext = encryptWithMessageKey(mk, plaintext, aad)
    expect(ciphertext.length).toBe(plaintext.length + 16)
  })

  it('throws when ciphertext is tampered', () => {
    const mk = randomBytes(32)
    const plaintext = new TextEncoder().encode('secret data')
    const aad = new TextEncoder().encode('aad')
    const ciphertext = encryptWithMessageKey(mk, plaintext, aad)

    // Flip a bit in the ciphertext
    const tampered = new Uint8Array(ciphertext)
    tampered[0] ^= 0xff

    expect(() => decryptWithMessageKey(mk, tampered, aad)).toThrow()
  })

  it('throws when AAD does not match', () => {
    const mk = randomBytes(32)
    const plaintext = new TextEncoder().encode('secret data')
    const aad1 = new TextEncoder().encode('correct-aad')
    const aad2 = new TextEncoder().encode('wrong-aad')

    const ciphertext = encryptWithMessageKey(mk, plaintext, aad1)
    expect(() => decryptWithMessageKey(mk, ciphertext, aad2)).toThrow()
  })

  it('throws when wrong message key is used for decryption', () => {
    const mk1 = randomBytes(32)
    const mk2 = randomBytes(32)
    const plaintext = new TextEncoder().encode('secret data')
    const aad = new TextEncoder().encode('aad')

    const ciphertext = encryptWithMessageKey(mk1, plaintext, aad)
    expect(() => decryptWithMessageKey(mk2, ciphertext, aad)).toThrow()
  })

  it('handles empty plaintext', () => {
    const mk = randomBytes(32)
    const plaintext = new Uint8Array(0)
    const aad = new TextEncoder().encode('aad')
    const ciphertext = encryptWithMessageKey(mk, plaintext, aad)
    const decrypted = decryptWithMessageKey(mk, ciphertext, aad)
    expect(decrypted).toEqual(plaintext)
  })

  it('handles large plaintext (64 KB)', () => {
    const mk = randomBytes(32)
    const plaintext = randomBytes(64 * 1024)
    const aad = new TextEncoder().encode('large-payload')
    const ciphertext = encryptWithMessageKey(mk, plaintext, aad)
    const decrypted = decryptWithMessageKey(mk, ciphertext, aad)
    expect(decrypted).toEqual(plaintext)
  })
})
