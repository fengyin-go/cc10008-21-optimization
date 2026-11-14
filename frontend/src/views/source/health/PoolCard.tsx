import type { Pool } from '@/domain/health/types'
import type { HealthStore } from '@/domain/health/store'
import { canAcceptWork, failedEndpoints } from '@/domain/health/engine'
import { POOL_STATUS_CLASS, POOL_STATUS_LABEL, formatTime } from './labels'

interface PoolCardProps {
  pool: Pool
  actor: string
  store: HealthStore
  onCheck: (pool: Pool) => void
  onEditConfig: (pool: Pool) => void
  onRotate: (pool: Pool) => void
}

/** 单个连接池卡片：把检查结果、资格、重试预算、失败节点分开呈现。 */
export default function PoolCard({ pool, actor, store, onCheck, onEditConfig, onRotate }: PoolCardProps) {
  const writable = !pool.config.shared && actor === pool.owner
  const failedIds = failedEndpoints(pool)
  const eligible = canAcceptWork(pool)

  return (
    <article className={`pool-card ${eligible ? 'is-eligible' : 'is-blocked'}`}>
      <header className="pool-head">
        <div>
          <h3>{pool.name}</h3>
          <span className="cell-sub">{pool.code} · 负责人 {pool.owner}{pool.config.shared ? ' · 共享只读' : ''}</span>
        </div>
        <span className={POOL_STATUS_CLASS[pool.status]}>{POOL_STATUS_LABEL[pool.status]}</span>
      </header>

      <div className="pool-qual">
        <div>
          <span className="stat-label">连接资格</span>
          <strong className={eligible ? 'ok-text' : 'error-text'}>{eligible ? '可接活' : '阻断中'}</strong>
        </div>
        <div>
          <span className="stat-label">剩余重试</span>
          <strong>{pool.remainingAttempts} / {pool.config.retryLimit}</strong>
        </div>
        <div>
          <span className="stat-label">检查序号 / 凭据版本</span>
          <strong>#{pool.lastCheckSeq} · v{pool.credentialVersion}</strong>
        </div>
        <div>
          <span className="stat-label">配置版本</span>
          <strong>v{pool.configVersion}</strong>
        </div>
      </div>

      <dl className="pool-meta">
        <div><dt>连接类型</dt><dd>{pool.config.type}</dd></div>
        <div><dt>连接池大小</dt><dd>{pool.config.poolSize}</dd></div>
        <div><dt>超时秒数</dt><dd>{pool.config.timeoutSec}s</dd></div>
        <div><dt>认证凭据</dt><dd>{pool.config.credentialRef}</dd></div>
      </dl>

      <table className="data-table compact endpoint-table">
        <thead>
          <tr>
            <th>节点</th>
            <th>接入地址</th>
            <th>最近检查</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {pool.endpoints.map((endpoint) => (
            <tr key={endpoint.id} className={endpoint.outcome === 'failed' ? 'row-failed' : ''}>
              <td>{endpoint.node}</td>
              <td><span className="cell-sub">{endpoint.url}</span></td>
              <td>
                {endpoint.outcome === 'unknown' && <span className="muted-text">未检查</span>}
                {endpoint.outcome === 'success' && <span className="ok-text">成功</span>}
                {endpoint.outcome === 'failed' && <span className="error-text">失败：{endpoint.lastReason}</span>}
              </td>
              <td><span className="cell-sub">{formatTime(endpoint.lastAt)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>

      {failedIds.length > 0 && pool.status !== 'suspended' && (
        <p className="retry-hint">续试将只覆盖失败地址：{failedIds.join('、')}</p>
      )}

      {pool.status === 'suspended' && pool.lastFailure && (
        <div className="failure-box">
          <strong>已达重试上限，续试停止。最后一处失败节点：</strong>
          <span>
            {pool.lastFailure.node}（{pool.lastFailure.url}）· 原因：{pool.lastFailure.reason} ·
            第 {pool.lastFailure.attempt} 次尝试 · {formatTime(pool.lastFailure.at)}
          </span>
        </div>
      )}

      <footer className="pool-actions">
        <button
          className="btn primary"
          type="button"
          disabled={!writable || pool.status === 'suspended'}
          title={!writable ? '仅负责人可执行检查' : pool.status === 'suspended' ? '挂起池需先轮换凭据' : ''}
          onClick={() => onCheck(pool)}
        >
          {failedIds.length > 0 ? '续试失败地址' : '执行全量检查'}
        </button>
        <button className="btn" type="button" disabled={!writable} title={!writable ? '仅负责人可修改配置' : ''} onClick={() => onEditConfig(pool)}>
          修改完整配置
        </button>
        <button className="btn" type="button" disabled={!writable} title={!writable ? '仅负责人可轮换凭据' : ''} onClick={() => onRotate(pool)}>
          轮换凭据
        </button>
      </footer>
    </article>
  )
}
