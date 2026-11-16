/**
 * Storage administration routes of the demo API (src/juntia/storage_admin.py): the storage the
 * action PDFs, the pasted images and the shared documents use, per resident and for the community,
 * with the synthetic upload volume; the withdrawn PDFs, the images and the earlier document
 * versions that still use it; and their purge, which deletes the file but keeps its record (and
 * the history of a PDF or a document). Administrator only; they keep working while the Actions,
 * Events and Documents features are off.
 */
import type {
  ActionAttachmentOut, ActorOut, StorageOut, StoredAttachmentPage, StoredDocumentVersionOut, StoredDocumentVersionPage, StoredImageOut,
  StoredImagePage,
} from '../../api/schema.gen'
import {
  DemoApiError, actorOf, http, nowIso, pageParam, paginate, parseBody, pdfResponse, queryText, readJson, route, type HttpHandler,
  type RouteContext,
} from '../core'
import { communityStore } from '../store/community'
import { attachmentName, attachmentOut, findAction, purgeAttachment } from '../store/community-actions'
import { findImage, purgeImage, storedImageList, storedImageOut } from '../store/community-images'
import { purgeDocumentVersion, sharedDocumentsStore } from '../store/shared-documents'
import {
  STORAGE_PAGE_SIZE, nameMatches, previousDocumentVersions, storageSummary, storedDocumentVersionOut, withdrawnAttachments,
} from '../store/storage'
import { uuidParam, version } from './community-contracts'
import { imageResponse } from './community-images'

function administrator({ identity }: RouteContext): ActorOut {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

function storedPdf({ params }: RouteContext, disposition: 'attachment' | 'inline'): Response {
  const attachmentId = uuidParam(params, 'attachmentId')
  const attachment = communityStore().attachments.find(item => item.id === attachmentId)
  if (!attachment) throw new DemoApiError('action_attachment_not_found', 404)
  if (attachment.purgedAt !== null) throw new DemoApiError('action_attachment_purged', 410)
  return pdfResponse(attachment.bytes.slice(), attachmentName(attachment), disposition)
}

export const storageHandlers: HttpHandler[] = [
  http.get('/api/admin/storage', route('admin', (): StorageOut => storageSummary(communityStore(), sharedDocumentsStore()))),
  // The latest withdrawn first, five per page, optionally by name.
  http.get('/api/admin/storage/withdrawn', route('admin', ({ url }): StoredAttachmentPage => {
    const page = pageParam(url)
    const q = queryText(url, 'q', { max: 200 })
    const state = communityStore()
    const { items, ...info } = paginate(withdrawnAttachments(state, q), page, STORAGE_PAGE_SIZE)
    return {
      ...info,
      items: items.map(attachment => ({
        ...attachmentOut(attachment), action_id: attachment.actionId, action_title: findAction(state, attachment.actionId)?.title ?? '',
      })),
    }
  })),
  // The administrator's copy of a stored PDF, withdrawn or not, also while Actions is turned off.
  http.get('/api/admin/storage/attachments/:attachmentId/preview', route('admin', context => storedPdf(context, 'inline'))),
  http.get('/api/admin/storage/attachments/:attachmentId/download', route('admin', context => storedPdf(context, 'attachment'))),
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
  // Every stored image, the newest first: images have no withdrawal, so any can be purged.
  http.get('/api/admin/storage/images', route('admin', ({ url }): StoredImagePage => {
    const page = pageParam(url)
    const q = queryText(url, 'q', { max: 200 })
    const { items, ...info } = paginate(storedImageList(communityStore(), name => nameMatches(name, q)), page, STORAGE_PAGE_SIZE)
    return { ...info, items: items.map(storedImageOut) }
  })),
  http.get('/api/admin/storage/images/:imageId/file', route('admin', ({ params }) => {
    const image = findImage(communityStore(), uuidParam(params, 'imageId'))
    if (!image) throw new DemoApiError('image_not_found', 404)
    return imageResponse(image)
  })),
  // Purging again answers the purged image unchanged.
  http.post('/api/admin/storage/images/:imageId/purge', route('admin', ({ params }): StoredImageOut => {
    const image = findImage(communityStore(), uuidParam(params, 'imageId'))
    if (!image) throw new DemoApiError('image_not_found', 404)
    purgeImage(image, nowIso())
    return storedImageOut(image)
  })),
  // Earlier versions of documents that still use storage, the latest uploaded first: the candidates for a purge.
  http.get('/api/admin/storage/document-versions', route('admin', ({ url }): StoredDocumentVersionPage => {
    const page = pageParam(url)
    const q = queryText(url, 'q', { max: 200 })
    const documents = sharedDocumentsStore()
    const { items, ...info } = paginate(previousDocumentVersions(documents, q), page, STORAGE_PAGE_SIZE)
    return { ...info, items: items.map(item => storedDocumentVersionOut(documents, item)) }
  })),
  // Purging again answers the purged version unchanged.
  http.post('/api/admin/storage/document-versions/:versionId/purge', route('admin', (context): StoredDocumentVersionOut => {
    const versionId = uuidParam(context.params, 'versionId')
    const documents = sharedDocumentsStore()
    return storedDocumentVersionOut(documents, purgeDocumentVersion(documents, administrator(context), versionId, nowIso()))
  })),
]
