import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { ProtocolScanResult } from '../../core/types'
import { formatDateTime } from '../lib/format'

interface ProtocolScanDialogProps {
  result: ProtocolScanResult
  onClose: () => void
}

const STATUS_TONE = {
  true: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  false: 'border-red-200 bg-red-50 text-red-700',
  null: 'border-line bg-neutral-50 text-neutral-600'
} as const

function statusTone(value: boolean | null): string {
  return value === true ? STATUS_TONE.true : value === false ? STATUS_TONE.false : STATUS_TONE.null
}

function statusLabel(value: boolean | null): string {
  return value === true ? '可用' : value === false ? '不支持' : '未知'
}

function StatusPill({ value }: { value: boolean | null }) {
  return (
    <span className={`inline-flex rounded border px-1.5 py-0.5 text-xs ${statusTone(value)}`}>
      {statusLabel(value)}
    </span>
  )
}

export function ProtocolScanDialog({ result, onClose }: ProtocolScanDialogProps) {
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const messagesOk = result.rows.filter((row) => row.anthropic === true).length
  const chatOk = result.rows.filter((row) => row.openai === true).length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`调用方式兼容性结果：${result.providerName}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">调用方式兼容性 · {result.providerName}</h2>
            <p className="mt-1 text-xs text-muted">
              共 {result.rows.length} 个模型 · Messages 可用 {messagesOk} · Chat 可用 {chatOk}
              {result.error ? ` · ${result.error}` : ''}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭兼容性结果"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors hover:bg-neutral-50 hover:text-ink"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-neutral-50 text-xs text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">模型</th>
                <th scope="col" className="px-4 py-2 font-medium">Anthropic /messages</th>
                <th scope="col" className="px-4 py-2 font-medium">OpenAI /chat/completions</th>
                <th scope="col" className="px-4 py-2 font-medium">备注</th>
                <th scope="col" className="px-4 py-2 font-medium">扫描时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {result.rows.map((row) => (
                <tr key={row.model} className="align-top">
                  <td className="break-all px-4 py-2 font-mono text-[13px] text-ink">{row.model}</td>
                  <td className="px-4 py-2"><StatusPill value={row.anthropic} /></td>
                  <td className="px-4 py-2"><StatusPill value={row.openai} /></td>
                  <td className="max-w-64 break-words px-4 py-2 text-xs text-muted">{row.note ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-xs tabular-nums text-muted">{formatDateTime(row.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
