/** 健康检查域种子数据：首次进入时播种，之后以 localStorage 中的状态为准。 */
import { createPool } from './engine'
import type { CreatePoolInput } from './engine'
import type { HealthState, PoolConfig } from './types'

/** 演示用成员；负责人字段与写权限校验都基于这里的账号。 */
export const DEMO_USERS = [
  { account: 'zhangwei', name: '张伟' },
  { account: 'lina', name: '李娜' },
  { account: 'wangqiang', name: '王强' },
] as const

const BASE_TS = Date.UTC(2026, 10, 10, 2, 0, 0)

function poolConfig(partial: Partial<PoolConfig> & Pick<PoolConfig, 'type' | 'credentialRef'>): PoolConfig {
  return {
    poolSize: 10,
    timeoutSec: 5,
    retryLimit: 3,
    shared: false,
    ...partial,
  }
}

export function buildSeedState(now: number = BASE_TS): HealthState {
  let state: HealthState = { pools: [], pipelineNodes: [], events: [] }

  const seeds: CreatePoolInput[] = [
    {
      code: 'SRC-0001',
      name: '订单主库连接池',
      owner: 'zhangwei',
      now,
      config: poolConfig({ type: 'MySQL', credentialRef: 'cred-order-rw@v1', poolSize: 16, timeoutSec: 4, retryLimit: 3 }),
      endpointSpecs: [
        { node: 'order-db-01', url: 'jdbc:mysql://order-db-01:3306/orders' },
        { node: 'order-db-02', url: 'jdbc:mysql://order-db-02:3306/orders' },
        { node: 'order-db-03', url: 'jdbc:mysql://order-db-03:3306/orders' },
      ],
    },
    {
      code: 'SRC-0002',
      name: '会员行为消息池',
      owner: 'lina',
      now,
      config: poolConfig({ type: 'Kafka', credentialRef: 'cred-kafka-sasl@v1', poolSize: 8, timeoutSec: 6, retryLimit: 2 }),
      endpointSpecs: [
        { node: 'kafka-broker-01', url: 'kafka-broker-01:9093' },
        { node: 'kafka-broker-02', url: 'kafka-broker-02:9093' },
      ],
    },
    {
      code: 'SRC-0003',
      name: '风控特征库连接池',
      owner: 'wangqiang',
      now,
      config: poolConfig({ type: 'PostgreSQL', credentialRef: 'cred-risk-ro@v1', poolSize: 12, timeoutSec: 5, retryLimit: 3 }),
      endpointSpecs: [
        { node: 'risk-pg-01', url: 'jdbc:postgresql://risk-pg-01:5432/features' },
        { node: 'risk-pg-02', url: 'jdbc:postgresql://risk-pg-02:5432/features' },
      ],
    },
    {
      code: 'SRC-0004',
      name: '共享埋点仓库',
      owner: 'zhangwei',
      now,
      config: poolConfig({ type: 'S3', credentialRef: 'cred-s3-shared@v1', poolSize: 6, timeoutSec: 8, retryLimit: 3, shared: true }),
      endpointSpecs: [
        { node: 's3-endpoint-az1', url: 'https://s3-az1.example.com/track-bucket' },
        { node: 's3-endpoint-az2', url: 'https://s3-az2.example.com/track-bucket' },
      ],
    },
  ]

  for (const seed of seeds) {
    const result = createPool(state, seed)
    if (!result.ok) {
      throw new Error(result.message)
    }
    state = result.state
  }

  state.pipelineNodes = [
    { id: 'PIPE-01', name: '订单同步节点', poolId: 'pool-SRC-0001', status: 'idle' },
    { id: 'PIPE-02', name: '会员画像节点', poolId: 'pool-SRC-0002', status: 'idle' },
    { id: 'PIPE-03', name: '风控打分节点', poolId: 'pool-SRC-0003', status: 'idle' },
    { id: 'PIPE-04', name: '埋点归档节点', poolId: 'pool-SRC-0004', status: 'idle' },
  ]

  return state
}
