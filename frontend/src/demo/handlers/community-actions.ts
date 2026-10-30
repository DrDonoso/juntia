/**
 * Community action routes of the demo API (src/juntia/community_actions.py): the board and the
 * list, items, comments, PDF attachments with downloads and previews, history and labels, and the
 * administrator's label catalogue. Every reader may edit any action; only the author (or the
 * administrator) may edit or withdraw a comment or a PDF. All routes but the catalogue answer 404
 * `actions_disabled` while the feature is off.
 */
import type { ActionAttachmentOut, ActionBoardOut, ActionOut, ActorOut } from '../../api/schema.gen'
import {
  DemoApiError, actorOf, displayName, http, idParam, looksLikePdf, nowIso, pageCount, pageParam, paginate, parseBody, pdfResponse,
  queryBool, queryChoice, queryText, readForm, readJson, route, type Body, type HttpHandler, type PathParams, type RouteContext,
} from '../core'
import { communityStore, type CommunityState } from '../store/community'
import {
  ACTION_PAGE_SIZE, ACTION_STATUSES, MAX_ACTIVE_PDFS, MAX_PDF_BYTES, actionEventOut, actionOut, actionSummary, addAttachment,
  addComment, attachmentName, attachmentOut, commentOut, createAction, editAction, editComment, editLabel, filterActions, findAction,
  findLabel, labelOut, renameAttachment, sortActions, sortLabels, withdrawAttachment, withdrawComment, type ActionEdit,
  type ActionFilters, type ActionInput,
} from '../store/community-actions'
import { compareText, type DemoAction, type DemoActionAttachment, type DemoActionComment } from '../store/community-model'
import { sha256Hex } from '../store/community-sha256'
import { actionText, canonicalUuid, casefold, labelKey, labelName, renamedPdfName, uploadedPdfName } from '../store/community-text'
import { checkAttachmentQuota } from '../store/storage'
import { MODEL, idList, tagColor, tagFields, tagName, uuidParam, valid, version } from './community-contracts'

const ACTIONS = { feature: 'actions' } as const

