import { app, dialog, ipcMain, shell } from 'electron'
import type { Hub } from '../core/hub'
import type { LocalService } from '../core/local/service'
import type { LocalBackend, LocalSettings } from '../core/local/types'
import type { ProviderInput, ProviderPatch, TokenHubApi, UpdateState } from '../core/ipc-types'
import type { AppState, ModelAlias, ModelMeta, Settings } from '../core/types'
import type { UpdateController } from './updateController'

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

export function registerIpc(
  hub: Hub,
  local: LocalService,
  broadcast: (state: AppState) => void,
  updateController: UpdateController,
  broadcastUpdate: (state: UpdateState) => void
): void {
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
  ipcMain.handle('tokenhub:saveModelMeta', (_e, providerId: string, upstreamModel: string, meta: ModelMeta | null) =>
    hub.saveModelMeta(providerId, upstreamModel, meta)
  )
  ipcMain.handle('tokenhub:setModelHidden', (_e, providerId: string, upstreamModel: string, hidden: boolean) =>
    hub.setModelHidden(providerId, upstreamModel, hidden)
  )
  ipcMain.handle('tokenhub:setLocalKey', (_e, key: string | null) => hub.setLocalKey(key))
  ipcMain.handle('tokenhub:setPaused', (_e, paused: boolean) => hub.setPaused(paused))
  ipcMain.handle('tokenhub:getHistory', (_e, day: string, limit?: number) => hub.getHistory(day, limit))
  ipcMain.handle('tokenhub:getSpeedStats', (_e, day: string) => hub.getSpeedStats(day))
  ipcMain.handle('tokenhub:getUsageStats', () => hub.getUsageStats())
  ipcMain.handle('tokenhub:getUpdateState', () => updateController.getState())
  ipcMain.handle('tokenhub:checkForUpdates', () => updateController.check())
  ipcMain.handle('tokenhub:downloadUpdate', () => updateController.download())
  ipcMain.handle('tokenhub:installUpdate', () => updateController.install())
  updateController.subscribe(broadcastUpdate)
  ipcMain.handle('tokenhub:updateSettings', async (_e, patch: Partial<Settings>) => {
    await hub.updateSettings(patch)
    if (patch.autoStart !== undefined) syncAutoStart(patch.autoStart)
  })

  // 本地模型：模型目录/运行时都在主进程侧，渲染进程只拿快照。
  ipcMain.handle('tokenhub:local:getState', () => local.getSnapshot())
  ipcMain.handle('tokenhub:local:detectHardware', () => local.detectHardware())
  ipcMain.handle('tokenhub:local:installRuntime', (_e, backend?: LocalBackend) => local.installRuntime(backend))
  ipcMain.handle('tokenhub:local:removeRuntime', (_e, backend: LocalBackend) => local.removeRuntime(backend))
  // 选文件必须走主进程对话框：sandbox 渲染进程拿不到路径，也没有 fs 权限。
  ipcMain.handle('tokenhub:local:importRuntimeZip', async () => {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return await local.importRuntimeZip(picked.filePaths[0])
  })
  ipcMain.handle('tokenhub:local:loadModel', (_e, id: string, contextSize?: number) => local.loadModel(id, contextSize))
  ipcMain.handle('tokenhub:local:stopModel', () => local.stopModel())
  ipcMain.handle('tokenhub:local:deleteModel', (_e, id: string) => local.deleteModel(id))
  ipcMain.handle('tokenhub:local:refreshModels', () => local.refreshModels())
  ipcMain.handle('tokenhub:local:updateSettings', (_e, patch: Partial<LocalSettings>) => local.updateSettings(patch))
  ipcMain.handle('tokenhub:local:setHfToken', (_e, token: string | null) => local.setHfToken(token))
  ipcMain.handle('tokenhub:local:revealModelsDir', async () => {
    await shell.openPath(local.getModelsDir())
  })
}

export type { TokenHubApi }
