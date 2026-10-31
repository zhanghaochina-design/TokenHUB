import { contextBridge, ipcRenderer } from 'electron'
import type { TokenHubApi } from '../core/ipc-types'

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
  updateSettings: (patch) => ipcRenderer.invoke('tokenhub:updateSettings', patch),
  setLocalKey: (key) => ipcRenderer.invoke('tokenhub:setLocalKey', key),
  setPaused: (paused) => ipcRenderer.invoke('tokenhub:setPaused', paused),
  getHistory: (day, limit) => ipcRenderer.invoke('tokenhub:getHistory', day, limit),
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
  }
}

contextBridge.exposeInMainWorld('tokenhub', api)