function author({ identity }: RouteContext): ActorOut {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

function itemOf(state: CommunityState, id: number): DemoAction {
  const action = findAction(state, id)
  if (!action) throw new DemoApiError('action_not_found', 404)
  return action
}

function commentOf(state: CommunityState, action: DemoAction, id: number): DemoActionComment {
  const comment = state.comments.find(item => item.id === id)
  if (!comment || comment.actionId !== action.id) throw new DemoApiError('action_comment_not_found', 404)
  return comment
}

function attachmentOf(state: CommunityState, action: DemoAction, id: string): DemoActionAttachment {
  const attachment = state.attachments.find(item => item.id === id)
  if (!attachment || attachment.actionId !== action.id) throw new DemoApiError('action_attachment_not_found', 404)
  return attachment
}

/** `require_owner`: residents only change their own comments and PDFs; the administrator any. */
function requireOwner(content: { author: ActorOut }, actor: ActorOut): void {
  if (actor.kind !== 'administrator' && (content.author.kind !== actor.kind || content.author.user_id !== actor.user_id)) {
    throw new DemoApiError('action_owner_required', 403)
  }
}

/** Checks shared by the edits and withdrawals of comments and PDFs, in the backend's order. */
function editable(content: { author: ActorOut; version: number; withdrawnAt: string | null }, actor: ActorOut, expected: number): void {
  requireOwner(content, actor)
  if (content.version !== expected) throw new DemoApiError('action_stale', 409)
  if (content.withdrawnAt !== null) throw new DemoApiError('action_content_withdrawn', 409)
}

function filters(url: URL): ActionFilters {
  return {
    q: queryText(url, 'q', { max: 200 }).trim(),
    status: url.searchParams.has('status') ? queryChoice(url, 'status', ACTION_STATUSES, 'detected') : null,
    labels: [...new Set(idList(url, 'label'))],
    scope: queryChoice(url, 'scope', ['open', 'closed', 'all'], 'open'),
  }
}

/** `action_labels`: NFKC display names of at most 100 characters, one per name, sorted; null when one is invalid. */
function labelNames(values: readonly string[]): string[] | null {
  const names = new Map<string, string>()
  for (const value of values) {
    const name = labelName(value)
    if (name === null) return null
    if (!names.has(labelKey(name))) names.set(labelKey(name), name)
  }
  return [...names].sort(([a], [b]) => compareText(a, b)).map(([, name]) => name)
}

/** `list[str]` of at most 20 items: the strings, or null after recording the error. */
function labelList(body: Body): string[] | null {
  const raw = body.raw('labels')
  if (!Array.isArray(raw)) return body.fail('labels', 'list_type')
  if (raw.length > 20) return body.fail('labels', 'too_long')
  return raw.every(item => typeof item === 'string') ? raw : body.fail('labels', 'string_type')
}

/** `ActionIn`. */
function actionInput(body: Body): ActionInput {
  const title = body.text('title', { min: 1, max: 200 })
  const description = body.text('description', { max: 20000, fallback: '' })
  const rawLabels = body.present.has('labels') ? labelList(body) : []
  const status = body.literal('status', ACTION_STATUSES, 'detected')
  const labels = rawLabels && (labelNames(rawLabels) ?? body.fail('labels', 'value_error'))
  return {
    title: body.failed('title') ? title : displayName(title) ?? body.fail('title', 'value_error') ?? '',
    description: body.failed('description') ? description : actionText(description) ?? body.fail('description', 'value_error') ?? '',
    labels: labels ?? [], status,
  }
}

const EDIT_FIELDS = ['title', 'description', 'labels', 'status'] as const

/** `ActionEdit`: at least one non-null field besides the version. */
function actionEdit(body: Body): { version: number; edit: ActionEdit } {
  const expected = version(body)
  const title = body.optionalText('title', { min: 1, max: 200 })
  const description = body.optionalText('description', { max: 20000 })
  const rawLabels = body.raw('labels') === null || !body.present.has('labels') ? null : labelList(body)
  const status = body.optionalLiteral('status', ACTION_STATUSES)
  const edit: ActionEdit = {}
  if (valid(body, ['version', ...EDIT_FIELDS])) {
    const fields = EDIT_FIELDS.filter(field => body.present.has(field))
    if (fields.length === 0 || fields.some(field => body.raw(field) === null)) body.fail(MODEL, 'value_error')
    if (title !== null) edit.title = displayName(title) ?? body.fail(MODEL, 'value_error') ?? undefined
    if (description !== null) edit.description = actionText(description) ?? body.fail(MODEL, 'value_error') ?? undefined
    if (rawLabels !== null) edit.labels = labelNames(rawLabels) ?? body.fail(MODEL, 'value_error') ?? undefined
    if (status !== null) edit.status = status
  }
  return { version: expected, edit }
}

/** `ActionCommentIn.body`: visible text of at most 10,000 characters. */
function commentBody(body: Body): string {
  const value = body.text('body', { min: 1, max: 10000 })
  if (body.failed('body')) return value
  return actionText(value) || (body.fail('body', 'value_error') ?? '')
}

/** A page of `items`, rendered. */
function pageOf<T, R>(items: readonly T[], page: number, render: (item: T) => R) {
  const { items: slice, ...info } = paginate(items, page, ACTION_PAGE_SIZE)
  return { ...info, items: slice.map(render) }
}

function labelCatalogue({ url }: RouteContext) {
  const q = queryText(url, 'q', { max: 100 })
  const page = pageParam(url)
  const ids = url.searchParams.has('id') ? idList(url, 'id') : null
  const needle = casefold(q.normalize('NFKC').trim())
  const labels = communityStore().labels.filter(label => labelKey(label.name).includes(needle) && (ids === null || ids.includes(label.id)))
  return pageOf(sortLabels(labels), page, labelOut)
}

function pdf({ params }: RouteContext, disposition: 'attachment' | 'inline') {
  const [itemId, attachmentId] = attachmentPath(params)
  const state = communityStore()
  const attachment = attachmentOf(state, itemOf(state, itemId), attachmentId)
  if (attachment.purgedAt !== null) throw new DemoApiError('action_attachment_purged', 410)
  return pdfResponse(attachment.bytes.slice(), attachmentName(attachment), disposition)
}

function commentPath(params: PathParams): [number, number] {
  return [idParam(params, 'itemId'), idParam(params, 'commentId')]
}

function attachmentPath(params: PathParams): [number, string] {
  return [idParam(params, 'itemId'), uuidParam(params, 'attachmentId')]
}

/**
 * `upload_attachment`: a PDF of at most 20 MiB, 20 active per action, within the uploader's and the
 * community's storage quotas; retrying an upload id returns the stored PDF.
 */
async function upload(context: RouteContext): Promise<ActionAttachmentOut> {
  const itemId = idParam(context.params, 'itemId')
  const form = await readForm(context.request)
  const file = form.get('file'), uploadId = form.get('upload_id')
  const id = typeof uploadId === 'string' ? canonicalUuid(uploadId) : null
  // Not `instanceof File`: the form's File class may come from another realm (tests).
  if (file === null || typeof file === 'string' || id === null) throw new DemoApiError('invalid_request', 422)
  const state = communityStore()
  const action = itemOf(state, itemId)
  if (file.size > MAX_PDF_BYTES) throw new DemoApiError('upload_too_large', 413)
  const filename = uploadedPdfName(file.name)
  if (filename === null) throw new DemoApiError('action_pdf_required', 415)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!looksLikePdf(bytes)) throw new DemoApiError('action_pdf_required', 415)
  const sha256 = sha256Hex(bytes)
  const actor = author(context)
  const existing = state.attachments.find(item => item.id === id)
  if (existing) {
    const same = existing.actionId === action.id && existing.author.kind === actor.kind && existing.author.user_id === actor.user_id
      && existing.filename === filename && existing.sha256 === sha256 && existing.withdrawnAt === null
    if (!same) throw new DemoApiError('action_upload_conflict', 409)
    return attachmentOut(existing)
  }
  const active = state.attachments.filter(item => item.actionId === action.id && item.withdrawnAt === null).length
  if (active >= MAX_ACTIVE_PDFS) throw new DemoApiError('action_attachment_limit', 409)
  checkAttachmentQuota(state, actor, bytes.length)
  return attachmentOut(addAttachment(state, actor, action, { id, filename, bytes, sha256 }, nowIso()))
}

