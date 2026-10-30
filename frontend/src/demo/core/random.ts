import { DEMO_SEED } from '../config'

/** Seeded pseudo-random numbers (mulberry32): the demo data is the same on every visit. */
export class Random {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** Uniform float in [0, 1). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform float in [low, high). */
  uniform(low: number, high: number): number {
    return low + (high - low) * this.random()
  }

  /** Integer in [0, stop). */
  below(stop: number): number {
    return Math.floor(this.random() * stop)
  }

  /** Integer in [low, high], both included. */
  between(low: number, high: number): number {
    return low + this.below(high - low + 1)
  }

  /** True with the given probability (0–1). */
  chance(probability: number): boolean {
    return this.random() < probability
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Random.choice needs at least one item')
    return items[this.below(items.length)]
  }

  /** New array with the items in random order (Fisher–Yates). */
  shuffled<T>(items: readonly T[]): T[] {
    const result = [...items]
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.below(index + 1)
      ;[result[index], result[other]] = [result[other], result[index]]
    }
    return result
  }

  /** Random UUID in the version 4 layout (attachment, statement and preview ids). */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.below(16).toString(16)).join('')
    const variant = (8 + this.below(4)).toString(16)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

/** 32-bit FNV-1a hash of a text. */
export function hashText(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Independent random stream for one part of the demo (`'finance'`, `'community:actions'`…): each
 * label gets its own sequence, so adding data to one domain never changes another one.
 */
export function demoRandom(label: string): Random {
  return new Random(hashText(`${DEMO_SEED}:${label}`))
}
