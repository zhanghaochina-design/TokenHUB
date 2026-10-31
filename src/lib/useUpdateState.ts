import { useEffect, useState } from 'react'
import type { UpdateState } from '../../core/ipc-types'

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let active = true
    void window.tokenhub
      .getUpdateState()
      .then((next) => {
        if (active) setState(next)
      })
      .catch(() => {
        if (active) setState(null)
      })
    const unsubscribe = window.tokenhub.onUpdate((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
