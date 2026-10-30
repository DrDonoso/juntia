/**
 * Storage administration routes of the demo API (src/juntia/storage_admin.py): the storage the
 * action PDFs use, per resident and for the community, with the synthetic upload volume; the
 * withdrawn PDFs that still use it; and their purge, which deletes the file but keeps its record
 * and history. Administrator only; they keep working while the Actions feature is off.
 */
import type { ActionAttachmentOut, ActorOut, StorageOut, StoredAttachmentPage } from '../../api/schema.gen'
import {
  DemoApiError, actorOf, http, nowIso, pageParam, paginate, parseBody, queryChoice, queryInt, readJson, route, type HttpHandler,
  type RouteContext,
} from '../core'
import { communityStore } from '../store/community'
import { ACTION_PAGE_SIZE, attachmentOut, findAction, purgeAttachment } from '../store/community-actions'
import { storageSummary, withdrawnAttachments } from '../store/storage'
import { uuidParam, version } from './community-contracts'

function administrator({ identity }: RouteContext): ActorOut {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

export const storageHandlers: HttpHandler[] = [
  http.get('/api/admin/storage', route('admin', (): StorageOut => storageSummary(communityStore()))),
  http.get('/api/admin/storage/withdrawn', route('admin', ({ url }): StoredAttachmentPage => {
    const page = pageParam(url)
    const sort = queryChoice(url, 'sort', ['largest', 'oldest'], 'largest')
    const userId = queryInt(url, 'user_id')
    const state = communityStore()
    const { items, ...info } = paginate(withdrawnAttachments(state, sort, userId), page, ACTION_PAGE_SIZE)
    return {
      ...info,
      items: items.map(attachment => ({
        ...attachmentOut(attachment), action_id: attachment.actionId, action_title: findAction(state, attachment.actionId)?.title ?? '',
      })),
    }
  })),
  // Purging again answers the purged PDF unchanged; otherwise the version must match and the PDF be withdrawn.
  http.post('/api/admin/storage/attachments/:attachmentId/purge', route('admin', async (context): Promise<ActionAttachmentOut> => {
    const attachmentId = uuidParam(context.params, 'attachmentId')
    const expected = parseBody(await readJson(context.request), version)
    const state = communityStore()
    const attachment = state.attachments.find(item => item.id === attachmentId)
    if (!attachment) throw new DemoApiError('action_attachment_not_found', 404)
    if (attachment.purgedAt === null) {
      if (attachment.version !== expected) throw new DemoApiError('action_stale', 409)
      if (attachment.withdrawnAt === null) throw new DemoApiError('action_attachment_active', 409)
      const action = findAction(state, attachment.actionId)
      if (!action) throw new Error(`The PDF ${attachment.id} has no action`)
      purgeAttachment(state, administrator(context), action, attachment, nowIso())
    }
    return attachmentOut(attachment)
  })),
]
