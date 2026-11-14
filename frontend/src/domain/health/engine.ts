/**
 * 连接池健康检查域 —— 纯领域引擎。
 *
 * 不依赖 React、localStorage 或时钟：时间由调用方以 now 传入，状态经深拷贝后修改，
 * 因而每条规则都可以在测试里直接断言。页面与持久化层只负责搬运。
 *
 * 关键规则对照需求：
 * 1. 检查结果（endpoint.outcome / check_failed）与连接资格（eligibility）分离，
 *    单次超时只标记失败地址，剩余次数仍在时不挂起，续试只打失败地址。
 * 2. 资格非 eligible 的连接池，流水线 attemptWork 直接被挡，且不消耗任何重试次数。
 * 3. 检查带序号与凭据版本：迟到回执（seq 不大于已应用序号）与旧凭据版本回执一律丢弃，
 *    成功结果不会被晚到的失败回执倒推。
 * 4. 凭据轮换产生新 credentialVersion，状态回到 recovering/pending，旧失败不污染新池。
 * 5. 重试上限耗尽 → suspended，停止续试，并固化最后一处失败节点。
 * 6. 配置修改走 configVersion 乐观锁，只接受字段完整的整配置；冲突/失败不动重试次数。
 * 7. 写权限：仅负责人可写；共享连接池对所有人只读。
 */
import type {
  CheckReceipt,
  CheckResult,
  Eligibility,
  EventLevel,
  EventRecord,
  FailureInfo,
  HealthState,
  OpErrorCode,
  OpResult,
  Pool,
  PoolConfig,
  PoolStatus,
} from './types'

const EVENT_LIMIT = 200

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findPool(state: HealthState, poolId: string): Pool | undefined {
  return state.pools.find((pool) => pool.id === poolId)
}

/** 追加审计事件；超出上限只保留最新的 EVENT_LIMIT 条。 */
function pushEvent(
  events: EventRecord[],
  level: EventLevel,
  scope: string,
  message: string,
  at: number,
): EventRecord[] {
  const nextId = events.length === 0 ? 1 : events[events.length - 1].id + 1
  const record: EventRecord = { id: nextId, at, level, scope, message }
  return [...events, record].slice(-EVENT_LIMIT)
}

function fail(
  state: HealthState,
  code: OpErrorCode,
  message: string,
  at: number,
  scope = 'system',
  level: EventLevel = 'warn',
): OpResult {
  // 失败请求本身留痕，但不改动任何业务计数（包括剩余重试次数）。
  const events = pushEvent(state.events, level, scope, message, at)
  return { ok: false, state: { ...state, events }, code, message }
}

/** 写权限闸门：非负责人拒绝；共享连接池对所有人只读。 */
function assertWritable(
  state: HealthState,
  pool: Pool,
  actor: string,
  at: number,
): OpResult | null {
  if (pool.config.shared) {
    return fail(
      state,
      'FORBIDDEN_SHARED',
      `连接池「${pool.name}」是共享连接池，所有成员仅可查看，不能改动`,
      at,
      pool.id,
    )
  }
  if (actor !== pool.owner) {
    return fail(
      state,
      'FORBIDDEN_OWNER',
      `连接池「${pool.name}」归属负责人 ${pool.owner}，${actor} 只有查看权限`,
      at,
      pool.id,
    )
  }
  return null
}

/** 一次检查里当前被判定为失败的地址，续试只打这些地址。 */
export function failedEndpoints(pool: Pool): string[] {
  return pool.endpoints.filter((endpoint) => endpoint.outcome === 'failed').map((endpoint) => endpoint.id)
}

export function canAcceptWork(pool: Pool): boolean {
  return pool.eligibility === 'eligible'
}

export interface PoolSummary {
  total: number
  connected: number
  checkFailed: number
  suspended: number
  recovering: number
  pending: number
  blocked: number
  blockedPipelineNodes: number
}

