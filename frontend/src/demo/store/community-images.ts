/**
 * Images pasted into the Markdown of actions, comments and events (src/juntia/community_images.py):
 * the format comes from the bytes and the size from the header, never from the name; each image
 * belongs to the section whose routes serve it; the administrator can purge any of them.
 */
import type { ActorOut, CommunityImageOut, StoredImageOut } from '../../api/schema.gen'
import { DemoApiError } from '../core/errors'
import { actorOut, compareText, type CommunityState, type DemoCommunityImage, type ImageMediaType, type ImageScope } from './community-model'

/** `MAX_IMAGE_BYTES`: 10 MiB per image. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_SIDE = 16384
const MAX_IMAGE_PIXELS = 40_000_000
/** The size must be found in this prefix of the file, within this many segments or blocks (`HEADER_BYTES`, `MAX_HEADER_STEPS`). */
const HEADER_BYTES = 1024 * 1024
const MAX_HEADER_STEPS = 10_000
const EXTENSIONS: Record<ImageMediaType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** JPEG frame headers (SOFn) carry the size; C4, C8 and CC are other segments. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}]/u

export interface ImageFormat {
  mediaType: ImageMediaType
  width: number
  height: number
}

function invalid(): DemoApiError {
  return new DemoApiError('image_invalid', 415)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

/** Backend `jpeg_size`: the segments after SOI, until a frame header. */
function jpegSize(head: Uint8Array): [number, number] {
  let offset = 2
  for (let step = 0; step < MAX_HEADER_STEPS; step++) {
    if (head[offset] !== 0xff) throw invalid()
    // The marker follows its 0xFF and any number of 0xFF fill bytes.
    while (head[offset] === 0xff) offset++
    if (offset + 3 > head.length) throw invalid()
    const marker = head[offset++]
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) throw invalid()
    const length = (head[offset] << 8) | head[offset + 1]
    if (length < 2) throw invalid()
    if (JPEG_FRAMES.has(marker)) {
      if (offset + 7 > head.length) throw invalid()
      return [(head[offset + 5] << 8) | head[offset + 6], (head[offset + 3] << 8) | head[offset + 4]]
    }
    offset += length
  }
  throw invalid()
}

/** Backend `gif_size`: the logical screen, enlarged so that the first frame fits, as browsers do. */
function gifSize(head: Uint8Array): [number, number] {
  if (head.length < 13) throw invalid()
  const word = (offset: number) => head[offset] | (head[offset + 1] << 8)
  const flags = head[10]
  let offset = 13 + (flags & 0x80 ? 3 << ((flags & 0x07) + 1) : 0)
  let inExtension = false
  for (let step = 0; step < MAX_HEADER_STEPS && offset < head.length; step++) {
    const block = head[offset]
    if (inExtension) {
      offset += 1 + block
      inExtension = block !== 0
    } else if (block === 0x21) {
      offset += 2
      inExtension = true
    } else if (block === 0x2c && offset + 9 <= head.length) {
      return [Math.max(word(6), word(offset + 1) + word(offset + 5)), Math.max(word(8), word(offset + 3) + word(offset + 7))]
    } else {
      break
    }
  }
  throw invalid()
}

function webpSize(bytes: Uint8Array): [number, number] {
  const chunk = ascii(bytes, 12, 16), data = bytes.subarray(20, 30)
  if (chunk === 'VP8 ') {
    if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw invalid()
    return [((data[7] << 8) | data[6]) & 0x3fff, ((data[9] << 8) | data[8]) & 0x3fff]
  }
  if (chunk === 'VP8L') {
    if (data[0] !== 0x2f) throw invalid()
    const bits = (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  if (chunk === 'VP8X') {
    return [(data[4] | (data[5] << 8) | (data[6] << 16)) + 1, (data[7] | (data[8] << 8) | (data[9] << 16)) + 1]
  }
  throw invalid()
}

/** Backend `image_format`: 415 `image_invalid` or 422 `image_dimensions_too_large`. */
export function imageFormat(bytes: Uint8Array): ImageFormat {
  const head = bytes.subarray(0, HEADER_BYTES)
  let mediaType: ImageMediaType, width: number, height: number
  if (PNG_SIGNATURE.every((byte, index) => head[index] === byte)) {
    if (head.length < 24 || ascii(head, 12, 16) !== 'IHDR') throw invalid()
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    mediaType = 'image/png'
    width = view.getUint32(16)
    height = view.getUint32(20)
  } else if (['GIF87a', 'GIF89a'].includes(ascii(head, 0, 6))) {
    mediaType = 'image/gif';
    [width, height] = gifSize(head)
  } else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    mediaType = 'image/jpeg';
    [width, height] = jpegSize(head)
  } else if (head.length >= 30 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    mediaType = 'image/webp';
    [width, height] = webpSize(head)
  } else {
    throw invalid()
  }
  if (width < 1 || height < 1) throw invalid()
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new DemoApiError('image_dimensions_too_large', 422)
  }
  return { mediaType, width, height }
}

/** Backend `image_filename`: no folders or control characters, the format's extension. */
export function uploadedImageName(filename: string, mediaType: ImageMediaType): string {
  const base = filename.split(/[/\\]/).at(-1) ?? ''
  const name = Array.from(base).filter(character => !FORMAT_OR_CONTROL.test(character)).join('')
  const stem = name.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/^[ .]+|[ .]+$/g, '') || 'image'
  return `${Array.from(stem).slice(0, 250).join('')}.${EXTENSIONS[mediaType]}`
}

export function imageOut(image: DemoCommunityImage): CommunityImageOut {
  return {
    id: image.id, url: `/api/${image.scope}/images/${image.id}`, filename: image.filename, media_type: image.mediaType,
    size: image.size, width: image.width, height: image.height, created_at: image.createdAt,
  }
}

export function storedImageOut(image: DemoCommunityImage): StoredImageOut {
  return { ...imageOut(image), scope: image.scope, sha256: image.sha256, author: actorOut(image.author), purged_at: image.purgedAt }
}

export function findImage(state: CommunityState, id: string): DemoCommunityImage | undefined {
  return state.images.find(image => image.id === id)
}

export function addImage(
  state: CommunityState, author: ActorOut, scope: ImageScope,
  image: { id: string; filename: string; bytes: Uint8Array<ArrayBuffer>; sha256: string } & ImageFormat, at: string,
): DemoCommunityImage {
  const stored: DemoCommunityImage = {
    id: image.id, scope, filename: image.filename, mediaType: image.mediaType, size: image.bytes.length, sha256: image.sha256,
    width: image.width, height: image.height, bytes: image.bytes, author, createdAt: at, purgedAt: null,
  }
  state.images.push(stored)
  return stored
}

/** The administrator's purge: the file goes, the record stays (its address answers 410). */
export function purgeImage(image: DemoCommunityImage, at: string): void {
  if (image.purgedAt !== null) return
  image.purgedAt = at
  image.bytes = new Uint8Array(0)
}

export type ImageSort = 'newest' | 'largest'

/** Stored images (not purged), of one resident when `userId` is set: newest or largest first. */
export function storedImageList(state: CommunityState, sort: ImageSort, userId: number | null): DemoCommunityImage[] {
  const newest = (a: DemoCommunityImage, b: DemoCommunityImage) => compareText(b.createdAt, a.createdAt) || compareText(b.id, a.id)
  return state.images
    .filter(image => image.purgedAt === null && (userId === null || (image.author.kind === 'resident' && image.author.user_id === userId)))
    .sort(sort === 'largest' ? (a, b) => b.size - a.size || newest(a, b) : newest)
}
