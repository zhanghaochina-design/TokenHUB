import { useEffect, useState } from 'react'
import type { LocalSnapshot } from '../../core/local/types'

// 本地状态由主进程节流推送；首帧用 getState 补齐，若推送先到则以推送为准，避免旧快照覆盖新快照。
export function useLocalState(): LocalSnapshot | null {
  const [snapshot, setSnapshot] = useState<LocalSnapshot | null>(null)

  useEffect(() => {
    let active = true
    let receivedPush = false
    const unsubscribe = window.tokenhub.local.onState((next) => {
      receivedPush = true
      setSnapshot(next)
    })
    void window.tokenhub.local
      .getState()
      .then((next) => {
        if (active && !receivedPush) setSnapshot(next)
      })
      .catch((error: unknown) => console.error('TokenHUB local state failed:', error))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return snapshot
}