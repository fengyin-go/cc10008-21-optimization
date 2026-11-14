/**
 * 健康检查域规则测试（node --import tsx 运行，无第三方测试框架）。
 * 运行：npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyLateReceipt,
  attemptWork,
  canAcceptWork,
  createPool,
  failedEndpoints,
  rotateCredential,
  runCheck,
  summarize,
  updateConfig,
} from './engine'
import { buildSeedState } from './seed'
import { loadState, persistState, resetState } from './store'
import type { CheckReceipt, CheckResult, HealthState, Pool, PoolConfig } from './types'

const T0 = 1_700_000_000_000
const POOL = 'pool-SRC-0001'
const EP1 = 'ep-SRC-0001-1'
const EP2 = 'ep-SRC-0001-2'
const EP3 = 'ep-SRC-0001-3'
const OWNER = 'zhangwei'
const OTHER = 'lina'

function poolOf(state: HealthState, id: string): Pool {
  const pool = state.pools.find((item) => item.id === id)
  assert.ok(pool, `测试前置：连接池 ${id} 应存在`)
  return pool
}

function allOk(pool: Pool): CheckResult[] {
  return pool.endpoints.map((endpoint) => ({ addressId: endpoint.id, ok: true }))
}

function failOne(pool: Pool, addressId: string, reason = '连接超时'): CheckResult[] {
  return pool.endpoints.map((endpoint) => ({
    addressId: endpoint.id,
    ok: endpoint.id !== addressId,
    ...(endpoint.id === addressId ? { reason } : {}),
  }))
}

function failOnly(addressId: string, reason = '连接超时'): CheckResult[] {
  return [{ addressId, ok: false, reason }]
}

function receipt(seq: number, credentialVersion: number, results: CheckResult[], at: number): CheckReceipt {
  return { seq, credentialVersion, at, results }
}

test('单次超时只标记失败地址：其余地址与连接池资格语义分离，且产生续试清单', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  assert.equal(pool.status, 'pending')
  assert.equal(canAcceptWork(pool), false)
  assert.equal(pool.remainingAttempts, 3)

  const first = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 })
  assert.equal(first.ok, true)
  state = first.state
  assert.equal(poolOf(state, POOL).status, 'connected')
  assert.equal(poolOf(state, POOL).eligibility, 'eligible')

  const second = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP2),
    now: T0 + 2000,
  })
  assert.equal(second.ok, true)
  state = second.state

  const updated = poolOf(state, POOL)
  assert.equal(updated.status, 'check_failed', '一次超时只应是「本次失败」')
  assert.equal(updated.eligibility, 'blocked', '失败期间不具备接活资格')
  assert.equal(updated.remainingAttempts, 2, '按检查轮次扣一次，与失败地址个数无关')
  assert.equal(updated.endpoints.find((ep) => ep.id === EP1)?.outcome, 'success', '成功地址结果保留')
  assert.equal(updated.endpoints.find((ep) => ep.id === EP2)?.outcome, 'failed')
  assert.deepEqual(failedEndpoints(updated), [EP2], '续试清单只含失败地址')
  assert.equal(updated.lastFailure, undefined, '未到上限不应固化失败节点')
})

test('续试只打失败地址且成功后恢复资格、重置剩余次数', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP2),
    now: T0 + 2000,
  }).state
  assert.deepEqual(failedEndpoints(poolOf(state, POOL)), [EP2])

  // 续试夹带成功地址会被拒绝
  const invalid = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'failed',
    results: [{ addressId: EP2, ok: false }, { addressId: EP1, ok: true }],
    now: T0 + 3000,
  })
  assert.equal(invalid.ok, false)
  assert.equal(poolOf(state, POOL).remainingAttempts, 2, '非法请求不得扣减重试次数')

  const retry = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'failed',
    results: failOnly(EP2),
    now: T0 + 3000,
  })
  assert.equal(retry.ok, true)
  state = retry.state
  assert.equal(poolOf(state, POOL).remainingAttempts, 1)
  assert.deepEqual(failedEndpoints(poolOf(state, POOL)), [EP2])

  const recovered = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'failed',
    results: [{ addressId: EP2, ok: true }],
    now: T0 + 4000,
  })
  assert.equal(recovered.ok, true)
  state = recovered.state
  const finalPool = poolOf(state, POOL)
  assert.equal(finalPool.status, 'connected')
  assert.equal(finalPool.eligibility, 'eligible')
  assert.equal(finalPool.remainingAttempts, 3, '全部地址成功后剩余次数重置回上限')
  assert.ok(finalPool.endpoints.every((ep) => ep.outcome === 'success'))
})

test('达到重试上限停止续试并说明最后一处失败节点', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state

  // 连续三轮存在失败地址
  for (const round of [2000, 3000, 4000]) {
    state = runCheck(state, {
      poolId: POOL,
      actor: OWNER,
      mode: 'full',
      results: failOne(poolOf(state, POOL), EP3, '握手被拒'),
      now: T0 + round,
    }).state
  }

  const suspended = poolOf(state, POOL)
  assert.equal(suspended.status, 'suspended')
  assert.equal(suspended.eligibility, 'blocked')
  assert.equal(suspended.remainingAttempts, 0)
  assert.ok(suspended.lastFailure)
  assert.equal(suspended.lastFailure?.addressId, EP3)
  assert.equal(suspended.lastFailure?.node, 'order-db-03')
  assert.equal(suspended.lastFailure?.reason, '握手被拒')
  assert.equal(suspended.lastFailure?.attempt, 3, '最后一处失败节点记录第 3 次尝试')

  const stopped = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: allOk(suspended),
    now: T0 + 5000,
  })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.code, 'SUSPENDED', '挂起后续试入口关闭')
  assert.equal(poolOf(stopped.state, POOL).remainingAttempts, 0, '被拒绝的续试不改动计数')
})

test('流水线在资格恢复前不得接活，且拒绝派活不消耗重试次数', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state

  const okWork = attemptWork(state, { nodeId: 'PIPE-01', now: T0 + 1500 })
  assert.equal(okWork.ok, true)
  state = okWork.state
  assert.equal(state.pipelineNodes.find((n) => n.id === 'PIPE-01')?.status, 'dispatched')

  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP1),
    now: T0 + 2000,
  }).state
  const before = poolOf(state, POOL).remainingAttempts
  const blocked = attemptWork(state, { nodeId: 'PIPE-01', now: T0 + 2500 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'PIPELINE_BLOCKED')
  assert.equal(poolOf(blocked.state, POOL).remainingAttempts, before, '派活被挡不扣重试')
  assert.equal(blocked.state.pipelineNodes.find((n) => n.id === 'PIPE-01')?.status, 'dispatched', '节点状态不回退')
})

test('成功完成的检查不能被晚到的失败回执倒推', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  const seq = poolOf(state, POOL).lastCheckSeq
  assert.equal(seq, 1)

  const lateFail = applyLateReceipt(
    state,
    POOL,
    receipt(seq, poolOf(state, POOL).credentialVersion, failOnly(EP2), T0 + 5000),
    T0 + 5000,
  )
  assert.equal(lateFail.ok, false)
  assert.equal(lateFail.code, 'STALE_RECEIPT')
  assert.equal(poolOf(lateFail.state, POOL).status, 'connected', '成功结果保持不变')
  assert.equal(poolOf(lateFail.state, POOL).eligibility, 'eligible')
  assert.equal(poolOf(lateFail.state, POOL).endpoints.find((ep) => ep.id === EP2)?.outcome, 'success')
})

test('最新完整检查覆盖旧凭据：旧凭据版本回执一律拒绝，不污染新连接池', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP1),
    now: T0 + 2000,
  }).state

  const rotated = rotateCredential(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: poolOf(state, POOL).configVersion,
    newCredentialRef: 'cred-order-rw@v2',
    now: T0 + 3000,
  })
  assert.equal(rotated.ok, true)
  state = rotated.state
  const v2 = poolOf(state, POOL)
  assert.equal(v2.credentialVersion, 2)
  assert.equal(v2.status, 'pending', '非挂起轮换后等待首检')
  assert.equal(v2.remainingAttempts, 3, '新版本重新拥有完整重试预算')
  assert.ok(v2.endpoints.every((ep) => ep.outcome === 'unknown'))
  assert.equal(v2.lastFailure, undefined)

  const oldReceipt = applyLateReceipt(
    state,
    POOL,
    receipt(v2.lastCheckSeq + 1, 1, failOnly(EP1, '旧凭据超时'), T0 + 4000),
    T0 + 4000,
  )
  assert.equal(oldReceipt.ok, false)
  assert.equal(oldReceipt.code, 'OLD_VERSION_RECEIPT')
  assert.equal(poolOf(oldReceipt.state, POOL).credentialVersion, 2)
  assert.ok(poolOf(oldReceipt.state, POOL).endpoints.every((ep) => ep.outcome === 'unknown'), '旧失败不得写入新池')
})

test('挂起后轮换凭据进入恢复探测，新版本首检成功才恢复资格', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  for (const round of [2000, 3000, 4000]) {
    state = runCheck(state, {
      poolId: POOL,
      actor: OWNER,
      mode: 'full',
      results: failOne(poolOf(state, POOL), EP1),
      now: T0 + round,
    }).state
  }
  assert.equal(poolOf(state, POOL).status, 'suspended')

  state = rotateCredential(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: poolOf(state, POOL).configVersion,
    newCredentialRef: 'cred-order-rw@v2',
    now: T0 + 5000,
  }).state
  const recovering = poolOf(state, POOL)
  assert.equal(recovering.status, 'recovering')
  assert.equal(recovering.eligibility, 'blocked', '恢复探测期间仍不得接活')

  const blockedWork = attemptWork(state, { nodeId: 'PIPE-01', now: T0 + 5500 })
  assert.equal(blockedWork.ok, false)

  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: allOk(recovering),
    now: T0 + 6000,
  }).state
  const healthy = poolOf(state, POOL)
  assert.equal(healthy.status, 'connected')
  assert.equal(healthy.eligibility, 'eligible')
  assert.equal(healthy.remainingAttempts, 3)

  const work = attemptWork(state, { nodeId: 'PIPE-01', now: T0 + 6500 })
  assert.equal(work.ok, true)
})

test('并发修改同一连接池只接受一个完整配置，冲突不消耗重试次数', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  const attemptsBefore = poolOf(state, POOL).remainingAttempts

  const baseConfig: PoolConfig = { ...poolOf(state, POOL).config }
  const first = updateConfig(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: 1,
    config: { ...baseConfig, poolSize: 20 },
    now: T0 + 2000,
  })
  assert.equal(first.ok, true)
  state = first.state
  assert.equal(poolOf(state, POOL).configVersion, 2)
  assert.equal(poolOf(state, POOL).config.poolSize, 20)

  const conflict = updateConfig(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: 1,
    config: { ...baseConfig, timeoutSec: 9 },
    now: T0 + 3000,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'CONFIG_CONFLICT')
  assert.equal(poolOf(conflict.state, POOL).config.poolSize, 20, '先到的完整配置保留')
  assert.equal(poolOf(conflict.state, POOL).remainingAttempts, attemptsBefore)

  // 回读最终版本号后重新提交完整配置即可成功
  const retry = updateConfig(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: 2,
    config: { ...poolOf(state, POOL).config, timeoutSec: 9 },
    now: T0 + 4000,
  })
  assert.equal(retry.ok, true)
  assert.equal(poolOf(retry.state, POOL).configVersion, 3)
  state = retry.state

  const incomplete = updateConfig(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: 3,
    config: { ...poolOf(state, POOL).config, poolSize: 0 },
    now: T0 + 5000,
  })
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.code, 'CONFIG_INCOMPLETE')
})

test('凭据只能通过轮换修改，普通配置夹带 credentialRef 会被拒绝', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  const result = updateConfig(state, {
    poolId: POOL,
    actor: OWNER,
    expectedConfigVersion: pool.configVersion,
    config: { ...pool.config, credentialRef: 'cred-order-rw@v2' },
    now: T0 + 1000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CREDENTIAL_VIA_CONFIG')
  assert.equal(poolOf(result.state, POOL).credentialVersion, 1)
})

test('凭据按负责人归属：其他成员只能查看，写操作全部拒绝且不改计数', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  const before = pool.remainingAttempts

  const check = runCheck(state, { poolId: POOL, actor: OTHER, mode: 'full', results: allOk(pool), now: T0 + 1000 })
  assert.equal(check.ok, false)
  assert.equal(check.code, 'FORBIDDEN_OWNER')

  const edit = updateConfig(state, {
    poolId: POOL,
    actor: OTHER,
    expectedConfigVersion: pool.configVersion,
    config: { ...pool.config, poolSize: 30 },
    now: T0 + 2000,
  })
  assert.equal(edit.ok, false)
  assert.equal(edit.code, 'FORBIDDEN_OWNER')

  const rotate = rotateCredential(state, {
    poolId: POOL,
    actor: OTHER,
    expectedConfigVersion: pool.configVersion,
    newCredentialRef: 'cred-hacked@v2',
    now: T0 + 3000,
  })
  assert.equal(rotate.ok, false)
  assert.equal(rotate.code, 'FORBIDDEN_OWNER')
  assert.equal(poolOf(rotate.state, POOL).remainingAttempts, before)
  assert.equal(poolOf(rotate.state, POOL).configVersion, 1)
})

test('共享连接池对所有成员（含负责人）只读', () => {
  const state = buildSeedState(T0)
  const sharedId = 'pool-SRC-0004'
  const shared = poolOf(state, sharedId)
  assert.equal(shared.config.shared, true)

  const ownerCheck = runCheck(state, {
    poolId: sharedId,
    actor: shared.owner,
    mode: 'full',
    results: shared.endpoints.map((ep) => ({ addressId: ep.id, ok: true })),
    now: T0 + 1000,
  })
  assert.equal(ownerCheck.ok, false)
  assert.equal(ownerCheck.code, 'FORBIDDEN_SHARED')

  const otherEdit = updateConfig(state, {
    poolId: sharedId,
    actor: OTHER,
    expectedConfigVersion: shared.configVersion,
    config: { ...shared.config, poolSize: 99 },
    now: T0 + 2000,
  })
  assert.equal(otherEdit.ok, false)
  assert.equal(otherEdit.code, 'FORBIDDEN_SHARED')
})

test('汇总口径区分本次失败、挂起与被阻断的流水线节点', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP2),
    now: T0 + 2000,
  }).state

  const summary = summarize(state)
  assert.equal(summary.total, 4)
  assert.equal(summary.connected, 0, '种子池初始 pending，唯一首检成功的池又进入 check_failed')
  assert.equal(summary.checkFailed, 1)
  assert.equal(summary.blocked, 4)
  assert.equal(summary.blockedPipelineNodes, 4)
})

test('页面恢复：持久化回读后先看到最终资格，再从失败地址续试', () => {
  class MemoryStorage {
    private map = new Map<string, string>()
    getItem(key: string) {
      return this.map.has(key) ? this.map.get(key)! : null
    }
    setItem(key: string, value: string) {
      this.map.set(key, value)
    }
  }
  const adapter = new MemoryStorage()

  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  state = runCheck(state, {
    poolId: POOL,
    actor: OWNER,
    mode: 'full',
    results: failOne(poolOf(state, POOL), EP2),
    now: T0 + 2000,
  }).state
  persistState(state, adapter)

  // 模拟刷新：重新从存储加载，回读到的就是最终资格与失败地址清单
  const reloaded = loadState(adapter)
  const restored = poolOf(reloaded, POOL)
  assert.equal(restored.status, 'check_failed')
  assert.equal(restored.eligibility, 'blocked')
  assert.deepEqual(failedEndpoints(restored), [EP2])

  const retry = runCheck(reloaded, {
    poolId: POOL,
    actor: OWNER,
    mode: 'failed',
    results: [{ addressId: EP2, ok: true }],
    now: T0 + 3000,
  })
  assert.equal(retry.ok, true)
  assert.equal(poolOf(retry.state, POOL).status, 'connected')

  resetState(adapter)
  assert.equal(loadState(adapter).pools.length, 4, '重置后回到种子状态')
})

test('挂起后同版本的迟到成功回执也不能复活连接池', () => {
  let state = buildSeedState(T0)
  const pool = poolOf(state, POOL)
  state = runCheck(state, { poolId: POOL, actor: OWNER, mode: 'full', results: allOk(pool), now: T0 + 1000 }).state
  for (const round of [2000, 3000, 4000]) {
    state = runCheck(state, {
      poolId: POOL,
      actor: OWNER,
      mode: 'full',
      results: failOne(poolOf(state, POOL), EP1),
      now: T0 + round,
    }).state
  }
  const suspended = poolOf(state, POOL)
  assert.equal(suspended.status, 'suspended')

  const lateSuccess = applyLateReceipt(
    state,
    POOL,
    receipt(suspended.lastCheckSeq + 1, suspended.credentialVersion, allOk(suspended), T0 + 6000),
    T0 + 6000,
  )
  assert.equal(lateSuccess.ok, false)
  assert.equal(lateSuccess.code, 'SUSPENDED')
  assert.equal(poolOf(lateSuccess.state, POOL).status, 'suspended')
  assert.equal(poolOf(lateSuccess.state, POOL).remainingAttempts, 0)
})

test('建池校验：至少一个接入地址、编号唯一', () => {
  const state = buildSeedState(T0)
  const dup = createPool(state, {
    code: 'SRC-0001',
    name: '重复编号池',
    owner: OWNER,
    config: poolConfigForTest(),
    endpointSpecs: [{ node: 'n1', url: 'u1' }],
    now: T0,
  })
  assert.equal(dup.ok, false)

  const noEndpoint = createPool(state, {
    code: 'SRC-9999',
    name: '空池',
    owner: OWNER,
    config: poolConfigForTest(),
    endpointSpecs: [],
    now: T0,
  })
  assert.equal(noEndpoint.ok, false)
})

function poolConfigForTest(): PoolConfig {
  return {
    type: 'MySQL',
    poolSize: 4,
    timeoutSec: 5,
    retryLimit: 2,
    credentialRef: 'cred-x@v1',
    shared: false,
  }
}
