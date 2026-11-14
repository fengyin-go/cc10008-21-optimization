import { useMemo, useState } from 'react'

import type { CheckReceipt, CheckResult, Pool } from '@/domain/health/types'
import type { HealthStore } from '@/domain/health/store'
import { failedEndpoints } from '@/domain/health/engine'
import Modal from './Modal'

interface CheckModalProps {
  pool: Pool
  actor: string
  store: HealthStore
  onClose: () => void
}

/**
 * 检查弹窗：
 * - 自动选择检查范围：存在失败地址时只续试失败地址，否则全量检查；
 * - 另提供「模拟迟到回执」区，可指定序号与凭据版本，用来演示两道新鲜度闸门。
 */
export default function CheckModal({ pool, actor, store, onClose }: CheckModalProps) {
  const retryTargets = useMemo(() => failedEndpoints(pool), [pool])
  const mode: 'full' | 'failed' = retryTargets.length > 0 ? 'failed' : 'full'
  const scopeIds = mode === 'failed' ? retryTargets : pool.endpoints.map((endpoint) => endpoint.id)

  const [choices, setChoices] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(scopeIds.map((id) => [id, true])),
  )
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [lateEnabled, setLateEnabled] = useState(false)
  const [lateSeq, setLateSeq] = useState(Math.max(1, pool.lastCheckSeq))
  const [lateVersion, setLateVersion] = useState(pool.credentialVersion)

  const scopeEndpoints = pool.endpoints.filter((endpoint) => scopeIds.includes(endpoint.id))

  function submit() {
    const results: CheckResult[] = scopeEndpoints.map((endpoint) => ({
      addressId: endpoint.id,
      ok: choices[endpoint.id] ?? true,
      ...(choices[endpoint.id] === false ? { reason: reasons[endpoint.id]?.trim() || '连接超时' } : {}),
    }))

    if (lateEnabled) {
      const receipt: CheckReceipt = {
        seq: Number(lateSeq),
        credentialVersion: Number(lateVersion),
        at: Date.now(),
        results,
      }
      store.applyLateReceipt(pool.id, actor, receipt)
    } else {
      store.runCheck(pool.id, actor, mode, results)
    }
    onClose()
  }

  return (
    <Modal
      title={`执行检查 · ${pool.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="modal-hint">
            {mode === 'failed' ? `续试模式：仅覆盖 ${retryTargets.length} 个失败地址` : '全量模式：覆盖全部接入地址'}
          </span>
          <button className="btn primary" type="button" onClick={submit}>提交检查结果</button>
        </>
      }
    >
      <p className="form-note">
        检查序号当前为 #{pool.lastCheckSeq}，凭据版本 v{pool.credentialVersion}。
        单个地址超时只会标记「本次失败」，只有重试上限耗尽才会失去连接资格。
      </p>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>节点 / 地址</th>
            <th>最近结果</th>
            <th>本次结果</th>
            <th>失败原因</th>
          </tr>
        </thead>
        <tbody>
          {scopeEndpoints.map((endpoint) => {
            const isOk = choices[endpoint.id] ?? true
            return (
              <tr key={endpoint.id}>
                <td>
                  <strong>{endpoint.node}</strong>
                  <span className="cell-sub">{endpoint.url}</span>
                </td>
                <td>
                  {endpoint.outcome === 'unknown' && '未检查'}
                  {endpoint.outcome === 'success' && <span className="ok-text">成功</span>}
                  {endpoint.outcome === 'failed' && <span className="error-text">失败：{endpoint.lastReason}</span>}
                </td>
                <td>
                  <label className="inline-choice">
                    <input
                      type="radio"
                      name={`result-${endpoint.id}`}
                      checked={isOk}
                      onChange={() => setChoices((prev) => ({ ...prev, [endpoint.id]: true }))}
                    />
                    成功
                  </label>
                  <label className="inline-choice">
                    <input
                      type="radio"
                      name={`result-${endpoint.id}`}
                      checked={!isOk}
                      onChange={() => setChoices((prev) => ({ ...prev, [endpoint.id]: false }))}
                    />
                    失败
                  </label>
                </td>
                <td>
                  <input
                    disabled={isOk}
                    placeholder="如：连接超时"
                    value={reasons[endpoint.id] ?? ''}
                    onChange={(event) => setReasons((prev) => ({ ...prev, [endpoint.id]: event.target.value }))}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <section className="late-box">
        <label className="inline-choice strong">
          <input type="checkbox" checked={lateEnabled} onChange={(event) => setLateEnabled(event.target.checked)} />
          模拟外部迟到回执（不立即应用，按序号/版本走新鲜度校验）
        </label>
        {lateEnabled && (
          <div className="late-grid">
            <label className="filter-item">
              <span>回执检查序号</span>
              <input type="number" value={lateSeq} onChange={(event) => setLateSeq(Number(event.target.value))} />
            </label>
            <label className="filter-item">
              <span>回执凭据版本</span>
              <input type="number" value={lateVersion} onChange={(event) => setLateVersion(Number(event.target.value))} />
            </label>
            <div className="late-presets">
              <button
                className="btn ghost"
                type="button"
                onClick={() => { setLateSeq(pool.lastCheckSeq); setLateVersion(pool.credentialVersion) }}
              >
                填成迟到（同版本旧序号）
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => { setLateSeq(pool.lastCheckSeq + 1); setLateVersion(Math.max(1, pool.credentialVersion - 1)) }}
              >
                填成旧凭据版本
              </button>
            </div>
          </div>
        )}
      </section>
    </Modal>
  )
}
