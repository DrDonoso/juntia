import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ImagePreparationError, MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, fittedSize, prepareImage } from './image-upload'

const MiB = 1024 * 1024
let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }
let decode: ReturnType<typeof vi.fn>
let drawImage: ReturnType<typeof vi.fn>
let canvasSize: { width: number; height: number } | null
let encoded: { type?: string; size?: number; quality?: unknown; requested?: string }

function file(name: string, type: string, size = 1000): File {
  const value = new File([new Uint8Array(Math.min(size, 1000))], name, { type })
  if (size > 1000) Object.defineProperty(value, 'size', { value: size })
  return value
}

async function problem(promise: Promise<unknown>) {
  const error = await promise.catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(ImagePreparationError)
  return (error as ImagePreparationError).problem
}

beforeEach(() => {
  bitmap = { width: 4000, height: 3000, close: vi.fn() }
  decode = vi.fn(async () => bitmap)
  drawImage = vi.fn()
  canvasSize = null
  encoded = {}
  vi.stubGlobal('createImageBitmap', decode)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvasSize = { width: this.width, height: this.height }
    return { drawImage } as never
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type, quality) => {
    encoded.requested = type
    encoded.quality = quality
    callback(new Blob([new Uint8Array(encoded.size ?? 200)], { type: encoded.type ?? type }))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('sizes are reduced to 2560 pixels a side without enlarging small pictures', () => {
  expect(fittedSize(4000, 3000)).toEqual({ width: 2560, height: 1920 })
  expect(fittedSize(1000, 5000)).toEqual({ width: 512, height: 2560 })
  expect(fittedSize(2560, 2560)).toEqual({ width: 2560, height: 2560 })
  expect(fittedSize(800, 600)).toEqual({ width: 800, height: 600 })
  expect(fittedSize(1, 20000)).toEqual({ width: 1, height: 2560 })
})

test('photos are decoded upright, reduced and encoded again, which drops their metadata', async () => {
  const photo = file('IMG_2041.JPEG', 'image/jpeg', 4 * MiB)
  const prepared = await prepareImage(photo)
  expect(decode).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' })
  expect(canvasSize).toEqual({ width: 2560, height: 1920 })
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2560, 1920)
  expect(encoded).toMatchObject({ requested: 'image/jpeg', quality: 0.85 })
  expect(prepared.blob.type).toBe('image/jpeg')
  expect(prepared.name).toBe('IMG_2041.jpg')
  expect(bitmap.close).toHaveBeenCalledOnce()
})

test('screenshots stay PNG at their size, and WebP falls back to PNG where the browser cannot write it', async () => {
  bitmap = { width: 800, height: 600, close: vi.fn() }
  expect(await prepareImage(file('image.png', 'image/png'))).toMatchObject({ name: 'image.png', blob: { type: 'image/png' } })
  expect(canvasSize).toEqual({ width: 800, height: 600 })
  expect(encoded.requested).toBe('image/png')
  expect(await prepareImage(file('plan.webp', 'image/webp'))).toMatchObject({ name: 'plan.webp', blob: { type: 'image/webp' } })
  encoded.type = 'image/png'
  expect(await prepareImage(file('plan.webp', 'image/webp'))).toMatchObject({ name: 'plan.png', blob: { type: 'image/png' } })
})

test('GIFs are sent as they are, to keep their animation', async () => {
  const animation = file('party.gif', 'image/gif', 3 * MiB)
  const prepared = await prepareImage(animation)
  expect(prepared).toEqual({ blob: animation, name: 'party.gif' })
  expect(decode).not.toHaveBeenCalled()
  expect(await problem(prepareImage(file('huge.gif', 'image/gif', MAX_IMAGE_BYTES + 1)))).toBe('tooLarge')
})

test('browsers that do not know the orientation option decode with their default', async () => {
  decode.mockRejectedValueOnce(new TypeError("The provided value 'from-image' is not a valid enum value"))
  const photo = file('photo.jpg', 'image/jpeg')
  expect(await prepareImage(photo)).toMatchObject({ name: 'photo.jpg', blob: { type: 'image/jpeg' } })
  expect(decode.mock.calls).toEqual([[photo, { imageOrientation: 'from-image' }], [photo]])
})

test('other formats, oversized sources and unreadable pictures are refused before uploading', async () => {
  for (const type of ['image/heic', 'image/svg+xml', 'application/pdf', '']) {
    expect(await problem(prepareImage(file('file', type))), type).toBe('type')
  }
  expect(await problem(prepareImage(file('raw.jpg', 'image/jpeg', MAX_SOURCE_BYTES + 1)))).toBe('tooLarge')
  expect(decode).not.toHaveBeenCalled()
  decode.mockRejectedValueOnce(new DOMException('The source image could not be decoded.', 'InvalidStateError'))
  expect(await problem(prepareImage(file('broken.jpg', 'image/jpeg')))).toBe('unreadable')
  expect(decode).toHaveBeenCalledTimes(1)
  encoded.size = MAX_IMAGE_BYTES + 1
  expect(await problem(prepareImage(file('noise.png', 'image/png')))).toBe('tooLarge')
  expect(bitmap.close).toHaveBeenCalledOnce()
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
  expect(await problem(prepareImage(file('photo.jpg', 'image/jpeg')))).toBe('unreadable')
  expect(bitmap.close).toHaveBeenCalledTimes(2)
})
