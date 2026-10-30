import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const assets = join(here, 'assets')
const mapping = {
  IMG_OVERVIEW: 'overview.png',
  IMG_OVERVIEW_QUOTA: 'overview-quota.png',
  IMG_HISTORY: 'history.png',
  IMG_PROVIDERS: 'providers.png',
  IMG_PROVIDER_DIALOG: 'provider-dialog.png',
  IMG_MODELS_COMPAT: 'models-compat.png',
  IMG_MODELS_ALIASES: 'models-aliases.png',
  IMG_MODELS_CATALOG: 'models-catalog.png',
  IMG_SCAN: 'scan-dialog.png',
  IMG_SETTINGS: 'settings.png',
  IMG_CONNECTION: 'settings-connection.png'
}

let html = readFileSync(join(here, 'template.html'), 'utf8')
for (const [token, file] of Object.entries(mapping)) {
  const base64 = readFileSync(join(assets, file)).toString('base64')
  html = html.replaceAll(`{{${token}}}`, `data:image/png;base64,${base64}`)
}

const leftover = html.match(/\{\{IMG_[A-Z_]+\}\}/g)
if (leftover) throw new Error(`unreplaced placeholders: ${leftover.join(', ')}`)

const target = join(root, 'README.html')
writeFileSync(target, html, 'utf8')
console.log(`README.html written: ${Math.round(Buffer.byteLength(html) / 1024)} KB`)
