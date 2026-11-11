type Waiter = {
  resolve: (release: (() => void) | null) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ChangeListener = (providerId: string, active: number) => void

/**
 * 每供应商的上游并发闸：槽位从请求开始持有到响应体结束。
 * 满员时路由层先用 tryAcquire 跳过该供应商；所有候选都满才用 acquire 排队。
 * 排队中的请求跟随客户端中断一起取消，避免 Claude Code 取消后仍占着队列。
 */
export class ProviderGate {
  private active = new Map<string, number>()
  private queues = new Map<string, Waiter[]>()
  private listeners: ChangeListener[] = []

  onChange(listener: ChangeListener): void {
    this.listeners.push(listener)
  }

  activeCount(providerId: string): number {
    return this.active.get(providerId) ?? 0
  }

  /** 非阻塞获取：满员或客户端已中断时返回 null，由调用方转向下一个候选。 */
  tryAcquire(providerId: string, limit: number, signal?: AbortSignal): (() => void) | null {
    if (signal?.aborted) return null
    if (Number.isFinite(limit) && limit > 0 && this.activeCount(providerId) >= limit) return null
    return this.track(providerId, limit)
  }

  /** 阻塞获取：仅在全部候选都满时使用，有槽位释放时按 FIFO 唤醒。 */
  async acquire(providerId: string, limit: number, signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return null
    if (!Number.isFinite(limit) || limit <= 0 || this.activeCount(providerId) < limit) {
      return this.track(providerId, limit)
    }
    return await new Promise((resolve) => {
      const queue = this.queues.get(providerId) ?? []
      const waiter: Waiter = { resolve, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          resolve(null)
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      queue.push(waiter)
      this.queues.set(providerId, queue)
    })
  }

  private track(providerId: string, limit: number): () => void {
    this.active.set(providerId, this.activeCount(providerId) + 1)
    this.notify(providerId)
    return this.releaser(providerId, limit)
  }

  private releaser(providerId: string, limit: number): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(providerId, limit)
    }
  }

  private release(providerId: string, limit: number): void {
    this.active.set(providerId, Math.max(0, this.activeCount(providerId) - 1))
    this.notify(providerId)
    const queue = this.queues.get(providerId)
    if (!queue || !Number.isFinite(limit) || limit <= 0) return
    while (this.activeCount(providerId) < limit && queue.length > 0) {
      const waiter = queue.shift()!
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.resolve(null)
        continue
      }
      this.active.set(providerId, this.activeCount(providerId) + 1)
      this.notify(providerId)
      waiter.resolve(this.releaser(providerId, limit))
    }
    if (queue.length === 0) this.queues.delete(providerId)
  }

  private notify(providerId: string): void {
    const active = this.activeCount(providerId)
    for (const listener of this.listeners) {
      try {
        listener(providerId, active)
      } catch {
        // 订阅方异常不能中断请求路径。
      }
    }
  }
}
