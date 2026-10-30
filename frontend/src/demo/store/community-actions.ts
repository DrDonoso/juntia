/**
 * Community actions (src/juntia/community_actions.py): the operations that change them and leave
 * their history, the API views and the list and board queries. The handlers check a request
 * before calling an operation; the scenario replays the same operations, so the history of the
 * initial data matches the data.
 */
import type {
  ActionAttachmentOut, ActionChange, ActionCommentOut, ActionEventOut, ActionLabelOut, ActionOut, ActionSummaryOut, ActorOut,
} from '../../api/schema.gen'
import {
  actorOut, compareText, type ActionEventKind, type ActionStatus, type CommunityState, type DemoAction, type DemoActionAttachment,
  type DemoActionComment, type DemoActionEvent, type DemoActionLabel,
} from './community-model'
import { casefold, labelKey } from './community-text'

/** The backend's `ACTION_STATUSES`, in board order. */
export const ACTION_STATUSES = [
  'detected', 'quoting', 'voting', 'approved', 'ordered', 'in_progress', 'done', 'discarded',
] as const satisfies readonly ActionStatus[]

/** Page size of actions, labels, comments, attachments and history. */
export const ACTION_PAGE_SIZE = 20

/** Active PDFs an action may have (`MAX_ACTIVE_PDFS`). */
export const MAX_ACTIVE_PDFS = 20

/** Largest PDF accepted (`MAX_BYTES`, 20 MiB). */
export const MAX_PDF_BYTES = 20 * 1024 * 1024

export const CLOSED_STATUSES: readonly ActionStatus[] = ['done', 'discarded']

export function findAction(state: CommunityState, id: number): DemoAction | undefined {
  return state.actions.find(action => action.id === id)
}

export function findLabel(state: CommunityState, id: number): DemoActionLabel | undefined {
  return state.labels.find(label => label.id === id)
}

export function findLabelByName(state: CommunityState, name: string): DemoActionLabel | undefined {
  const key = labelKey(name)
  return state.labels.find(label => labelKey(label.name) === key)
}

/** Labels in the backend's order (by normalized name, which is unique). */
export function sortLabels(labels: readonly DemoActionLabel[]): DemoActionLabel[] {
  return [...labels].sort((a, b) => compareText(labelKey(a.name), labelKey(b.name)) || a.id - b.id)
}

export function actionLabels(state: CommunityState, action: DemoAction): DemoActionLabel[] {
  return sortLabels(action.labelIds.flatMap(id => findLabel(state, id) ?? []))
}

/** The labels named `names` (already normalized and distinct), creating the missing ones (`resolve_labels`). */
export function resolveLabels(state: CommunityState, names: readonly string[]): DemoActionLabel[] {
  return sortLabels(names.map(name => {
    const existing = findLabelByName(state, name)
    if (existing) return existing
    const label: DemoActionLabel = { id: state.sequences.label.next(), name, color: null, version: 1 }
    state.labels.push(label)
    return label
  }))
}

function addEvent(
  state: CommunityState, action: DemoAction, actor: ActorOut, kind: ActionEventKind, changes: ActionChange[], at: string,
  references: { commentId?: number; attachmentId?: string } = {},
): void {
  action.updatedAt = at
  state.actionHistory.push({
    id: state.sequences.actionHistory.next(), actionId: action.id, kind, author: { ...actor }, createdAt: at, changes,
    commentId: references.commentId ?? null, attachmentId: references.attachmentId ?? null,
  })
}

export interface ActionInput {
  title: string
  description: string
  status: ActionStatus
  /** Normalized, distinct label names (`action_labels`). */
  labels: readonly string[]
}

export function createAction(state: CommunityState, actor: ActorOut, input: ActionInput, at: string): DemoAction {
  const action: DemoAction = {
    id: state.sequences.action.next(), title: input.title, description: input.description, status: input.status,
    labelIds: [], author: { ...actor }, version: 1, createdAt: at, updatedAt: at,
  }
  state.actions.push(action)
  const labels = resolveLabels(state, input.labels)
  action.labelIds = labels.map(label => label.id)
  addEvent(state, action, actor, 'created', [
    { field: 'title', before: null, after: action.title },
    { field: 'description', before: null, after: action.description },
    { field: 'status', before: null, after: action.status },
    { field: 'labels', before: null, after: labels.map(label => label.name) },
  ], at)
  return action
}

export type ActionEdit = Partial<ActionInput>

