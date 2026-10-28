import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, KeyRound, Pencil, Trash2 } from 'lucide-react'
import type { ProviderConfig, ProviderRuntime } from '../../core/types'
import { errorMessage, providerModelCount, providerStatus, type StatusTone } from '../lib/format'

type ProviderWithKey = ProviderConfig & { hasKey: boolean }

interface ProviderListProps {
  providers: ProviderWithKey[]
  runtimeById: Map<string, ProviderRuntime>
  now: number
  onReorder: (ids: string[]) => Promise<void>
  onEdit: (provider: ProviderWithKey) => void
  onDelete: (provider: ProviderWithKey) => void
  onToggle: (provider: ProviderWithKey, enabled: boolean) => void
  onError: (message: string) => void
}

const GRID_COLUMNS = '32px 40px minmax(128px, 1.1fr) minmax(150px, 1.3fr) 48px 96px 48px 64px'

const TONE_BADGE: Record<StatusTone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
  muted: 'bg-neutral-100 text-neutral-600 ring-neutral-500/20'
}

const TONE_DOT: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  muted: 'bg-neutral-400'
}

interface ProviderRowProps {
  provider: ProviderWithKey
  runtime: ProviderRuntime | undefined
  now: number
  index: number
  onEdit: (provider: ProviderWithKey) => void
  onDelete: (provider: ProviderWithKey) => void
  onToggle: (provider: ProviderWithKey, enabled: boolean) => void
}

function ProviderRow({ provider, runtime, now, index, onEdit, onDelete, onToggle }: ProviderRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: provider.id
  })
  const status = providerStatus(provider, runtime, now)
  const modelCount = providerModelCount(provider)

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridTemplateColumns: GRID_COLUMNS
      }}
      className={`grid items-center gap-2 px-4 py-3 ${
        isDragging
          ? 'relative z-10 rounded-lg border border-accent/40 bg-surface shadow-lg'
          : 'border-t border-line bg-surface first:border-t-0 hover:bg-neutral-50/80'
      }`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={`拖拽排序 ${provider.name}`}
        title="拖拽调整优先级"
        style={{ touchAction: 'none' }}
        className="flex size-8 cursor-grab items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-ink active:cursor-grabbing"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>

      <span
        aria-label={`优先级 ${index + 1}`}
        className="inline-flex size-8 items-center justify-center rounded-md bg-neutral-100 text-xs font-semibold tabular-nums text-neutral-600"
      >
        {index + 1}
      </span>

      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink" title={provider.name}>
          {provider.name}
        </p>
        <p
          className={`mt-0.5 flex items-center gap-1 text-xs ${provider.hasKey ? 'text-emerald-700' : 'text-red-600'}`}
          title={provider.hasKey ? 'API Key 已加密保存，界面不可查看' : '尚未配置 API Key'}
        >
          <KeyRound className="size-3 shrink-0" aria-hidden="true" />
          {provider.hasKey ? 'Key 已保存' : '未配置 Key'}
        </p>
        {!provider.quota.injectStreamUsage && (
          <p
            className="mt-0.5 text-[11px] font-medium text-amber-700"
            title="上游拒绝流式 usage 后自动关闭；在编辑对话框可重新开启"
          >
            usage 注入已关闭
          </p>
        )}
      </div>

      <span className="truncate font-mono text-xs text-muted" title={provider.baseUrl}>
        {provider.baseUrl || '—'}
      </span>

      <span
        className="text-sm tabular-nums text-ink"
        title={`缓存 ${provider.models.cached.length} 个，手动 ${provider.models.manual.length} 个`}
      >
        {modelCount}
        <span className="ml-1 text-xs text-muted">个</span>
      </span>

      <span
        className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${TONE_BADGE[status.tone]}`}
        title={status.detail ?? `状态：${status.label}`}
      >
        <span className={`size-1.5 rounded-full ${TONE_DOT[status.tone]}`} aria-hidden="true" />
        {status.label}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={provider.enabled}
        aria-label={`启用 ${provider.name}`}
        title={provider.enabled ? '点击禁用' : '点击启用'}
        onClick={() => onToggle(provider, !provider.enabled)}
        className={`relative inline-flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${
          provider.enabled ? 'bg-accent' : 'bg-neutral-400'
        }`}
      >
        <span
          className={`size-5 rounded-full bg-white shadow-sm transition-transform ${
            provider.enabled ? 'translate-x-4' : 'translate-x-0'
          }`}
          aria-hidden="true"
        />
      </button>

      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          aria-label={`编辑 ${provider.name}`}
          title="编辑"
          onClick={() => onEdit(provider)}
          className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-neutral-100 hover:text-ink"
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${provider.name}`}
          title="删除"
          onClick={() => onDelete(provider)}
          className="flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

export function ProviderList({
  providers,
  runtimeById,
  now,
  onReorder,
  onEdit,
  onDelete,
  onToggle,
  onError
}: ProviderListProps) {
  const [items, setItems] = useState<string[]>(() => providers.map((provider) => provider.id))
  const reorderPending = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // 服务端状态是顺序的最终来源；拖动进行中先保留乐观顺序。
  useEffect(() => {
    if (reorderPending.current) return
    const next = providers.map((provider) => provider.id)
    setItems((previous) =>
      previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next
    )
  }, [providers])

  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const ordered = items.flatMap((id) => {
    const provider = byId.get(id)
    return provider ? [provider] : []
  })
  for (const provider of providers) {
    if (!items.includes(provider.id)) ordered.push(provider)
  }
  const orderedIds = ordered.map((provider) => provider.id)

  function nameOf(id: UniqueIdentifier): string {
    return byId.get(String(id))?.name ?? String(id)
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起供应商 ${nameOf(active.id)}，使用方向键移动，按空格放下。`,
    onDragOver: ({ active, over }) =>
      over ? `供应商 ${nameOf(active.id)} 已移动到 ${nameOf(over.id)} 的位置。` : `供应商 ${nameOf(active.id)} 不在可放置区域。`,
    onDragEnd: ({ active, over }) =>
      over ? `供应商 ${nameOf(active.id)} 已放置。` : `供应商 ${nameOf(active.id)} 已取消放置。`,
    onDragCancel: ({ active }) => `已取消移动供应商 ${nameOf(active.id)}。`
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(String(active.id))
    const newIndex = orderedIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(orderedIds, oldIndex, newIndex)
    setItems(next)
    reorderPending.current = true
    void onReorder(next)
      .then(() => {
        reorderPending.current = false
      })
      .catch((error: unknown) => {
        reorderPending.current = false
        setItems(orderedIds)
        onError(`排序保存失败：${errorMessage(error)}`)
      })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: '按空格键拿起供应商，使用方向键移动，按空格键放下，按 Esc 取消。' }
      }}
    >
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
        <div
          className="grid items-center gap-2 border-b border-line bg-neutral-50/70 px-4 py-2 text-xs font-medium text-muted"
          style={{ gridTemplateColumns: GRID_COLUMNS }}
        >
          <span />
          <span>优先级</span>
          <span>供应商</span>
          <span>Base URL</span>
          <span>模型</span>
          <span>状态</span>
          <span>启用</span>
          <span className="text-right">操作</span>
        </div>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          <ul aria-label="供应商列表" className="m-0 list-none p-0">
            {ordered.map((provider, index) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                runtime={runtimeById.get(provider.id)}
                now={now}
                index={index}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </SortableContext>
      </div>
    </DndContext>
  )
}
