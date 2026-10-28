import { useEffect, useState } from 'react'
import type { AppState } from '../../core/types'

// 唯一的状态来源：首屏快照 + 主进程推送；组件不直接接触 ipcRenderer。
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let active = true
    let receivedPush = false
    const unsubscribe = window.tokenhub.onState((next) => {
      receivedPush = true
      setState(next)
    })
    // 首屏快照可能晚于一次推送返回，此时不能用旧快照覆盖新状态。
    void window.tokenhub
      .getState()
      .then((next) => {
        if (active && !receivedPush) setState(next)
      })
      .catch((error: unknown) => {
        console.error('TokenHUB getState failed:', error)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
