/**
 * Prepares an image for the Markdown editors before it is uploaded: the picture is decoded with its
 * orientation applied, reduced to at most 2560 pixels a side and encoded again, which also leaves
 * out its metadata (camera, date, GPS position). GIFs are sent as they are, to keep animations.
 * The server only checks the format, the size and the dimensions of what it receives.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]
/** The server's limit for one image (`MAX_IMAGE_BYTES`). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_SIDE = 2560
/** Files are refused before decoding above this size: a phone photo takes a few MiB. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024
const JPEG_QUALITY = 0.85
const EXTENSIONS: Record<ImageType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
}

export type ImageProblem = 'type' | 'tooLarge' | 'unreadable'

export class ImagePreparationError extends Error {
  constructor(public problem: ImageProblem) {
    super(`The image could not be prepared (${problem})`)
    this.name = 'ImagePreparationError'
  }
}

export type PreparedImage = { blob: Blob; name: string }

export function isImageType(type: string): type is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(type)
}

/** The size that fits in MAX_IMAGE_SIDE, keeping the proportions. */
export function fittedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function renamed(name: string, type: string): string {
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'image'
  return `${stem}.${isImageType(type) ? EXTENSIONS[type] : 'png'}`
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob)
    else reject(new ImagePreparationError('unreadable'))
  }, type, JPEG_QUALITY))
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (error) {
    // Browsers that predate this option value reject it; their default also applies the orientation.
    if (error instanceof TypeError) return await createImageBitmap(file)
    throw error
  }
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isImageType(file.type)) throw new ImagePreparationError('type')
  if (file.size > MAX_SOURCE_BYTES) throw new ImagePreparationError('tooLarge')
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new ImagePreparationError('tooLarge')
    return { blob: file, name: file.name || 'image.gif' }
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await decode(file)
  } catch {
    throw new ImagePreparationError('unreadable')
  }
  try {
    const { width, height } = fittedSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new ImagePreparationError('unreadable')
    context.drawImage(bitmap, 0, 0, width, height)
    // PNG keeps transparency and sharp screenshots; a browser that cannot write WebP answers PNG.
    const blob = await encode(canvas, file.type === 'image/png' ? 'image/png' : file.type)
    if (blob.size > MAX_IMAGE_BYTES) throw new ImagePreparationError('tooLarge')
    return { blob, name: renamed(file.name, blob.type) }
  } finally {
    bitmap.close()
  }
}
