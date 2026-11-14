/**
 * 健康检查域的 React 持久化层：
 * - 状态写 localStorage，页面刷新/重开后先回读最终资格（即被持久化的 eligibility/status）；
 * - 所有写操作都走领域引擎，store 只负责把引擎返回的新状态落盘；
 * - 引擎返回失败时原样保留旧状态，失败请求不会减少任何剩余重试次数。
 */
import { useCallback, useMemo, useState } from 'react'

import {
  applyLateReceipt as applyLateReceiptOp,
  attemptWork as attemptWorkOp,
  rotateCredential as rotateCredentialOp,
  runCheck as runCheckOp,
  updateConfig as updateConfigOp,
} from './engine'
import { buildSeedState } from './seed'
import type {
  CheckReceipt,
  CheckResult,
  HealthState,
  OpResult,
  PoolConfig,
} from './types'

const STORAGE_KEY = 'interactive-analytics-lab:health-state'
const STORAGE_VERSION = 1

type Persisted = { version: number; state: HealthState }

export interface StorageAdapter {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const browserStorage: StorageAdapter | null =
  typeof window !== 'undefined' && window.localStorage ? window.localStorage : null

export function loadState(adapter: StorageAdapter | null = browserStorage): HealthState {
  if (!adapter) {
    return buildSeedState()
  }
  const raw = adapter.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = buildSeedState()
    persistState(seed, adapter)
    return seed
  }
  try {
    const parsed = JSON.parse(raw) as Persisted
    if (parsed.version === STORAGE_VERSION && parsed.state && Array.isArray(parsed.state.pools)) {
      return parsed.state
    }
  } catch {
    // 存储损坏时回退种子，不让页面崩。
  }
  const seed = buildSeedState()
  persistState(seed, adapter)
  return seed
}

export function persistState(state: HealthState, adapter: StorageAdapter | null = browserStorage): void {
  if (!adapter) {
    return
  }
  const payload: Persisted = { version: STORAGE_VERSION, state }
  adapter.setItem(STORAGE_KEY, JSON.stringify(payload))
}

export function resetState(adapter: StorageAdapter | null = browserStorage): HealthState {
  const seed = buildSeedState()
  persistState(seed, adapter)
  return seed
}

export interface HealthStore {
  state: HealthState
  lastError: string
  clearError: () => void
  resetAll: () => void
  runCheck: (poolId: string, actor: string, mode: 'full' | 'failed', results: CheckResult[]) => OpResult
  applyLateReceipt: (poolId: string, actor: string, receipt: CheckReceipt) => OpResult
  updateConfig: (
    poolId: string,
    actor: string,
    expectedConfigVersion: number,
    config: PoolConfig,
  ) => OpResult
  rotateCredential: (
    poolId: string,
    actor: string,
    expectedConfigVersion: number,
    newCredentialRef: string,
  ) => OpResult
  attemptWork: (nodeId: string) => OpResult
}

/**
 * 所有写操作共用的落盘逻辑：
 * 成功 → 采用引擎返回的新状态；失败（含越权、冲突、迟到回执）→ 状态原样不动。
 */
export function useHealthStore(): HealthStore {
  const [state, setState] = useState<HealthState>(() => loadState())
  const [lastError, setLastError] = useState('')

  const commit = useCallback((result: OpResult): OpResult => {
    if (result.ok) {
      persistState(result.state)
      setState(result.state)
      setLastError('')
    } else {
      // 失败路径引擎只追加了事件、未改业务计数，同样落盘以保留审计痕迹。
      persistState(result.state)
      setState(result.state)
      setLastError(result.message)
    }
    return result
  }, [])

  const runCheck = useCallback(
    (poolId: string, actor: string, mode: 'full' | 'failed', results: CheckResult[]) =>
      commit(runCheckOp(state, { poolId, actor, mode, results, now: Date.now() })),
    [state, commit],
  )

  const applyLateReceipt = useCallback(
    (poolId: string, _actor: string, receipt: CheckReceipt) =>
      // 回执是外部检查系统的迟到回报，不属于成员写操作，因此不做负责人鉴权，
      // 但仍要过序号/凭据版本两道新鲜度闸门。
      commit(applyLateReceiptOp(state, poolId, receipt, Date.now())),
    [state, commit],
  )

  const updateConfig = useCallback(
    (poolId: string, actor: string, expectedConfigVersion: number, config: PoolConfig) =>
      commit(updateConfigOp(state, { poolId, actor, expectedConfigVersion, config, now: Date.now() })),
    [state, commit],
  )

  const rotateCredential = useCallback(
    (poolId: string, actor: string, expectedConfigVersion: number, newCredentialRef: string) =>
      commit(rotateCredentialOp(state, { poolId, actor, expectedConfigVersion, newCredentialRef, now: Date.now() })),
    [state, commit],
  )

  const attemptWork = useCallback(
    (nodeId: string) => commit(attemptWorkOp(state, { nodeId, now: Date.now() })),
    [state, commit],
  )

  const resetAll = useCallback(() => {
    setState(resetState())
    setLastError('')
  }, [])

  return useMemo(
    () => ({
      state,
      lastError,
      clearError: () => setLastError(''),
      resetAll,
      runCheck,
      applyLateReceipt,
      updateConfig,
      rotateCredential,
      attemptWork,
    }),
    [state, lastError, resetAll, runCheck, applyLateReceipt, updateConfig, rotateCredential, attemptWork],
  )
}