export function summarize(state: HealthState): PoolSummary {
  const blockedPoolIds = new Set(
    state.pools.filter((pool) => pool.eligibility === 'blocked').map((pool) => pool.id),
  )
  const count = (status: PoolStatus) => state.pools.filter((pool) => pool.status === status).length
  return {
    total: state.pools.length,
    connected: count('connected'),
    checkFailed: count('check_failed'),
    suspended: count('suspended'),
    recovering: count('recovering'),
    pending: count('pending'),
    blocked: blockedPoolIds.size,
    blockedPipelineNodes: state.pipelineNodes.filter((node) => blockedPoolIds.has(node.poolId)).length,
  }
}

/**
 * 把一份检查回执落到连接池上。调用前已完成权限、序号、版本校验。
 * 同一池在同一次检查中要么全成功、要么按失败处理；剩余次数按「检查轮次」扣减，
 * 与失败地址个数无关。
 */
function applyReceipt(base: HealthState, pool: Pool, receipt: CheckReceipt): HealthState {
  const state = clone(base)
  const target = findPool(state, pool.id)!
  const at = receipt.at
  const byAddress = new Map(receipt.results.map((result) => [result.addressId, result]))
  let events = state.events

  for (const endpoint of target.endpoints) {
    const result = byAddress.get(endpoint.id)
    if (!result) {
      continue
    }
    endpoint.outcome = result.ok ? 'success' : 'failed'
    endpoint.lastCheckSeq = receipt.seq
    endpoint.lastAt = at
    if (!result.ok) {
      endpoint.lastReason = result.reason || '检查失败'
      events = pushEvent(
        events,
        'warn',
        target.id,
        `地址 ${endpoint.node}（${endpoint.url}）本次检查失败：${endpoint.lastReason}`,
        at,
      )
    }
  }

  const hadFailure = receipt.results.some((result) => !result.ok)
  const allSuccess = target.endpoints.every((endpoint) => endpoint.outcome === 'success')
  target.lastCheckSeq = Math.max(target.lastCheckSeq, receipt.seq)

  if (hadFailure) {
    target.remainingAttempts -= 1
    const failedList = receipt.results.filter((result) => !result.ok)
    const last = failedList[failedList.length - 1]
    const endpoint = target.endpoints.find((item) => item.id === last.addressId)!
    const attempt = target.config.retryLimit - target.remainingAttempts

    if (target.remainingAttempts <= 0) {
      // 重试预算耗尽：失去连接资格，停止续试，固化最后一处失败节点。
      target.remainingAttempts = 0
      target.status = 'suspended'
      target.eligibility = 'blocked'
      target.suspendedAt = at
      const failure: FailureInfo = {
        addressId: endpoint.id,
        node: endpoint.node,
        url: endpoint.url,
        reason: endpoint.lastReason || '检查失败',
        at,
        checkSeq: receipt.seq,
        credentialVersion: target.credentialVersion,
        attempt,
      }
      target.lastFailure = failure
      events = pushEvent(
        events,
        'error',
        target.id,
        `重试上限已耗尽（第 ${attempt} 次尝试），连接池挂起、停止续试；最后一处失败节点：${failure.node}（${failure.url}），原因：${failure.reason}`,
        at,
      )
    } else {
      // 只是「本次失败」：资格暂时关闭等续试，但连接池尚未失去资格。
      target.status = 'check_failed'
      target.eligibility = 'blocked'
      events = pushEvent(
        events,
        'warn',
        target.id,
        `第 ${attempt} 次检查存在失败地址，剩余重试 ${target.remainingAttempts} 次，续试仅覆盖失败地址`,
        at,
      )
    }
  } else if (allSuccess) {
    // 当前凭据版本上所有地址均成功：恢复/获得连接资格，重试预算重置。
    const previous = target.status
    target.status = 'connected'
    target.eligibility = 'eligible'
    target.remainingAttempts = target.config.retryLimit
    target.lastFailure = undefined
    target.suspendedAt = undefined
    events = pushEvent(
      events,
      'info',
      target.id,
      previous === 'recovering'
        ? `凭据版本 v${target.credentialVersion} 首次完整检查通过，连接资格恢复`
        : `完整检查全部成功，连接池保持可接活，剩余重试已重置为 ${target.config.retryLimit} 次`,
      at,
    )
  }

  target.updatedAt = at
  return { ...state, events }
}

