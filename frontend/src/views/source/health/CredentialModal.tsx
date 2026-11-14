import { useState } from 'react'

import type { Pool } from '@/domain/health/types'
import type { HealthStore } from '@/domain/health/store'
import Modal from './Modal'

interface CredentialModalProps {
  pool: Pool
  actor: string
  store: HealthStore
  onClose: () => void
}

/**
 * 凭据轮换弹窗：轮换后 credentialVersion 自增，开启新检查版本，
 * 旧版本失败结论与迟到回执都无法再写入新池。
 */
export default function CredentialModal({ pool, actor, store, onClose }: CredentialModalProps) {
  const [nextRef, setNextRef] = useState(() => {
    const match = /^(.*?)@v(\d+)$/.exec(pool.config.credentialRef)
    if (!match) {
      return `${pool.config.credentialRef}@v2`
    }
    return `${match[1]}@v${Number(match[2]) + 1}`
  })

  function submit() {
    const result = store.rotateCredential(pool.id, actor, pool.configVersion, nextRef)
    if (result.ok) {
      onClose()
    }
  }

  return (
    <Modal
      title={`轮换连接凭据 · ${pool.name}`}
      onClose={onClose}
      footer={<button className="btn primary" type="button" onClick={submit}>确认轮换并生成新版本</button>}
    >
      <div className="form-grid">
        <label className="filter-item readonly">
          <span>当前凭据引用</span>
          <input value={pool.config.credentialRef} readOnly />
        </label>
        <label className="filter-item readonly">
          <span>当前凭据版本</span>
          <input value={`v${pool.credentialVersion}`} readOnly />
        </label>
        <label className="filter-item">
          <span>新凭据引用</span>
          <input value={nextRef} onChange={(event) => setNextRef(event.target.value)} />
        </label>
      </div>
      <ul className="form-note">
        <li>轮换后产生凭据版本 v{pool.credentialVersion + 1}，所有地址回到「未检查」，重试预算重置为上限 {pool.config.retryLimit} 次。</li>
        <li>{pool.status === 'suspended' ? '当前已挂起，轮换后进入「恢复探测」，新版本首次完整检查成功才恢复接活资格。' : '轮换后状态变为「待检查」，资格恢复前流水线不得接活。'}</li>
        <li>旧凭据版本的迟到回执将以 OLD_VERSION_RECEIPT 拒绝，旧失败不会污染新连接池。</li>
      </ul>
    </Modal>
  )
}
