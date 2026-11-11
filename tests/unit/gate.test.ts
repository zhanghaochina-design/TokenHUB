import { describe, expect, it } from 'vitest'
import { ProviderGate } from '../../core/server/gate'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('ProviderGate', () => {
  it('caps concurrency and hands the slot to the queued request', async () => {
    const gate = new ProviderGate()
    const first = await gate.acquire('p1', 1)
    expect(first).toBeTypeOf('function')

    let second: (() => void) | null = null
    const pending = gate.acquire('p1', 1).then((release) => { second = release })
    await tick()
    expect(second).toBeNull()

    first!()
    await pending
    expect(second).toBeTypeOf('function')
    second!()

    const third = await gate.acquire('p1', 1)
    expect(third).toBeTypeOf('function')
    third!()
  })

  it('removes a queued request when the client aborts', async () => {
    const gate = new ProviderGate()
    const first = await gate.acquire('p1', 1)
    const controller = new AbortController()
    let outcome = 'pending'
    const pending = gate.acquire('p1', 1, controller.signal).then((release) => {
      outcome = release === null ? 'aborted' : 'acquired'
    })
    await tick()
    controller.abort()
    await pending
    expect(outcome).toBe('aborted')

    first!()
    const next = await gate.acquire('p1', 1)
    expect(next).toBeTypeOf('function')
    next!()
  })

  it('treats zero or invalid limits as unlimited', async () => {
    const gate = new ProviderGate()
    const first = await gate.acquire('p1', 0)
    const second = await gate.acquire('p1', Number.NaN)
    expect(first).toBeTypeOf('function')
    expect(second).toBeTypeOf('function')
    first!()
    second!()
  })

  it('skips non-blocking acquisitions at capacity and reports active counts', async () => {
    const gate = new ProviderGate()
    const changes: number[] = []
    gate.onChange((id, active) => {
      if (id === 'p1') changes.push(active)
    })

    const first = gate.tryAcquire('p1', 1)
    expect(first).toBeTypeOf('function')
    expect(gate.activeCount('p1')).toBe(1)
    expect(gate.tryAcquire('p1', 1)).toBeNull()
    expect(gate.activeCount('p1')).toBe(1)

    first!()
    expect(gate.activeCount('p1')).toBe(0)
    expect(gate.tryAcquire('p1', 1)).toBeTypeOf('function')
    expect(changes).toEqual([1, 0, 1])
  })

  it('does not acquire for an already-aborted client', async () => {
    const gate = new ProviderGate()
    const controller = new AbortController()
    controller.abort()
    expect(gate.tryAcquire('p1', 1, controller.signal)).toBeNull()
    expect(gate.activeCount('p1')).toBe(0)
    const queued = await gate.acquire('p1', 1, controller.signal)
    expect(queued).toBeNull()
  })
})