export const actionHandlers: HttpHandler[] = [
  http.get('/api/actions/board', route('session', ({ url }): ActionBoardOut => {
    const state = communityStore()
    const matching = sortActions(filterActions(state, filters(url)), 'activity', 'desc')
    return {
      columns: ACTION_STATUSES.map(status => {
        const items = matching.filter(action => action.status === status)
        return {
          status, items: items.slice(0, ACTION_PAGE_SIZE).map(action => actionSummary(state, action)),
          total: items.length, page: 1, pages: pageCount(items.length, ACTION_PAGE_SIZE),
        }
      }),
    }
  }, ACTIONS)),
  http.get('/api/actions/items', route('session', ({ url }) => {
    const selected = filters(url)
    const page = pageParam(url)
    const sort = queryChoice(url, 'sort', ['title', 'status', 'activity'], 'activity')
    const direction = queryChoice(url, 'direction', ['asc', 'desc'], 'desc')
    const state = communityStore()
    return pageOf(sortActions(filterActions(state, selected), sort, direction), page, action => actionSummary(state, action))
  }, ACTIONS)),
  http.post('/api/actions/items', route('session', async (context): Promise<ActionOut> => {
    const input = parseBody(await readJson(context.request), actionInput)
    const state = communityStore()
    return actionOut(state, createAction(state, author(context), input, nowIso()))
  }, { ...ACTIONS, status: 201 })),
  http.get('/api/actions/labels', route('session', labelCatalogue, ACTIONS)),
  http.get('/api/actions/items/:itemId', route('session', ({ params }) => {
    const state = communityStore()
    return actionOut(state, itemOf(state, idParam(params, 'itemId')))
  }, ACTIONS)),
  http.patch('/api/actions/items/:itemId', route('session', async context => {
    const itemId = idParam(context.params, 'itemId')
    const { version: expected, edit } = parseBody(await readJson(context.request), actionEdit)
    const state = communityStore()
    const action = itemOf(state, itemId)
    if (action.version !== expected) throw new DemoApiError('action_stale', 409)
    editAction(state, author(context), action, edit, nowIso())
    return actionOut(state, action)
  }, ACTIONS)),
  http.get('/api/actions/items/:itemId/comments', route('session', ({ params, url }) => {
    const itemId = idParam(params, 'itemId')
    const page = pageParam(url)
    const state = communityStore()
    const action = itemOf(state, itemId)
    const comments = state.comments.filter(comment => comment.actionId === action.id).sort((a, b) => b.id - a.id)
    return pageOf(comments, page, commentOut)
  }, ACTIONS)),
  http.post('/api/actions/items/:itemId/comments', route('session', async context => {
    const itemId = idParam(context.params, 'itemId')
    const body = parseBody(await readJson(context.request), commentBody)
    const state = communityStore()
    return commentOut(addComment(state, author(context), itemOf(state, itemId), body, nowIso()))
  }, { ...ACTIONS, status: 201 })),
  http.get('/api/actions/items/:itemId/comments/:commentId', route('session', ({ params }) => {
    const [itemId, commentId] = commentPath(params)
    const state = communityStore()
    return commentOut(commentOf(state, itemOf(state, itemId), commentId))
  }, ACTIONS)),
  http.patch('/api/actions/items/:itemId/comments/:commentId', route('session', async context => {
    const [itemId, commentId] = commentPath(context.params)
    const input = parseBody(await readJson(context.request), body => ({ body: commentBody(body), version: version(body) }))
    const state = communityStore()
    const action = itemOf(state, itemId)
    const comment = commentOf(state, action, commentId)
    const actor = author(context)
    editable(comment, actor, input.version)
    editComment(state, actor, action, comment, input.body, nowIso())
    return commentOut(comment)
  }, ACTIONS)),
  http.delete('/api/actions/items/:itemId/comments/:commentId', route('session', async context => {
    const [itemId, commentId] = commentPath(context.params)
    const expected = parseBody(await readJson(context.request), version)
    const state = communityStore()
    const action = itemOf(state, itemId)
    const comment = commentOf(state, action, commentId)
    const actor = author(context)
    editable(comment, actor, expected)
    withdrawComment(state, actor, action, comment, nowIso())
  }, { ...ACTIONS, status: 204 })),
  http.get('/api/actions/items/:itemId/attachments', route('session', ({ params, url }) => {
    const itemId = idParam(params, 'itemId')
    const page = pageParam(url)
    const withdrawn = queryBool(url, 'include_withdrawn')
    const state = communityStore()
    const action = itemOf(state, itemId)
    const attachments = state.attachments
      .filter(attachment => attachment.actionId === action.id && (withdrawn || attachment.withdrawnAt === null))
      .sort((a, b) => compareText(b.createdAt, a.createdAt) || compareText(b.id, a.id))
    return pageOf(attachments, page, attachmentOut)
  }, ACTIONS)),
  http.post('/api/actions/items/:itemId/attachments', route('session', upload, { ...ACTIONS, status: 201 })),
  http.get('/api/actions/items/:itemId/attachments/:attachmentId', route('session', ({ params }) => {
    const [itemId, attachmentId] = attachmentPath(params)
    const state = communityStore()
    return attachmentOut(attachmentOf(state, itemOf(state, itemId), attachmentId))
  }, ACTIONS)),
  http.patch('/api/actions/items/:itemId/attachments/:attachmentId', route('session', async context => {
    const [itemId, attachmentId] = attachmentPath(context.params)
    const input = parseBody(await readJson(context.request), body => {
      const value = body.text('filename', { min: 1, max: 255 })
      return {
        version: version(body),
        filename: body.failed('filename') ? value : renamedPdfName(value) ?? body.fail('filename', 'value_error') ?? '',
      }
    })
    const state = communityStore()
    const action = itemOf(state, itemId)
    const attachment = attachmentOf(state, action, attachmentId)
    const actor = author(context)
    editable(attachment, actor, input.version)
    renameAttachment(state, actor, action, attachment, input.filename, nowIso())
    return attachmentOut(attachment)
  }, ACTIONS)),
  http.delete('/api/actions/items/:itemId/attachments/:attachmentId', route('session', async context => {
    const [itemId, attachmentId] = attachmentPath(context.params)
    const expected = parseBody(await readJson(context.request), version)
    const state = communityStore()
    const action = itemOf(state, itemId)
    const attachment = attachmentOf(state, action, attachmentId)
    const actor = author(context)
    editable(attachment, actor, expected)
    withdrawAttachment(state, actor, action, attachment, nowIso())
  }, { ...ACTIONS, status: 204 })),
  http.get('/api/actions/items/:itemId/attachments/:attachmentId/download', route('session', context => pdf(context, 'attachment'), ACTIONS)),
  http.get('/api/actions/items/:itemId/attachments/:attachmentId/preview', route('session', context => pdf(context, 'inline'), ACTIONS)),
  http.get('/api/actions/items/:itemId/history', route('session', ({ params, url }) => {
    const itemId = idParam(params, 'itemId')
    const page = pageParam(url)
    const state = communityStore()
    const action = itemOf(state, itemId)
    return pageOf(state.actionHistory.filter(event => event.actionId === action.id).sort((a, b) => b.id - a.id), page, actionEventOut)
  }, ACTIONS)),
  http.get('/api/admin/action-labels', route('admin', labelCatalogue)),
  http.get('/api/admin/action-labels/:labelId', route('admin', ({ params }) => {
    const label = findLabel(communityStore(), idParam(params, 'labelId'))
    if (!label) throw new DemoApiError('action_label_not_found', 404)
    return labelOut(label)
  })),
  http.patch('/api/admin/action-labels/:labelId', route('admin', async context => {
    const labelId = idParam(context.params, 'labelId')
    const input = parseBody(await readJson(context.request), body => ({ name: tagName(body), color: tagColor(body), version: version(body) }), { fields: tagFields })
    const state = communityStore()
    const label = findLabel(state, labelId)
    if (!label) throw new DemoApiError('action_label_not_found', 404)
    if (label.version !== input.version) throw new DemoApiError('action_label_stale', 409)
    if (label.name === input.name && label.color === input.color) return labelOut(label)
    if (state.labels.some(other => other.id !== label.id && labelKey(other.name) === labelKey(input.name))) {
      throw new DemoApiError('action_label_exists', 409, { name: 'action_label_exists' })
    }
    editLabel(state, author(context), label, input.name, input.color, nowIso())
    return labelOut(label)
  })),
]
