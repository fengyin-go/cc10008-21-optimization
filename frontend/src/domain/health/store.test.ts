/**
 * 持久化层测试：用内存 StorageAdapter 验证 load/persist/reset，
 * 以及失败操作只追加审计事件、不改变业务计数的行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadState, persistState, resetState, type StorageAdapter } from './store'
import { buildSeedState } from './seed'
import { runCheck, rotateCredential } from './engine'

class MemoryStorage implements StorageAdapter {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
}

const T0 = 1_700_000_000_000
const POOL = 'pool-SRC-0001'
const EP2 = 'ep-SRC-0001-2'

test('首次加载播种并持久化，二次加载回读同一状态', () => {
  const adapter = new MemoryStorage()
  const first = loadState(adapter)
  assert.equal(first.pools.length, 4)
  const persisted = adapter.getItem('interactive-analytics-lab:health-state')
  assert.ok(persisted && persisted.includes('"version":1'))

  const again = loadState(adapter)
  assert.equal(again.pools.length, 4)
  assert.equal(again.pools[0].code, first.pools[0].code)
})

test('写入后重新加载，回读到的就是最终资格与失败地址', () => {
  const adapter = new MemoryStorage()
  let state = loadState(adapter)
  const pool = state.pools.find((item) => item.id === POOL)!

  state = runCheck(state, {
    poolId: POOL,
    actor: pool.owner,
    mode: 'full',
    results: pool.endpoints.map((ep) => ({ addressId: ep.id, ok: true })),
    now: T0 + 1000,
  }).state
  state = runCheck(state, {
    poolId: POOL,
    actor: pool.owner,
    mode: 'full',
    results: pool.endpoints.map((ep) => ({ addressId: ep.id, ok: ep.id !== EP2, ...(ep.id === EP2 ? { reason: '连接超时' } : {}) })),
    now: T0 + 2000,
  }).state
  persistState(state, adapter)

  const reloaded = loadState(adapter)
  const restored = reloaded.pools.find((item) => item.id === POOL)!
  assert.equal(restored.status, 'check_failed')
  assert.equal(restored.eligibility, 'blocked')
  assert.equal(restored.remainingAttempts, 2)
  assert.deepEqual(restored.endpoints.filter((ep) => ep.outcome === 'failed').map((ep) => ep.id), [EP2])
})

test('损坏的存储内容自动回退种子', () => {
  const adapter = new MemoryStorage()
  adapter.setItem('interactive-analytics-lab:health-state', '{not-json')
  const state = loadState(adapter)
  assert.equal(state.pools.length, 4)
})

test('resetState 回到种子且覆盖旧内容', () => {
  const adapter = new MemoryStorage()
  const state = buildSeedState(T0)
  persistState(state, adapter)
  const rotated = rotateCredential(state, {
    poolId: POOL,
    actor: 'zhangwei',
    expectedConfigVersion: 1,
    newCredentialRef: 'cred-x@v2',
    now: T0,
  }).state
  persistState(rotated, adapter)
  assert.equal(loadState(adapter).pools.find((p) => p.id === POOL)!.credentialVersion, 2)

  const reset = resetState(adapter)
  assert.equal(reset.pools.find((p) => p.id === POOL)!.credentialVersion, 1)
  assert.equal(loadState(adapter).pools.find((p) => p.id === POOL)!.credentialVersion, 1)
})