/** `edit_item`: records the fields that change, in the backend's order; nothing when none does. */
export function editAction(state: CommunityState, actor: ActorOut, action: DemoAction, edit: ActionEdit, at: string): void {
  const changes: ActionChange[] = []
  if (edit.title !== undefined && edit.title !== action.title) {
    changes.push({ field: 'title', before: action.title, after: edit.title })
    action.title = edit.title
  }
  if (edit.description !== undefined && edit.description !== action.description) {
    changes.push({ field: 'description', before: action.description, after: edit.description })
    action.description = edit.description
  }
  if (edit.status !== undefined && edit.status !== action.status) {
    changes.push({ field: 'status', before: action.status, after: edit.status })
    action.status = edit.status
  }
  if (edit.labels !== undefined) {
    const before = actionLabels(state, action)
    const after = resolveLabels(state, edit.labels)
    if (before.map(label => label.id).join() !== after.map(label => label.id).join()) {
      action.labelIds = after.map(label => label.id)
      changes.push({ field: 'labels', before: before.map(label => label.name), after: after.map(label => label.name) })
    }
  }
  if (changes.length === 0) return
  action.version += 1
  addEvent(state, action, actor, 'updated', changes, at)
}

/**
 * `edit_label`: a new name or colour is recorded on every action that has the label, and each of
 * them gets a new version (drafts made before must be reconciled).
 */
export function editLabel(state: CommunityState, actor: ActorOut, label: DemoActionLabel, name: string, color: string, at: string): void {
  if (label.name === name && label.color === color) return
  const before = { name: label.name, color: label.color }
  const actions = state.actions.filter(action => action.labelIds.includes(label.id)).sort((a, b) => a.id - b.id)
  const previous = new Map(actions.map(action => [action.id, actionLabels(state, action).map(item => item.name)]))
  label.name = name
  label.color = color
  label.version += 1
  for (const action of actions) {
    const changes: ActionChange[] = []
    if (before.name !== name) {
      changes.push({ field: 'labels', before: previous.get(action.id) ?? [], after: actionLabels(state, action).map(item => item.name) })
    }
    if (before.color !== color) {
      changes.push({ field: 'label_color', before: before.color ? `${before.name}: ${before.color}` : null, after: `${name}: ${color}` })
    }
    action.version += 1
    addEvent(state, action, actor, 'updated', changes, at)
  }
}

export function addComment(state: CommunityState, actor: ActorOut, action: DemoAction, body: string, at: string): DemoActionComment {
  const comment: DemoActionComment = {
    id: state.sequences.comment.next(), actionId: action.id, body, author: { ...actor }, version: 1,
    createdAt: at, updatedAt: at, withdrawnAt: null,
  }
  state.comments.push(comment)
  addEvent(state, action, actor, 'comment_added', [{ field: 'comment', before: null, after: body }], at, { commentId: comment.id })
  return comment
}

export function editComment(state: CommunityState, actor: ActorOut, action: DemoAction, comment: DemoActionComment, body: string, at: string): void {
  if (comment.body === body) return
  addEvent(state, action, actor, 'comment_edited', [{ field: 'comment', before: comment.body, after: body }], at, { commentId: comment.id })
  comment.body = body
  comment.version += 1
  comment.updatedAt = at
}

/** The text stays in the history; readers of the thread only see that it was withdrawn. */
export function withdrawComment(state: CommunityState, actor: ActorOut, action: DemoAction, comment: DemoActionComment, at: string): void {
  addEvent(state, action, actor, 'comment_withdrawn', [{ field: 'comment', before: comment.body, after: null }], at, { commentId: comment.id })
  comment.withdrawnAt = at
  comment.updatedAt = at
  comment.version += 1
}

export function attachmentName(attachment: DemoActionAttachment): string {
  return attachment.displayFilename ?? attachment.filename
}

export interface UploadedPdf {
  id: string
  filename: string
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
}

export function addAttachment(state: CommunityState, actor: ActorOut, action: DemoAction, file: UploadedPdf, at: string): DemoActionAttachment {
  const attachment: DemoActionAttachment = {
    id: file.id, actionId: action.id, filename: file.filename, displayFilename: null, size: file.bytes.length, sha256: file.sha256,
    bytes: file.bytes, author: { ...actor }, version: 1, createdAt: at, withdrawnAt: null, purgedAt: null,
  }
  state.attachments.push(attachment)
  addEvent(state, action, actor, 'attachment_added', [
    { field: 'filename', before: null, after: attachment.filename },
    { field: 'size', before: null, after: String(attachment.size) },
  ], at, { attachmentId: attachment.id })
  return attachment
}

/** A rename keeps the uploaded name: going back to it clears the display name. */
export function renameAttachment(
  state: CommunityState, actor: ActorOut, action: DemoAction, attachment: DemoActionAttachment, filename: string, at: string,
): void {
  const previous = attachmentName(attachment)
  if (previous === filename) return
  addEvent(state, action, actor, 'attachment_renamed', [{ field: 'filename', before: previous, after: filename }], at, { attachmentId: attachment.id })
  attachment.displayFilename = filename === attachment.filename ? null : filename
  attachment.version += 1
}

