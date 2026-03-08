import { describe, it, expect } from 'vitest'
import { calculateNextRetry, isOutboxExpired, MAX_RETRY_COUNT } from './queue/OutboxQueue'
import type { OutboxEntry } from './queue/OutboxQueue'

describe('calculateNextRetry', () => {
  it('retry 0 yields ~5 seconds from now (within jitter range)', () => {
    const before = Date.now()
    const result = calculateNextRetry(0)
    const after = Date.now()
    const BASE = 5_000
    const maxWithJitter = BASE * 1.2
    const minWithJitter = BASE * 0.8
    expect(result).toBeGreaterThanOrEqual(before + minWithJitter)
    expect(result).toBeLessThanOrEqual(after + maxWithJitter)
  })

  it('retry 1 yields ~10 seconds from now', () => {
    const before = Date.now()
    const result = calculateNextRetry(1)
    const BASE = 10_000
    expect(result).toBeGreaterThan(before + BASE * 0.8)
    expect(result).toBeLessThan(before + BASE * 1.2 + 100)
  })

  it('high retry count is capped at 1 hour max', () => {
    const before = Date.now()
    const MAX_MS = 3_600_000
    const result = calculateNextRetry(20)
    // Should not exceed 1 hour + jitter
    expect(result).toBeLessThanOrEqual(before + MAX_MS * 1.21)
    expect(result).toBeGreaterThan(before + MAX_MS * 0.79)
  })

  it('each successive retry is at least as long as the previous (trend)', () => {
    // Average over 5 samples to smooth jitter
    const avg = (n: number) => {
      const now = Date.now()
      let sum = 0
      for (let i = 0; i < 5; i++) sum += calculateNextRetry(n) - now
      return sum / 5
    }
    expect(avg(1)).toBeGreaterThan(avg(0))
    expect(avg(2)).toBeGreaterThan(avg(1))
    expect(avg(3)).toBeGreaterThan(avg(2))
  })
})

describe('MAX_RETRY_COUNT', () => {
  it('is 10', () => {
    expect(MAX_RETRY_COUNT).toBe(10)
  })
})

describe('isOutboxExpired', () => {
  const makeEntry = (createdAt: number): OutboxEntry => ({
    id: 'test',
    messageId: 'msg1',
    targetUserId: 'user1',
    encryptedPayload: new Uint8Array(0),
    retryCount: 0,
    nextRetryAt: 0,
    createdAt,
  })

  it('returns false for a fresh entry (just created)', () => {
    expect(isOutboxExpired(makeEntry(Date.now()))).toBe(false)
  })

  it('returns false for an entry 6 days old', () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 3_600_000
    expect(isOutboxExpired(makeEntry(sixDaysAgo))).toBe(false)
  })

  it('returns true for an entry older than 7 days', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 3_600_000
    expect(isOutboxExpired(makeEntry(eightDaysAgo))).toBe(true)
  })

  it('returns true for an entry exactly 8 days old', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 3_600_000 - 1
    expect(isOutboxExpired(makeEntry(eightDaysAgo))).toBe(true)
  })
})
