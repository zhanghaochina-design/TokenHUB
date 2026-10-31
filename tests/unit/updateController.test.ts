import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { UpdateController, type UpdaterLike } from '../../electron/updateController'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => null)
  quitAndInstall = vi.fn()
}

function createController(enabled = true, currentVersion = '0.1.1') {
  const updater = new FakeUpdater()
  const controller = new UpdateController(updater as unknown as UpdaterLike, currentVersion, enabled)
  return { updater, controller }
}

describe('UpdateController', () => {
  it('disables updates outside packaged builds', async () => {
    const controller = new UpdateController(null, '0.1.1', false)
    expect(controller.getState()).toEqual({ phase: 'disabled', currentVersion: '0.1.1' })
    await expect(controller.check()).resolves.toMatchObject({ phase: 'disabled' })
    await expect(controller.download()).resolves.toMatchObject({ phase: 'disabled' })
    expect(() => controller.install()).not.toThrow()
  })

  it('forces manual download and install', () => {
    const { updater } = createController()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
  })

  it('reports an available update after a manual check', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('checking-for-update')
      updater.emit('update-available', { version: '0.1.2' })
      return null
    })
    const state = await controller.check()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('0.1.2')
    expect(state.checkedAt).toBeTruthy()
  })

  it('reports up-to-date when no update exists', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.1' })
      return null
    })
    await expect(controller.check()).resolves.toMatchObject({ phase: 'up-to-date' })
  })

  it('reports check failures without throwing', async () => {
    const { updater, controller } = createController()
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('error', new Error('network down'))
      throw new Error('network down')
    })
    const state = await controller.check()
    expect(state.phase).toBe('error')
    expect(state.message).toContain('network down')
  })

  it('tracks download progress and readiness', async () => {
    const { updater, controller } = createController()
    updater.emit('update-available', { version: '0.1.2' })
    const phases: string[] = []
    controller.subscribe((state) => phases.push(state.phase))
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42.4, transferred: 42, total: 100 })
      updater.emit('update-downloaded', { version: '0.1.2' })
      return null
    })
    const state = await controller.download()
    expect(state.phase).toBe('ready')
    expect(phases).toContain('downloading')
  })

  it('returns to available when a download fails', async () => {
    const { updater, controller } = createController()
    updater.emit('update-available', { version: '0.1.2' })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('error', new Error('disk full'))
      throw new Error('disk full')
    })
    const state = await controller.download()
    expect(state.phase).toBe('available')
    expect(state.availableVersion).toBe('0.1.2')
    expect(state.message).toContain('disk full')
  })

  it('installs only after the update is downloaded', () => {
    const { updater, controller } = createController()
    controller.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    updater.emit('update-downloaded', { version: '0.1.2' })
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
