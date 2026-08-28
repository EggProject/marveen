// 100% coverage suite for src/web/remote-status-cache.ts.
//
// The SUT is the short-TTL cache the synchronous dashboard status endpoints
// use to avoid issuing a fresh blocking ssh call per remote agent per
// request. It has no external dependencies -- no db/config/logger imports --
// so no collaborators need mocking. The class is exercised through its
// public surface only (getOrRefresh + invalidate); every branch of the
// freshness check, the try/catch, and the cache-invalidation path is
// driven deterministically with caller-supplied `nowMs`.

import { describe, it, expect, vi } from 'vitest'
import { RemoteStatusCache } from '../web/remote-status-cache.js'

describe('RemoteStatusCache', () => {
  describe('getOrRefresh', () => {
    it('calls the fetcher on a cold miss and caches the returned value', () => {
      const cache = new RemoteStatusCache<string>(3000)
      const fetch = vi.fn(() => 'running')
      // entry is undefined -> falls through the freshness check into try
      expect(cache.getOrRefresh('a', 1000, fetch)).toBe('running')
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('returns the cached value WITHOUT calling the fetcher again within the TTL', () => {
      const cache = new RemoteStatusCache<string>(3000)
      const fetch = vi.fn(() => 'running')
      cache.getOrRefresh('a', 1000, fetch)
      // 2.9s later: entry exists AND (nowMs - entry.at) < ttlMs
      // -> returns entry.value, fetcher not invoked
      expect(cache.getOrRefresh('a', 3900, fetch)).toBe('running')
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('refreshes once the TTL has elapsed, even with a fresh entry', () => {
      const cache = new RemoteStatusCache<string>(3000)
      let n = 0
      const fetch = vi.fn(() => `v${++n}`)
      expect(cache.getOrRefresh('a', 1000, fetch)).toBe('v1')
      // entry exists but (nowMs - entry.at) >= ttlMs -> falls into try again
      expect(cache.getOrRefresh('a', 4001, fetch)).toBe('v2')
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('treats the TTL boundary as a miss (>= ttlMs)', () => {
      const cache = new RemoteStatusCache<string>(1000)
      const fetch = vi.fn(() => 'v1')
      cache.getOrRefresh('a', 0, fetch)
      // exact boundary: nowMs - entry.at == ttlMs -> not strictly less -> miss
      expect(cache.getOrRefresh('a', 1000, fetch)).toBe('v1')
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('keys are independent: a refresh on one does not invalidate another', () => {
      const cache = new RemoteStatusCache<string>(3000)
      const fetch = vi.fn((k: string) => k)
      expect(cache.getOrRefresh('a', 1000, () => fetch('a'))).toBe('a')
      expect(cache.getOrRefresh('b', 1000, () => fetch('b'))).toBe('b')
      // 1ms later, both still within TTL -> neither re-fetches
      expect(cache.getOrRefresh('a', 1001, () => fetch('a'))).toBe('a')
      expect(cache.getOrRefresh('b', 1001, () => fetch('b'))).toBe('b')
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('returns the last-known cached value when a refresh throws and an entry exists', () => {
      const cache = new RemoteStatusCache<string>(3000)
      // warm the cache with a real value
      cache.getOrRefresh('a', 1000, () => 'running')
      // TTL elapsed + throwing fetcher -> catch path with entry -> return entry.value
      const boom = () => { throw new Error('ssh down') }
      expect(cache.getOrRefresh('a', 5000, boom, 'unreachable')).toBe('running')
    })

    it('returns the supplied fallback when a refresh throws on a cold cache', () => {
      const cache = new RemoteStatusCache<string>(3000)
      // entry is undefined -> catch path with no entry -> return fallback
      const boom = () => { throw new Error('ssh down') }
      expect(cache.getOrRefresh('a', 1000, boom, 'unreachable')).toBe('unreachable')
    })

    it('returns undefined when a refresh throws on a cold cache and no fallback was given', () => {
      const cache = new RemoteStatusCache<string>(3000)
      // exercises the `return fallback as T` line with fallback === undefined
      const boom = () => { throw new Error('ssh down') }
      expect(cache.getOrRefresh('a', 1000, boom)).toBeUndefined()
    })

    it('does not poison the cache when a refresh throws -- the next successful call refills it', () => {
      const cache = new RemoteStatusCache<string>(3000)
      cache.getOrRefresh('a', 1000, () => { throw new Error('down') }, 'unreachable')
      // after the throw, store must NOT contain 'a' (set is inside try only),
      // so the next call is a fresh cold miss
      expect(cache.getOrRefresh('a', 2000, () => 'recovered')).toBe('recovered')
    })

    it('overwrites the cached value when a refresh succeeds after a prior successful refresh', () => {
      const cache = new RemoteStatusCache<string>(3000)
      cache.getOrRefresh('a', 1000, () => 'first')
      // TTL elapsed -> re-fetch and overwrite the stored entry
      expect(cache.getOrRefresh('a', 5000, () => 'second')).toBe('second')
      // the new value must be cached, not the old one
      expect(cache.getOrRefresh('a', 6000, () => 'third')).toBe('second')
    })
  })

  describe('invalidate', () => {
    it('drops a cached key so the next getOrRefresh is a cold miss', () => {
      const cache = new RemoteStatusCache<string>(3000)
      const fetch = vi.fn(() => 'running')
      cache.getOrRefresh('a', 1000, fetch)
      cache.invalidate('a')
      // key removed -> entry is undefined -> cold miss, fetcher invoked again
      expect(cache.getOrRefresh('a', 1100, fetch)).toBe('running')
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('is a no-op when the key was never cached', () => {
      const cache = new RemoteStatusCache<string>(3000)
      // must not throw on a missing key
      expect(() => cache.invalidate('nope')).not.toThrow()
    })

    it('only drops the targeted key, leaving siblings intact', () => {
      const cache = new RemoteStatusCache<string>(3000)
      cache.getOrRefresh('a', 1000, () => 'A')
      cache.getOrRefresh('b', 1000, () => 'B')
      cache.invalidate('a')
      // 'a' is cold again, 'b' still warm
      const fetchA = vi.fn(() => 'A')
      const fetchB = vi.fn(() => 'B')
      expect(cache.getOrRefresh('a', 1100, fetchA)).toBe('A')
      expect(cache.getOrRefresh('b', 1100, fetchB)).toBe('B')
      expect(fetchA).toHaveBeenCalledTimes(1)
      expect(fetchB).not.toHaveBeenCalled()
    })
  })
})