export interface RunCheckInput {
  poolId: string
  actor: string
  /** full：全量检查；failed：只续试当前失败地址。 */
  mode: 'full' | 'failed'
  results: CheckResult[]
  now: number
}

/** 发起一次检查并应用结果。挂起池不得续试，必须先轮换凭据进入恢复探测。 */
export function runCheck(state: HealthState, input: RunCheckInput): OpResult {
  const pool = findPool(state, input.poolId)
  if (!pool) {
    return fail(state, 'NOT_FOUND', `没有找到连接池 ${input.poolId}`, input.now)
  }
  const denied = assertWritable(state, pool, input.actor, input.now)
  if (denied) {
    return denied
  }
  if (pool.status === 'suspended') {
    return fail(
      state,
      'SUSPENDED',
      `连接池「${pool.name}」已达重试上限并挂起，续试已停止；请轮换凭据产生新版本后再检查`,
      input.now,
      pool.id,
      'error',
    )
  }
  if (input.results.length === 0) {
    return fail(state, 'INVALID_CHECK', '检查结果不能为空', input.now, pool.id)
  }
  const known = new Set(pool.endpoints.map((endpoint) => endpoint.id))
  if (input.results.some((result) => !known.has(result.addressId))) {
    return fail(state, 'INVALID_CHECK', '检查结果包含不属于该连接池的地址', input.now, pool.id)
  }

  const failed = failedEndpoints(pool)
  if (input.mode === 'failed') {
    if (failed.length === 0) {
      return fail(state, 'INVALID_CHECK', '当前没有失败地址，应执行全量检查', input.now, pool.id)
    }
    const targets = new Set(failed)
    if (input.results.some((result) => !targets.has(result.addressId))) {
      return fail(state, 'INVALID_CHECK', '续试只能覆盖当前失败地址', input.now, pool.id)
    }
    const covered = new Set(input.results.map((result) => result.addressId))
    if (failed.some((addressId) => !covered.has(addressId))) {
      return fail(state, 'INVALID_CHECK', '续试必须覆盖全部失败地址', input.now, pool.id)
    }
  }

  const receipt: CheckReceipt = {
    seq: pool.lastCheckSeq + 1,
    credentialVersion: pool.credentialVersion,
    at: input.now,
    results: input.results,
  }
  const next = applyReceipt(state, pool, receipt)
  return { ok: true, state: next }
}

/**
 * 应用外部迟到的检查回执。两道新鲜度闸门：
 * - 凭据版本不一致：旧凭据的结果不能污染新连接池；
 * - 序号不大于已应用序号：迟到回执丢弃，成功结果不被倒推。
 */
export function applyLateReceipt(
  state: HealthState,
  poolId: string,
  receipt: CheckReceipt,
  now: number,
): OpResult {
  const pool = findPool(state, poolId)
  if (!pool) {
    return fail(state, 'NOT_FOUND', `没有找到连接池 ${poolId}`, now)
  }
  if (receipt.credentialVersion !== pool.credentialVersion) {
    return fail(
      state,
      'OLD_VERSION_RECEIPT',
      `回执来自旧凭据版本 v${receipt.credentialVersion}，当前为 v${pool.credentialVersion}，旧凭据失败已忽略`,
      now,
      pool.id,
    )
  }
  if (receipt.seq <= pool.lastCheckSeq) {
    return fail(
      state,
      'STALE_RECEIPT',
      `检查 #${receipt.seq} 的回执晚于已应用的 #${pool.lastCheckSeq}，迟到回执已丢弃，既有结果保持不变`,
      now,
      pool.id,
    )
  }
  if (pool.status === 'suspended') {
    return fail(
      state,
      'SUSPENDED',
      `连接池「${pool.name}」已达重试上限并停止续试，同版本回执不再应用；请先轮换凭据产生新版本`,
      now,
      pool.id,
      'error',
    )
  }
  const known = new Set(pool.endpoints.map((endpoint) => endpoint.id))
  if (receipt.results.length === 0 || receipt.results.some((result) => !known.has(result.addressId))) {
    return fail(state, 'INVALID_CHECK', '回执地址不属于该连接池', now, pool.id)
  }
  const next = applyReceipt(state, pool, receipt)
  return { ok: true, state: next }
}

