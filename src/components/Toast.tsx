import { AlertCircle, X } from 'lucide-react'

interface ToastProps {
  message: string
  onDismiss: () => void
}

// 错误提示固定右下角，role=alert 让辅助技术立即播报。
export function Toast({ message, onDismiss }: ToastProps) {
  return (
    <div
      role="alert"
      className="fixed bottom-6 right-6 z-50 flex w-full max-w-sm items-start gap-3 rounded-lg border border-red-200 bg-surface p-4 shadow-lg"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words text-sm text-ink">{message}</p>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="-m-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}
