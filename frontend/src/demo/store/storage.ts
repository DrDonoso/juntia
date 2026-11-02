/**
 * Storage of the action PDFs and of the images pasted into texts (SEC-03: src/juntia/storage.py and
 * storage_admin.py): the byte quotas of each resident and of the community with the backend's
 * default settings, the synthetic upload volume, and the usage, withdrawn PDFs and images of the
 * administrator's storage page. Everything is computed from the community store's attachments and
 * images: PDFs (active or withdrawn) and images use storage until the administrator purges them,
 * so there is no state of its own to reset.
 */
import type { ActorOut, DiskSpaceOut, ResidentStorageOut, StorageOut, StorageUsageOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { findResident } from './core'
import { compareText, type CommunityState, type DemoActionAttachment, type DemoCommunityImage } from './community-model'
import { casefold } from './community-text'

export const MIB = 1024 * 1024

/** `ACTION_STORAGE_USER_QUOTA_MB` (250): what each resident's PDFs may take, withdrawn ones included. */
export const USER_QUOTA_BYTES = 250 * MIB

/** `ACTION_STORAGE_COMMUNITY_QUOTA_MB` (2048): what all the PDFs may take; the administrator has no quota of their own. */
export const COMMUNITY_QUOTA_BYTES = 2048 * MIB

/** `MIN_FREE_DISK_MB` (1024): free space kept on the upload volume. */
export const DISK_RESERVE_BYTES = 1024 * MIB

/** The synthetic upload volume: 64 GiB. */
export const DISK_TOTAL_BYTES = 64 * 1024 * MIB

/** Free space of the volume without the stored files (about 41.3 GiB): the PDFs and images stored now take theirs. */
const DISK_FREE_WITHOUT_PDFS = 42_291 * MIB

/** PDFs whose file is still stored: active and withdrawn ones until a purge (`stored_bytes`). */
export function storedAttachments(state: CommunityState): DemoActionAttachment[] {
  return state.attachments.filter(attachment => attachment.purgedAt === null)
}

/** Images whose file is still stored: every one until a purge. */
export function storedImages(state: CommunityState): DemoCommunityImage[] {
  return state.images.filter(image => image.purgedAt === null)
}

function residentAuthor(author: ActorOut): number | null {
  return author.kind === 'resident' ? author.user_id : null
}

function totalSize(rows: readonly { size: number }[]): number {
  return rows.reduce((sum, row) => sum + row.size, 0)
}

/** Stored, active and withdrawn bytes and files of `attachments`, plus `images` (all of them still stored). */
export function storageUsage(attachments: readonly DemoActionAttachment[], images: readonly DemoCommunityImage[] = []): StorageUsageOut {
  const active = attachments.filter(attachment => attachment.withdrawnAt === null)
  const stored = totalSize(attachments), activeBytes = totalSize(active), imageBytes = totalSize(images)
  return {
    stored_bytes: stored + imageBytes, active_bytes: activeBytes, withdrawn_bytes: stored - activeBytes,
    active_files: active.length, withdrawn_files: attachments.length - active.length,
    image_bytes: imageBytes, image_files: images.length,
  }
}

/** The upload volume: its free space follows the files uploaded and purged during the visit. */
export function diskSpace(state: CommunityState): DiskSpaceOut {
  return {
    total_bytes: DISK_TOTAL_BYTES,
    free_bytes: DISK_FREE_WITHOUT_PDFS - storageUsage(storedAttachments(state), storedImages(state)).stored_bytes,
    reserve_bytes: DISK_RESERVE_BYTES,
  }
}

type AuthorFiles = { attachments: DemoActionAttachment[]; images: DemoCommunityImage[] }

/**
 * `GET /api/admin/storage`: the community's usage and quota, the administrator's files, and each
 * resident who stores PDFs or images, largest first. Deleted accounts keep their files: they are
 * named by the author name of their latest file.
 */
export function storageSummary(state: CommunityState): StorageOut {
  const stored = storedAttachments(state), images = storedImages(state)
  const residents = new Map<number, AuthorFiles>()
  const files = (userId: number): AuthorFiles => {
    let owned = residents.get(userId)
    if (!owned) residents.set(userId, owned = { attachments: [], images: [] })
    return owned
  }
  for (const attachment of stored) {
    const userId = residentAuthor(attachment.author)
    if (userId !== null) files(userId).attachments.push(attachment)
  }
  for (const image of images) {
    const userId = residentAuthor(image.author)
    if (userId !== null) files(userId).images.push(image)
  }
  const administrator = (author: ActorOut) => residentAuthor(author) === null
  return {
    community: { quota_bytes: COMMUNITY_QUOTA_BYTES, ...storageUsage(stored, images) },
    administrator: storageUsage(stored.filter(item => administrator(item.author)), images.filter(item => administrator(item.author))),
    residents: [...residents].map(([userId, owned]) => residentStorage(userId, owned))
      .sort((a, b) => b.stored_bytes - a.stored_bytes || compareText(casefold(a.name), casefold(b.name)) || a.user_id - b.user_id),
    resident_quota_bytes: USER_QUOTA_BYTES,
    disk: diskSpace(state),
  }
}

function residentStorage(userId: number, { attachments, images }: AuthorFiles): ResidentStorageOut {
  const account = findResident(userId)
  const latest = [...attachments, ...images].reduce((newest, file) =>
    (compareText(file.createdAt, newest.createdAt) || compareText(file.id, newest.id)) > 0 ? file : newest)
  return {
    user_id: userId, name: account?.name ?? latest.author.name, account_deleted: !account, quota_bytes: USER_QUOTA_BYTES,
    ...storageUsage(attachments, images),
  }
}

export type WithdrawnSort = 'largest' | 'oldest'

/**
 * Withdrawn PDFs that still use storage (the candidates for a purge), of one resident when
 * `userId` is set: the largest first (then the oldest withdrawals), or the oldest withdrawals first.
 */
export function withdrawnAttachments(state: CommunityState, sort: WithdrawnSort, userId: number | null): DemoActionAttachment[] {
  const byWithdrawal = (a: DemoActionAttachment, b: DemoActionAttachment) =>
    compareText(a.withdrawnAt ?? '', b.withdrawnAt ?? '') || compareText(a.id, b.id)
  return storedAttachments(state)
    .filter(attachment => attachment.withdrawnAt !== null && (userId === null || residentAuthor(attachment.author) === userId))
    .sort(sort === 'oldest' ? byWithdrawal : (a, b) => b.size - a.size || byWithdrawal(a, b))
}

/**
 * `check_attachment_quota`: a new PDF or image of `size` bytes must fit the uploader's quota
 * (residents only), then the community's (409 `action_storage_user_quota` /
 * `action_storage_community_quota`). PDFs and images share both budgets.
 */
export function checkAttachmentQuota(state: CommunityState, actor: ActorOut, size: number): void {
  const stored = storedAttachments(state), images = storedImages(state)
  const userId = residentAuthor(actor)
  if (userId !== null) {
    const mine = (author: ActorOut) => residentAuthor(author) === userId
    const used = storageUsage(stored.filter(item => mine(item.author)), images.filter(item => mine(item.author))).stored_bytes
    if (used + size > USER_QUOTA_BYTES) throw new DemoApiError('action_storage_user_quota', 409)
  }
  if (storageUsage(stored, images).stored_bytes + size > COMMUNITY_QUOTA_BYTES) throw new DemoApiError('action_storage_community_quota', 409)
}
