import type { PoolStatus } from '@/domain/health/types'

export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  pending: '待检查',
  check_failed: '本次失败',
  connected: '已连接',
  suspended: '资格挂起',
  recovering: '恢复探测',
}

/** 「本次失败」与「失去连接资格」用不同颜色区分。 */
export const POOL_STATUS_CLASS: Record<PoolStatus, string> = {
  pending: 'badge badge-pending',
  check_failed: 'badge badge-failed',
  connected: 'badge badge-connected',
  suspended: 'badge badge-suspended',
  recovering: 'badge badge-recovering',
}

export function formatTime(value: number | undefined): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
