import { describe, it, expect } from 'vitest'
import {
  generateIdentityKeyPair,
  generateDHKeyPair,
  identityToDHKeyPair,
  signBytes,
  verifySignature,
} from './keys'

describe('generateIdentityKeyPair', () => {
  it('returns 32-byte Ed25519 public and private keys', () => {
    const kp = generateIdentityKeyPair()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(32)
  })

  it('generates unique keypairs each call', () => {
    const kp1 = generateIdentityKeyPair()
    const kp2 = generateIdentityKeyPair()
    expect(kp1.publicKey).not.toEqual(kp2.publicKey)
    expect(kp1.privateKey).not.toEqual(kp2.privateKey)
  })
})

describe('generateDHKeyPair', () => {
  it('returns 32-byte X25519 public and private keys', () => {
    const kp = generateDHKeyPair()
    expect(kp.publicKey).toBeInstanceOf(Uint8Array)
    expect(kp.privateKey).toBeInstanceOf(Uint8Array)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.privateKey.length).toBe(32)
  })

  it('generates unique DH keypairs each call', () => {
    const kp1 = generateDHKeyPair()
    const kp2 = generateDHKeyPair()
    expect(kp1.publicKey).not.toEqual(kp2.publicKey)
  })
})

describe('identityToDHKeyPair', () => {
  it('converts Ed25519 keypair to X25519 keypair (32 bytes each)', () => {
    const identity = generateIdentityKeyPair()
    const dh = identityToDHKeyPair(identity)
    expect(dh.publicKey).toBeInstanceOf(Uint8Array)
    expect(dh.privateKey).toBeInstanceOf(Uint8Array)
    expect(dh.publicKey.length).toBe(32)
    expect(dh.privateKey.length).toBe(32)
  })

  it('is deterministic — same input always produces same output', () => {
    const identity = generateIdentityKeyPair()
    const dh1 = identityToDHKeyPair(identity)
    const dh2 = identityToDHKeyPair(identity)
    expect(dh1.publicKey).toEqual(dh2.publicKey)
    expect(dh1.privateKey).toEqual(dh2.privateKey)
  })
})

describe('signBytes / verifySignature', () => {
  it('successfully verifies a valid signature', () => {
    const kp = generateIdentityKeyPair()
    const data = new TextEncoder().encode('hello world')
    const sig = signBytes(kp.privateKey, data)
    expect(verifySignature(kp.publicKey, data, sig)).toBe(true)
  })

  it('produces a 64-byte signature', () => {
    const kp = generateIdentityKeyPair()
    const data = new TextEncoder().encode('test')
    const sig = signBytes(kp.privateKey, data)
    expect(sig.length).toBe(64)
  })

  it('returns false when data is tampered', () => {
    const kp = generateIdentityKeyPair()
    const data = new TextEncoder().encode('original data')
    const sig = signBytes(kp.privateKey, data)
    const tampered = new TextEncoder().encode('tampered data')
    expect(verifySignature(kp.publicKey, tampered, sig)).toBe(false)
  })

  it('returns false when signature is forged', () => {
    const kp = generateIdentityKeyPair()
    const data = new TextEncoder().encode('data')
    const fakeSig = new Uint8Array(64).fill(0xff)
    expect(verifySignature(kp.publicKey, data, fakeSig)).toBe(false)
  })

  it('returns false when verified against the wrong public key', () => {
    const kp1 = generateIdentityKeyPair()
    const kp2 = generateIdentityKeyPair()
    const data = new TextEncoder().encode('data')
    const sig = signBytes(kp1.privateKey, data)
    expect(verifySignature(kp2.publicKey, data, sig)).toBe(false)
  })
})