/** A withdrawn PDF leaves the list but stays downloadable from the history. */
export function withdrawAttachment(state: CommunityState, actor: ActorOut, action: DemoAction, attachment: DemoActionAttachment, at: string): void {
  attachment.withdrawnAt = at
  attachment.version += 1
  addEvent(state, action, actor, 'attachment_withdrawn', [
    { field: 'filename', before: attachmentName(attachment), after: null },
  ], at, { attachmentId: attachment.id })
}

/**
 * `purge_attachment` (storage_admin.py): the administrator deletes the file of a withdrawn PDF to
 * free its storage. The record and the history stay, with an `attachment_purged` entry; the
 * action's activity date moves but not its version, and downloads then answer 410.
 */
export function purgeAttachment(state: CommunityState, actor: ActorOut, action: DemoAction, attachment: DemoActionAttachment, at: string): void {
  addEvent(state, action, actor, 'attachment_purged', [
    { field: 'filename', before: attachmentName(attachment), after: null },
    { field: 'size', before: String(attachment.size), after: null },
    { field: 'sha256', before: attachment.sha256, after: null },
  ], at, { attachmentId: attachment.id })
  attachment.purgedAt = at
  attachment.version += 1
  attachment.bytes = new Uint8Array(0)
}

export function labelOut(label: DemoActionLabel): ActionLabelOut {
  return { id: label.id, name: label.name, color: label.color, version: label.version }
}

export function actionSummary(state: CommunityState, action: DemoAction): ActionSummaryOut {
  return {
    id: action.id, title: action.title, status: action.status, labels: actionLabels(state, action).map(labelOut),
    author: actorOut(action.author), version: action.version, created_at: action.createdAt, updated_at: action.updatedAt,
    comment_count: state.comments.filter(comment => comment.actionId === action.id && comment.withdrawnAt === null).length,
    attachment_count: state.attachments.filter(attachment => attachment.actionId === action.id && attachment.withdrawnAt === null).length,
  }
}

export function actionOut(state: CommunityState, action: DemoAction): ActionOut {
  return { ...actionSummary(state, action), description: action.description }
}

export function commentOut(comment: DemoActionComment): ActionCommentOut {
  return {
    id: comment.id, body: comment.withdrawnAt === null ? comment.body : null, author: actorOut(comment.author),
    version: comment.version, created_at: comment.createdAt, updated_at: comment.updatedAt, withdrawn_at: comment.withdrawnAt,
  }
}

export function attachmentOut(attachment: DemoActionAttachment): ActionAttachmentOut {
  return {
    id: attachment.id, filename: attachmentName(attachment), size: attachment.size, sha256: attachment.sha256,
    author: actorOut(attachment.author), version: attachment.version, created_at: attachment.createdAt,
    withdrawn_at: attachment.withdrawnAt, purged_at: attachment.purgedAt,
  }
}

export function actionEventOut(event: DemoActionEvent): ActionEventOut {
  return {
    id: event.id, kind: event.kind, author: actorOut(event.author), created_at: event.createdAt,
    changes: event.changes.map(change => ({ ...change })), comment_id: event.commentId, attachment_id: event.attachmentId,
  }
}

export interface ActionFilters {
  /** Trimmed search text (title or description, case-insensitive). */
  q: string
  status: ActionStatus | null
  /** Every one of these labels (AND). */
  labels: readonly number[]
  scope: 'open' | 'closed' | 'all'
}

/** Actions matching the list and board filters (`conditions`). */
export function filterActions(state: CommunityState, filters: ActionFilters): DemoAction[] {
  const needle = casefold(filters.q)
  return state.actions.filter(action => {
    if (needle && !casefold(action.title).includes(needle) && !casefold(action.description).includes(needle)) return false
    if (filters.status !== null && action.status !== filters.status) return false
    const closed = CLOSED_STATUSES.includes(action.status)
    if ((filters.scope === 'open' && closed) || (filters.scope === 'closed' && !closed)) return false
    return filters.labels.every(id => action.labelIds.includes(id))
  })
}

export type ActionSort = 'title' | 'status' | 'activity'

/** The list's order: the sort column, then the id, both in `direction`. */
export function sortActions(actions: readonly DemoAction[], sort: ActionSort, direction: 'asc' | 'desc'): DemoAction[] {
  const sign = direction === 'asc' ? 1 : -1
  const compare = (a: DemoAction, b: DemoAction) => sort === 'title'
    ? compareText(a.title.toLowerCase(), b.title.toLowerCase())
    : sort === 'status' ? ACTION_STATUSES.indexOf(a.status) - ACTION_STATUSES.indexOf(b.status) : compareText(a.updatedAt, b.updatedAt)
  return [...actions].sort((a, b) => sign * (compare(a, b) || a.id - b.id))
}