export interface UpdateConfigInput {
  poolId: string
  actor: string
  expectedConfigVersion: number
  config: PoolConfig
  now: number
}

/** 整配置修改：乐观锁 + 完整字段校验；凭据引用不允许从这里换，共享位不可改。 */
export function updateConfig(state: HealthState, input: UpdateConfigInput): OpResult {
  const pool = findPool(state, input.poolId)
  if (!pool) {
    return fail(state, 'NOT_FOUND', `没有找到连接池 ${input.poolId}`, input.now)
  }
  const denied = assertWritable(state, pool, input.actor, input.now)
  if (denied) {
    return denied
  }
  if (input.expectedConfigVersion !== pool.configVersion) {
    return fail(
      state,
      'CONFIG_CONFLICT',
      `配置已被其他负责人更新（当前版本 v${pool.configVersion}，你基于 v${input.expectedConfigVersion}），本次完整配置未接受，请回读后重新提交`,
      input.now,
      pool.id,
    )
  }
  const candidate = input.config
  if (
    !candidate.type.trim() ||
    !candidate.credentialRef.trim() ||
    !Number.isInteger(candidate.poolSize) ||
    candidate.poolSize <= 0 ||
    candidate.timeoutSec <= 0 ||
    !Number.isInteger(candidate.retryLimit) ||
    candidate.retryLimit <= 0
  ) {
    return fail(state, 'CONFIG_INCOMPLETE', '配置字段不完整或取值非法，只接受字段齐全的完整配置', input.now, pool.id)
  }
  if (candidate.credentialRef !== pool.config.credentialRef) {
    return fail(
      state,
      'CREDENTIAL_VIA_CONFIG',
      '凭据引用不能随普通配置修改，请使用「轮换凭据」产生新检查版本',
      input.now,
      pool.id,
    )
  }
  if (candidate.shared !== pool.config.shared) {
    return fail(state, 'CONFIG_INCOMPLETE', '共享属性只能在建池时指定，配置修改不允许变更', input.now, pool.id)
  }

  const next = clone(state)
  const target = findPool(next, input.poolId)!
  target.config = { ...candidate }
  target.configVersion += 1
  target.updatedAt = input.now
  const events = pushEvent(
    next.events,
    'info',
    target.id,
    `${input.actor} 提交的完整配置已接受，配置版本推进到 v${target.configVersion}`,
    input.now,
  )
  return { ok: true, state: { ...next, events } }
}

export interface RotateCredentialInput {
  poolId: string
  actor: string
  expectedConfigVersion: number
  newCredentialRef: string
  now: number
}

