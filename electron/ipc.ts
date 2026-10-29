import { app, ipcMain } from 'electron'
import type { Hub } from '../core/hub'
import type { ProviderInput, ProviderPatch, TokenHubApi } from '../core/ipc-types'
import type { AppState, ModelAlias, Settings } from '../core/types'

// 自启注册表写入可能因权限/平台差异失败；失败只降级为本次不生效，不能连带阻断设置保存。
// 开发/E2E 的 Electron 可执行文件不是产品入口，写入系统启动项只会污染本机；仅安装版同步。
// 安装版必须显式传 path，否则注册的是 electron.exe 而非 TokenHUB.exe。
export function syncAutoStart(enabled: boolean): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  } catch (error) {
    console.error('TokenHUB auto-start sync failed:', error)
  }
}

export function registerIpc(hub: Hub, broadcast: (state: AppState) => void): void {
  hub.onStateChange(broadcast)
  ipcMain.handle('tokenhub:getState', () => hub.getState())
  ipcMain.handle('tokenhub:addProvider', (_e, input: ProviderInput) => hub.addProvider(input))
  ipcMain.handle('tokenhub:updateProvider', (_e, id: string, patch: ProviderPatch) => hub.updateProvider(id, patch))
  ipcMain.handle('tokenhub:deleteProvider', (_e, id: string) => hub.deleteProvider(id))
  ipcMain.handle('tokenhub:reorderProviders', (_e, ids: string[]) => hub.reorderProviders(ids))
  ipcMain.handle('tokenhub:setProviderEnabled', (_e, id: string, enabled: boolean) => hub.setProviderEnabled(id, enabled))
  ipcMain.handle('tokenhub:testProvider', (_e, input: ProviderInput, id?: string) => hub.testProvider(input, id))
  ipcMain.handle('tokenhub:refreshModels', (_e, id?: string) => hub.refreshModels(id))
  ipcMain.handle('tokenhub:scanProviderProtocols', (_e, id: string) => hub.scanProviderProtocols(id))
  ipcMain.handle('tokenhub:resetProvider', (_e, id: string) => hub.resetProvider(id))
  ipcMain.handle('tokenhub:saveModelAlias', (_e, alias: ModelAlias, previousId?: string) => hub.saveModelAlias(alias, previousId))
  ipcMain.handle('tokenhub:deleteModelAlias', (_e, id: string) => hub.deleteModelAlias(id))
  ipcMain.handle('tokenhub:setLocalKey', (_e, key: string | null) => hub.setLocalKey(key))
  ipcMain.handle('tokenhub:setPaused', (_e, paused: boolean) => hub.setPaused(paused))
  ipcMain.handle('tokenhub:getHistory', (_e, day: string, limit?: number) => hub.getHistory(day, limit))
  ipcMain.handle('tokenhub:updateSettings', async (_e, patch: Partial<Settings>) => {
    await hub.updateSettings(patch)
    if (patch.autoStart !== undefined) syncAutoStart(patch.autoStart)
  })
}

export type { TokenHubApi }
