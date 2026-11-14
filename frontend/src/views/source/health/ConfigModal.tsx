import { useState } from 'react'

import type { Pool, PoolConfig } from '@/domain/health/types'
import type { HealthStore } from '@/domain/health/store'
import Modal from './Modal'

interface ConfigModalProps {
  pool: Pool
  actor: string
  store: HealthStore
  onClose: () => void
}

/**
 * 整配置编辑弹窗：
 * - 回读当前 configVersion 作为乐观锁期望值；
 * - 只提交字段齐全的完整配置，凭据引用与共享位在此处只读。
 */
export default function ConfigModal({ pool, actor, store, onClose }: ConfigModalProps) {
  const [form, setForm] = useState<PoolConfig>({ ...pool.config })

  function update<K extends keyof PoolConfig>(key: K, value: PoolConfig[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function submit() {
    const result = store.updateConfig(pool.id, actor, pool.configVersion, form)
    if (result.ok) {
      onClose()
    }
  }

  return (
    <Modal
      title={`修改完整配置 · ${pool.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="modal-hint">乐观锁：基于当前配置版本 v{pool.configVersion} 提交，冲突会被拒绝</span>
          <button className="btn primary" type="button" onClick={submit}>提交完整配置</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="filter-item">
          <span>连接类型</span>
          <input value={form.type} onChange={(event) => update('type', event.target.value)} />
        </label>
        <label className="filter-item">
          <span>连接池大小</span>
          <input
            type="number"
            min={1}
            value={form.poolSize}
            onChange={(event) => update('poolSize', Number(event.target.value))}
          />
        </label>
        <label className="filter-item">
          <span>超时秒数</span>
          <input
            type="number"
            min={1}
            value={form.timeoutSec}
            onChange={(event) => update('timeoutSec', Number(event.target.value))}
          />
        </label>
        <label className="filter-item">
          <span>重试上限</span>
          <input
            type="number"
            min={1}
            value={form.retryLimit}
            onChange={(event) => update('retryLimit', Number(event.target.value))}
          />
        </label>
        <label className="filter-item readonly">
          <span>认证凭据引用（只读，换凭据走「轮换凭据」）</span>
          <input value={form.credentialRef} readOnly />
        </label>
        <label className="filter-item readonly">
          <span>共享属性（只读）</span>
          <input value={form.shared ? '共享连接池' : '负责人私有'} readOnly />
        </label>
      </div>
      <p className="form-note">
        只接受字段齐全的完整配置；若期间有其他负责人已保存新版本，提交会收到 CONFIG_CONFLICT，
        请关闭弹窗重新回读后再改。失败请求不影响剩余重试次数。
      </p>
    </Modal>
  )
}
