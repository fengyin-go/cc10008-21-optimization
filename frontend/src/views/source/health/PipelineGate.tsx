import type { HealthState } from '@/domain/health/types'
import type { HealthStore } from '@/domain/health/store'
import { POOL_STATUS_LABEL, formatTime } from './labels'

interface PipelineGateProps {
  state: HealthState
  store: HealthStore
}

/** 流水线接活闸门：只展示绑定连接池当前拥有资格的节点可以派活。 */
export default function PipelineGate({ state, store }: PipelineGateProps) {
  return (
    <section className="gate-panel">
      <header className="section-head">
        <h3>流水线接活闸门</h3>
        <span className="cell-sub">资格恢复前节点不得接活；被阻断的派活请求不消耗连接池重试次数</span>
      </header>
      <table className="data-table">
        <thead>
          <tr>
            <th>节点编号</th>
            <th>节点名称</th>
            <th>绑定连接池</th>
            <th>池状态 / 资格</th>
            <th>节点状态</th>
            <th>最近派活</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.pipelineNodes.map((node) => {
            const pool = state.pools.find((item) => item.id === node.poolId)
            const eligible = pool?.eligibility === 'eligible'
            return (
              <tr key={node.id}>
                <td>{node.id}</td>
                <td>{node.name}</td>
                <td>{pool ? `${pool.code} ${pool.name}` : '绑定池缺失'}</td>
                <td>
                  {pool && (
                    <>
                      <span>{POOL_STATUS_LABEL[pool.status]}</span>
                      <strong className={eligible ? 'ok-text' : 'error-text'}>
                        {' / '}{eligible ? '可接活' : '阻断'}
                      </strong>
                    </>
                  )}
                </td>
                <td>{node.status === 'dispatched' ? '已派活' : '空闲'}</td>
                <td><span className="cell-sub">{formatTime(node.lastDispatchAt)}</span></td>
                <td>
                  <button
                    className="link"
                    type="button"
                    disabled={!eligible}
                    title={eligible ? '' : '连接资格未恢复，禁止接活'}
                    onClick={() => store.attemptWork(node.id)}
                  >
                    尝试接活
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
