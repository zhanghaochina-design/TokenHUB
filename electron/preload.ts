import { contextBridge, ipcRenderer } from 'electron'
import type { LocalApi, TokenHubApi } from '../core/ipc-types'
import type { LocalSnapshot } from '../core/local/types'

// 只暴露具名方法与通道，不把 ipcRenderer 交给渲染进程。
const local: LocalApi = {
  getState: () => ipcRenderer.invoke('tokenhub:local:getState'),
  detectHardware: () => ipcRenderer.invoke('tokenhub:local:detectHardware'),
  installRuntime: (backend) => ipcRenderer.invoke('tokenhub:local:installRuntime', backend),
  removeRuntime: (backend) => ipcRenderer.invoke('tokenhub:local:removeRuntime', backend),
  importRuntimeZip: () => ipcRenderer.invoke('tokenhub:local:importRuntimeZip'),
  loadModel: (id, contextSize) => ipcRenderer.invoke('tokenhub:local:loadModel', id, contextSize),
  stopModel: () => ipcRenderer.invoke('tokenhub:local:stopModel'),
  deleteModel: (id) => ipcRenderer.invoke('tokenhub:local:deleteModel', id),
  refreshModels: () => ipcRenderer.invoke('tokenhub:local:refreshModels'),
  updateSettings: (patch) => ipcRenderer.invoke('tokenhub:local:updateSettings', patch),
  // P2：处理器由 Task 12 注册，这里的签名先保留，提前调用只会 reject。
  searchHf: (query) => ipcRenderer.invoke('tokenhub:local:searchHf', query),
  getHfModel: (repo) => ipcRenderer.invoke('tokenhub:local:getHfModel', repo),
  download: (repo, files) => ipcRenderer.invoke('tokenhub:local:download', repo, files),
  pauseDownload: (id) => ipcRenderer.invoke('tokenhub:local:pauseDownload', id),
  resumeDownload: (id) => ipcRenderer.invoke('tokenhub:local:resumeDownload', id),
  cancelDownload: (id) => ipcRenderer.invoke('tokenhub:local:cancelDownload', id),
  setHfToken: (token) => ipcRenderer.invoke('tokenhub:local:setHfToken', token),
  chooseModelsDir: () => ipcRenderer.invoke('tokenhub:local:chooseModelsDir'),
  revealModelsDir: () => ipcRenderer.invoke('tokenhub:local:revealModelsDir'),
  onState: (cb: (snapshot: LocalSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: LocalSnapshot) => cb(snapshot)
    ipcRenderer.on('tokenhub:localState', handler)
    return () => ipcRenderer.removeListener('tokenhub:localState', handler)
  }
}

const api: TokenHubApi = {
  getState: () => ipcRenderer.invoke('tokenhub:getState'),
  addProvider: (input) => ipcRenderer.invoke('tokenhub:addProvider', input),
  updateProvider: (id, patch) => ipcRenderer.invoke('tokenhub:updateProvider', id, patch),
  deleteProvider: (id) => ipcRenderer.invoke('tokenhub:deleteProvider', id),
  reorderProviders: (ids) => ipcRenderer.invoke('tokenhub:reorderProviders', ids),
  setProviderEnabled: (id, enabled) => ipcRenderer.invoke('tokenhub:setProviderEnabled', id, enabled),
  testProvider: (input, id) => ipcRenderer.invoke('tokenhub:testProvider', input, id),
  refreshModels: (id) => ipcRenderer.invoke('tokenhub:refreshModels', id),
  scanProviderProtocols: (id) => ipcRenderer.invoke('tokenhub:scanProviderProtocols', id),
  resetProvider: (id) => ipcRenderer.invoke('tokenhub:resetProvider', id),
  saveModelAlias: (alias, previousId) => ipcRenderer.invoke('tokenhub:saveModelAlias', alias, previousId),
  deleteModelAlias: (id) => ipcRenderer.invoke('tokenhub:deleteModelAlias', id),
  saveModelMeta: (providerId, upstreamModel, meta) => ipcRenderer.invoke('tokenhub:saveModelMeta', providerId, upstreamModel, meta),
  setModelHidden: (providerId, upstreamModel, hidden) => ipcRenderer.invoke('tokenhub:setModelHidden', providerId, upstreamModel, hidden),
  updateSettings: (patch) => ipcRenderer.invoke('tokenhub:updateSettings', patch),
  setLocalKey: (key) => ipcRenderer.invoke('tokenhub:setLocalKey', key),
  setPaused: (paused) => ipcRenderer.invoke('tokenhub:setPaused', paused),
  getHistory: (day, limit) => ipcRenderer.invoke('tokenhub:getHistory', day, limit),
  getSpeedStats: (day) => ipcRenderer.invoke('tokenhub:getSpeedStats', day),
  getUsageStats: () => ipcRenderer.invoke('tokenhub:getUsageStats'),
  getUpdateState: () => ipcRenderer.invoke('tokenhub:getUpdateState'),
  checkForUpdates: () => ipcRenderer.invoke('tokenhub:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('tokenhub:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('tokenhub:installUpdate'),
  onUpdate: (cb) => {
    const handler = (_event: unknown, state: Parameters<typeof cb>[0]) => cb(state)
    ipcRenderer.on('tokenhub:updateState', handler)
    return () => ipcRenderer.removeListener('tokenhub:updateState', handler)
  },
  onState: (cb) => {
    const handler = (_event: unknown, state: Parameters<typeof cb>[0]) => cb(state)
    ipcRenderer.on('tokenhub:state', handler)
    return () => ipcRenderer.removeListener('tokenhub:state', handler)
  },
  local
}

contextBridge.exposeInMainWorld('tokenhub', api)
