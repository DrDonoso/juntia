/**
 * Image routes of the demo API (src/juntia/community_images.py): uploads of the images pasted into
 * the Markdown of actions, comments and events, and their files. Each section serves its own
 * images under its feature switch (404 `actions_disabled` / `events_disabled` while it is off).
 */
import type { ActorOut, CommunityImageOut } from '../../api/schema.gen'
import {
  DemoApiError, HttpResponse, actorOf, fileDisposition, http, nowIso, readForm, route, type HttpHandler, type RouteContext,
} from '../core'
import { communityStore } from '../store/community'
import {
  MAX_IMAGE_BYTES, addImage, findImage, imageFormat, imageOut, uploadedImageName,
} from '../store/community-images'
import type { DemoCommunityImage, ImageScope } from '../store/community-model'
import { sha256Hex } from '../store/community-sha256'
import { canonicalUuid } from '../store/community-text'
import { checkAttachmentQuota } from '../store/storage'
import { uuidParam } from './community-contracts'

function author({ identity }: RouteContext): ActorOut {
  if (!identity) throw new DemoApiError('authentication_required', 401)
  return actorOf(identity)
}

/** The file, inline, like the backend's FileResponse; 410 `image_purged` once purged. */
export function imageResponse(image: DemoCommunityImage): Response {
  if (image.purgedAt !== null) throw new DemoApiError('image_purged', 410)
  return new HttpResponse(image.bytes.slice(), {
    headers: { 'Content-Type': image.mediaType, 'Content-Disposition': fileDisposition('inline', image.filename) },
  })
}

/**
 * `upload_image`: a PNG, JPEG, GIF or WebP of at most 10 MiB, recognized from its bytes, within the
 * uploader's and the community's storage quotas; retrying an upload id returns the stored image.
 */
async function upload(scope: ImageScope, context: RouteContext): Promise<CommunityImageOut> {
  const form = await readForm(context.request)
  const file = form.get('file'), uploadId = form.get('upload_id')
  const id = typeof uploadId === 'string' ? canonicalUuid(uploadId) : null
  // Not `instanceof File`: the form's File class may come from another realm (tests).
  if (file === null || typeof file === 'string' || id === null) throw new DemoApiError('invalid_request', 422)
  if (file.size > MAX_IMAGE_BYTES) throw new DemoApiError('image_too_large', 413)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = imageFormat(bytes)
  const filename = uploadedImageName(file.name, format.mediaType)
  const sha256 = sha256Hex(bytes)
  const actor = author(context)
  const state = communityStore()
  const existing = findImage(state, id)
  if (existing) {
    const same = existing.scope === scope && existing.author.kind === actor.kind && existing.author.user_id === actor.user_id
      && existing.filename === filename && existing.sha256 === sha256 && existing.purgedAt === null
    if (!same) throw new DemoApiError('image_upload_conflict', 409)
    return imageOut(existing)
  }
  checkAttachmentQuota(state, actor, bytes.length)
  return imageOut(addImage(state, actor, scope, { id, filename, bytes, sha256, ...format }, nowIso()))
}

function file(scope: ImageScope, { params }: RouteContext): Response {
  const image = findImage(communityStore(), uuidParam(params, 'imageId'))
  if (!image || image.scope !== scope) throw new DemoApiError('image_not_found', 404)
  return imageResponse(image)
}

export const imageHandlers: HttpHandler[] = [
  http.post('/api/actions/images', route('session', context => upload('actions', context), { feature: 'actions', status: 201 })),
  http.get('/api/actions/images/:imageId', route('session', context => file('actions', context), { feature: 'actions' })),
  http.post('/api/events/images', route('session', context => upload('events', context), { feature: 'events', status: 201 })),
  http.get('/api/events/images/:imageId', route('session', context => file('events', context), { feature: 'events' })),
]
