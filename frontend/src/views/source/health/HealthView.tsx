import { useMemo, useState } from 'react'

import { summarize } from '@/domain/health/engine'
import { useHealthStore } from '@/domain/health/store'
import { DEMO_USERS } from '@/domain/health/seed'
import type { Pool } from '@/domain/health/types'
import { POOL_STATUS_LABEL, formatTime } from './labels'
import PoolCard from './PoolCard'
import PipelineGate from './PipelineGate'
import CheckModal from './CheckModal'
import ConfigModal from './ConfigModal'
import CredentialModal from './CredentialModal'

type ModalKind = 'check' | 'config' | 'credential' | null

/**
 * 数据源接入 · 连接池健康检查工作台。
 * 页面每次渲染都回读 store 中已持久化的最终资格；刷新恢复后可直接从失败地址续试。
 */
export default function HealthView() {
  const store = useHealthStore()
  const { state } = store
  const [actor, setActor] = useState<string>(DEMO_USERS[0].account)
  const [modal, setModal] = useState<ModalKind>(null)
  const [activePool, setActivePool] = useState<Pool | null>(null)
  const [keyword, setKeyword] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [showEvents, setShowEvents] = useState(false)

  const summary = useMemo(() => summarize(state), [state])
  const pools = useMemo(() => {
    const word = keyword.trim()
    return state.pools.filter((pool) => {
      const matchWord =
        word === '' ||
        pool.name.includes(word) ||
        pool.code.includes(word) ||
        pool.endpoints.some((endpoint) => endpoint.url.includes(word) || endpoint.node.includes(word))
      const matchFilter = !onlyFailed || pool.status === 'check_failed' || pool.status === 'suspended' || pool.status === 'recovering'
      return matchWord && matchFilter
    })
  }, [state.pools, keyword, onlyFailed])

  function open(kind: Exclude<ModalKind, null>, pool: Pool) {
    setActivePool(pool)
    setModal(kind)
  }

  // 弹窗里的 pool 要始终取 store 中的最新引用，保证回读到的是最终配置版本。
  const livePool = activePool ? state.pools.find((pool) => pool.id === activePool.id) ?? null : null

  return (
    <section className="page health-page" data-module="source">
      <header className="page-head">
        <div>
          <h2>数据源接入 · 连接池健康检查</h2>
          <p className="page-desc">
            区分「本次失败」与「失去连接资格」：单次超时仅标记失败地址并按剩余次数续试，重试上限耗尽才挂起；
            凭据轮换生成新检查版本，流水线在资格恢复前不得接活。
          </p>
        </div>
        <div className="page-actions">
          <label className="actor-switch">
            当前身份
            <select value={actor} onChange={(event) => setActor(event.target.value)}>
              {DEMO_USERS.map((user) => (
                <option key={user.account} value={user.account}>
                  {user.name}（{user.account}）
                </option>
              ))}
            </select>
          </label>
          <button className="btn ghost" type="button" onClick={() => setShowEvents((value) => !value)}>
            {showEvents ? '收起审计事件' : '查看审计事件'}
          </button>
          <button className="btn ghost" type="button" onClick={store.resetAll}>重置演示数据</button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">连接池总数</span>
          <strong className="stat-value">{summary.total}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已连接（可接活）</span>
          <strong className="stat-value ok-text">{summary.connected}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">本次失败（仍有重试）</span>
          <strong className="stat-value warn-text">{summary.checkFailed}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">资格挂起</span>
          <strong className="stat-value error-text">{summary.suspended}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">恢复探测</span>
          <strong className="stat-value">{summary.recovering}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">被阻断流水线节点</span>
          <strong className="stat-value error-text">{summary.blockedPipelineNodes}</strong>
        </article>
      </div>

      <form className="filter-bar" onSubmit={(event) => event.preventDefault()}>
        <label className="filter-item">
          <span>按名称 / 编号 / 地址检索</span>
          <input value={keyword} placeholder="输入关键字" onChange={(event) => setKeyword(event.target.value)} />
        </label>
        <label className="inline-choice strong">
          <input type="checkbox" checked={onlyFailed} onChange={(event) => setOnlyFailed(event.target.checked)} />
          只看异常 / 恢复中连接池
        </label>
      </form>

      {store.lastError && (
        <div className="error-banner" role="alert">
          <span>{store.lastError}</span>
          <button className="link" type="button" onClick={store.clearError}>知道了</button>
        </div>
      )}

      <div className="pool-grid">
        {pools.map((pool) => (
          <PoolCard
            key={pool.id}
            pool={pool}
            actor={actor}
            store={store}
            onCheck={(target) => open('check', target)}
            onEditConfig={(target) => open('config', target)}
            onRotate={(target) => open('credential', target)}
          />
        ))}
        {pools.length === 0 && <p className="empty-state">没有符合条件的连接池</p>}
      </div>

      <PipelineGate state={state} store={store} />

      {showEvents && (
        <section className="event-panel">
          <header className="section-head">
            <h3>审计事件（最新在前，最多保留 200 条）</h3>
          </header>
          <ul className="event-list">
            {[...state.events].reverse().map((event) => (
              <li key={event.id} className={`event-item level-${event.level}`}>
                <span className="cell-sub">{formatTime(event.at)}</span>
                <span className="event-scope">{event.scope}</span>
                <span>{event.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {modal === 'check' && livePool && (
        <CheckModal pool={livePool} actor={actor} store={store} onClose={() => setModal(null)} />
      )}
      {modal === 'config' && livePool && (
        <ConfigModal pool={livePool} actor={actor} store={store} onClose={() => setModal(null)} />
      )}
      {modal === 'credential' && livePool && (
        <CredentialModal pool={livePool} actor={actor} store={store} onClose={() => setModal(null)} />
      )}

      <p className="status-legend">
        {Object.entries(POOL_STATUS_LABEL).map(([key, label]) => (
          <span key={key} className="legend-item">
            {label}：{state.pools.filter((pool) => pool.status === key).length}
          </span>
        ))}
      </p>
    </section>
  )
}
