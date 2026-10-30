/**
 * Auto-increment ids, like the backend's tables (SQLite `AUTOINCREMENT`, PostgreSQL identities): an
 * id is never handed out twice, even after its record is deleted.
 */
export class IdSequence {
  private last: number

  constructor(last = 0) {
    this.last = last
  }

  /** The next free id. */
  next(): number {
    this.last += 1
    return this.last
  }

  /** Keeps the sequence after `id` (records written by the scenario with explicit ids). */
  observe(id: number): void {
    if (id > this.last) this.last = id
  }

  /** The last id handed out or observed (0 if none). */
  get current(): number {
    return this.last
  }
}

/** Sequence that continues after the largest of `ids`. */
export function sequenceAfter(ids: Iterable<number>): IdSequence {
  const sequence = new IdSequence()
  for (const id of ids) sequence.observe(id)
  return sequence
}
