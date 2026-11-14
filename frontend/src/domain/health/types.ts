/**
 * 连接池健康检查域 —— 类型定义。
 *
 * 设计要点：
 * - 「单次检查结果」与「连接资格」拆成两个维度：一次超时只产生检查失败，
 *   只有重试预算耗尽才会失去资格（suspended）。
 * - 凭据轮换产生新的 credentialVersion，旧版本的迟到回执无法再改动当前状态。
 * - 配置自带 configVersion 作为乐观锁，并发修改只接受一个完整配置。
 */

/** 连接池业务状态：描述当前处于检查生命周期的哪一段。 */
export type PoolStatus =
  | 'pending'        // 待检查：尚未在当前凭据版本上完成过检查
  | 'check_failed'   // 本次失败：有地址检查失败，但仍有剩余重试次数，资格尚未失去
  | 'connected'      // 已连接：当前版本最近一次完整检查全部成功，拥有接活资格
  | 'suspended'      // 资格挂起：重试上限耗尽，失去连接资格，续试停止
  | 'recovering'     // 恢复探测：挂起后轮换了凭据，等待新版本上的首次成功检查

/** 连接资格：流水线能否向该连接池派活，独立于单次检查成败。 */
export type Eligibility = 'eligible' | 'blocked'

/** 单个接入地址（节点）的最近检查结果。 */
export type AddressOutcome = 'unknown' | 'success' | 'failed'

export interface Endpoint {
  id: string
  /** 节点名，用于在挂起时说明「最后一处失败节点」。 */
  node: string
  /** 接入地址。 */
  url: string
  outcome: AddressOutcome
  /** 最近一次失败原因，如「连接超时」「握手被拒」。 */
  lastReason?: string
  lastAt?: number
  /** 最近一次落到该地址上的检查序号，用于识别迟到回执。 */
  lastCheckSeq?: number
}

/** 一次检查里某个地址的结果。 */
export interface CheckResult {
  addressId: string
  ok: boolean
  reason?: string
}

/** 外部迟到的检查回执：携带所属检查序号与凭据版本，供新鲜度判定。 */
export interface CheckReceipt {
  /** 该回执对应的检查序号，序号不大于已应用序号即视为迟到。 */
  seq: number
  credentialVersion: number
  at: number
  results: CheckResult[]
}

export interface PoolConfig {
  type: string
  poolSize: number
  timeoutSec: number
  retryLimit: number
  /** 凭据标识：仅展示脱敏引用，真实凭据不进浏览器存储。 */
  credentialRef: string
  /** 共享连接池对所有人保持只读。 */
  shared: boolean
}

/** 重试停止时记录的最后一处失败节点。 */
export interface FailureInfo {
  addressId: string
  node: string
  url: string
  reason: string
  at: number
  checkSeq: number
  credentialVersion: number
  /** 第几次尝试（从 1 开始），等于耗尽时的重试上限值。 */
  attempt: number
}

export interface Pool {
  id: string
  /** 配置编号，如 SRC-0001。 */
  code: string
  name: string
  /** 负责人账号：只有负责人能改动本池配置与凭据。 */
  owner: string
  /** 乐观锁版本：每次接受一次完整配置修改后自增。 */
  configVersion: number
  /** 凭据版本：轮换后自增，旧版本检查结果一律失效。 */
  credentialVersion: number
  config: PoolConfig
  status: PoolStatus
  eligibility: Eligibility
  /** 当前凭据版本上剩余的重试次数。 */
  remainingAttempts: number
  endpoints: Endpoint[]
  /** 已应用的最大检查序号，迟到回执靠它挡在门外。 */
  lastCheckSeq: number
  lastFailure?: FailureInfo
  suspendedAt?: number
  updatedAt: number
}

export type PipelineNodeStatus = 'idle' | 'dispatched'

export interface PipelineNode {
  id: string
  name: string
  /** 绑定的连接池 id；资格恢复前不得接活。 */
  poolId: string
  status: PipelineNodeStatus
  lastDispatchAt?: number
}

export type EventLevel = 'info' | 'warn' | 'error'

export interface EventRecord {
  id: number
  at: number
  level: EventLevel
  /** 关联对象：连接池 id / 流水线节点 id / 'system'。 */
  scope: string
  message: string
}

export interface HealthState {
  pools: Pool[]
  pipelineNodes: PipelineNode[]
  events: EventRecord[]
}

/** 引擎操作结果：失败也带回 state（通常未变）与稳定错误码，方便页面与测试断言。 */
export type OpResult<T = undefined> =
  | ({ ok: true; state: HealthState } & (T extends undefined ? { data?: T } : { data: T }))
  | { ok: false; state: HealthState; code: OpErrorCode; message: string }

export type OpErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN_OWNER'
  | 'FORBIDDEN_SHARED'
  | 'CONFIG_CONFLICT'
  | 'CONFIG_INCOMPLETE'
  | 'CREDENTIAL_VIA_CONFIG'
  | 'SUSPENDED'
  | 'INVALID_CHECK'
  | 'STALE_RECEIPT'
  | 'OLD_VERSION_RECEIPT'
  | 'PIPELINE_BLOCKED'