/** 轮换凭据：开新检查版本，旧失败/挂起结论全部隔离在旧版本里。 */
export function rotateCredential(state: HealthState, input: RotateCredentialInput): OpResult {
  const pool = findPool(state, input.poolId)
  if (!pool) {
    return fail(state, 'NOT_FOUND', `没有找到连接池 ${input.poolId}`, input.now)
  }
  const denied = assertWritable(state, pool, input.actor, input.now)
  if (denied) {
    return denied
  }
  if (input.expectedConfigVersion !== pool.configVersion) {
    return fail(
      state,
      'CONFIG_CONFLICT',
      `配置已被其他负责人更新（当前 v${pool.configVersion}），请回读最终配置后再轮换凭据`,
      input.now,
      pool.id,
    )
  }
  if (!input.newCredentialRef.trim()) {
    return fail(state, 'CONFIG_INCOMPLETE', '新凭据标识不能为空', input.now, pool.id)
  }

  const next = clone(state)
  const target = findPool(next, input.poolId)!
  const previousStatus = target.status
  target.credentialVersion += 1
  target.configVersion += 1
  target.config.credentialRef = input.newCredentialRef.trim()
  target.endpoints = target.endpoints.map((endpoint) => ({
    ...endpoint,
    outcome: 'unknown' as const,
    lastReason: undefined,
    lastAt: undefined,
    lastCheckSeq: undefined,
  }))
  target.remainingAttempts = target.config.retryLimit
  target.lastFailure = undefined
  target.suspendedAt = undefined
  target.eligibility = 'blocked'
  target.status = previousStatus === 'suspended' ? 'recovering' : 'pending'
  target.updatedAt = input.now
  const events = pushEvent(
    next.events,
    'info',
    target.id,
    `${input.actor} 轮换凭据，新检查版本 v${target.credentialVersion} 已生成；旧版本检查结果与失败计数不再影响本池，状态「${target.status}」，资格恢复前不接活`,
    input.now,
  )
  return { ok: true, state: { ...next, events } }
}

export interface AttemptWorkInput {
  nodeId: string
  now: number
}

/** 流水线派活：资格闸门关闭时直接拒绝，拒绝动作不消耗重试预算。 */
export function attemptWork(state: HealthState, input: AttemptWorkInput): OpResult {
  const node = state.pipelineNodes.find((item) => item.id === input.nodeId)
  if (!node) {
    return fail(state, 'NOT_FOUND', `没有找到流水线节点 ${input.nodeId}`, input.now)
  }
  const pool = findPool(state, node.poolId)
  if (!pool) {
    return fail(state, 'NOT_FOUND', `节点绑定的连接池 ${node.poolId} 不存在`, input.now, node.id)
  }
  if (pool.eligibility !== ('eligible' as Eligibility)) {
    return fail(
      state,
      'PIPELINE_BLOCKED',
      `连接池「${pool.name}」当前为「${pool.status}」、连接资格未恢复，流水线节点「${node.name}」不得接活`,
      input.now,
      node.id,
      'error',
    )
  }
  const next = clone(state)
  const targetNode = next.pipelineNodes.find((item) => item.id === input.nodeId)!
  targetNode.status = 'dispatched'
  targetNode.lastDispatchAt = input.now
  const events = pushEvent(
    next.events,
    'info',
    targetNode.id,
    `流水线节点「${targetNode.name}」已从连接池「${pool.name}」接活`,
    input.now,
  )
  return { ok: true, state: { ...next, events } }
}

export interface CreatePoolInput {
  code: string
  name: string
  owner: string
  config: PoolConfig
  endpointSpecs: { node: string; url: string }[]
  now: number
}

/** 建池：供种子数据与测试使用，初始无检查结论、资格关闭。 */
export function createPool(state: HealthState, input: CreatePoolInput): OpResult {
  if (state.pools.some((pool) => pool.code === input.code)) {
    return fail(state, 'CONFIG_INCOMPLETE', `配置编号 ${input.code} 已存在`, input.now)
  }
  if (input.endpointSpecs.length === 0) {
    return fail(state, 'CONFIG_INCOMPLETE', '连接池至少需要一个接入地址', input.now)
  }
  const next = clone(state)
  const pool: Pool = {
    id: `pool-${input.code}`,
    code: input.code,
    name: input.name,
    owner: input.owner,
    configVersion: 1,
    credentialVersion: 1,
    config: { ...input.config },
    status: 'pending',
    eligibility: 'blocked',
    remainingAttempts: input.config.retryLimit,
    endpoints: input.endpointSpecs.map((spec, index) => ({
      id: `ep-${input.code}-${index + 1}`,
      node: spec.node,
      url: spec.url,
      outcome: 'unknown',
    })),
    lastCheckSeq: 0,
    updatedAt: input.now,
  }
  next.pools = [...next.pools, pool]
  next.events = pushEvent(next.events, 'info', pool.id, `连接池「${pool.name}」已登记，等待首次检查`, input.now)
  return { ok: true, state: next }
}
