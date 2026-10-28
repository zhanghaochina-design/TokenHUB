/// <reference types="vite/client" />

import type { TokenHubApi } from '../core/ipc-types'

declare global {
  interface Window {
    tokenhub: TokenHubApi
  }
}

export {}
