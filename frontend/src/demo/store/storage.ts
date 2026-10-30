/**
 * Storage of the action PDFs (SEC-03: src/juntia/storage.py and storage_admin.py): the byte quotas
 * of each resident and of the community with the backend's default settings, the synthetic upload
 * volume, and the usage and withdrawn PDFs of the administrator's storage page. Everything is
 * computed from the community store's attachments: active and withdrawn PDFs use storage until the
 * administrator purges them, so there is no state of its own to reset.
 */
import type { ActorOut, DiskSpaceOut, ResidentStorageOut, StorageOut, StorageUsageOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { findResident } from './core'
import { compareText, type CommunityState, type DemoActionAttachment } from './community-model'
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

/** Free space of the volume without the action PDFs (about 41.3 GiB): the PDFs stored now take theirs. */
const DISK_FREE_WITHOUT_PDFS = 42_291 * MIB

/** PDFs whose file is still stored: active and withdrawn ones until a purge (`stored_bytes`). */
export function storedAttachments(state: CommunityState): DemoActionAttachment[] {
  return state.attachments.filter(attachment => attachment.purgedAt === null)
}

function residentAuthor(author: ActorOut): number | null {
  return author.kind === 'resident' ? author.user_id : null
}

/** Stored, active and withdrawn bytes and files of `attachments` (all of them still stored). */
export function storageUsage(attachments: readonly DemoActionAttachment[]): StorageUsageOut {
  const active = attachments.filter(attachment => attachment.withdrawnAt === null)
  const bytes = (rows: readonly DemoActionAttachment[]) => rows.reduce((sum, attachment) => sum + attachment.size, 0)
  const stored = bytes(attachments), activeBytes = bytes(active)
  return {
    stored_bytes: stored, active_bytes: activeBytes, withdrawn_bytes: stored - activeBytes,
    active_files: active.length, withdrawn_files: attachments.length - active.length,
  }
}

/** The upload volume: its free space follows the PDFs uploaded and purged during the visit. */
export function diskSpace(state: CommunityState): DiskSpaceOut {
  return {
    total_bytes: DISK_TOTAL_BYTES,
    free_bytes: DISK_FREE_WITHOUT_PDFS - storageUsage(storedAttachments(state)).stored_bytes,
    reserve_bytes: DISK_RESERVE_BYTES,
  }
}

/**
 * `GET /api/admin/storage`: the community's usage and quota, the administrator's PDFs, and each
 * resident who stores PDFs, largest first. Deleted accounts keep their PDFs: they are named by the
 * author name of their latest PDF.
 */
export function storageSummary(state: CommunityState): StorageOut {
  const stored = storedAttachments(state)
  const residents = new Map<number, DemoActionAttachment[]>()
  for (const attachment of stored) {
    const userId = residentAuthor(attachment.author)
    if (userId !== null) residents.set(userId, [...residents.get(userId) ?? [], attachment])
  }
  return {
    community: { quota_bytes: COMMUNITY_QUOTA_BYTES, ...storageUsage(stored) },
    administrator: storageUsage(stored.filter(attachment => residentAuthor(attachment.author) === null)),
    residents: [...residents].map(([userId, attachments]) => residentStorage(userId, attachments))
      .sort((a, b) => b.stored_bytes - a.stored_bytes || compareText(casefold(a.name), casefold(b.name)) || a.user_id - b.user_id),
    resident_quota_bytes: USER_QUOTA_BYTES,
    disk: diskSpace(state),
  }
}

function residentStorage(userId: number, attachments: readonly DemoActionAttachment[]): ResidentStorageOut {
  const account = findResident(userId)
  const latest = attachments.reduce((newest, attachment) =>
    (compareText(attachment.createdAt, newest.createdAt) || compareText(attachment.id, newest.id)) > 0 ? attachment : newest)
  return {
    user_id: userId, name: account?.name ?? latest.author.name, account_deleted: !account, quota_bytes: USER_QUOTA_BYTES,
    ...storageUsage(attachments),
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
 * `check_attachment_quota`: a new PDF of `size` bytes must fit the uploader's quota (residents
 * only), then the community's (409 `action_storage_user_quota` / `action_storage_community_quota`).
 */
export function checkAttachmentQuota(state: CommunityState, actor: ActorOut, size: number): void {
  const stored = storedAttachments(state)
  const userId = residentAuthor(actor)
  if (userId !== null) {
    const used = storageUsage(stored.filter(attachment => residentAuthor(attachment.author) === userId)).stored_bytes
    if (used + size > USER_QUOTA_BYTES) throw new DemoApiError('action_storage_user_quota', 409)
  }
  if (storageUsage(stored).stored_bytes + size > COMMUNITY_QUOTA_BYTES) throw new DemoApiError('action_storage_community_quota', 409)
}
