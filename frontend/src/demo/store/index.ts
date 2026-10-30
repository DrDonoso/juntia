/**
 * All the demo's data stores. A page load starts every store from its scenario; tests start again
 * with {@link resetDemo}, which also pins the clock the scenarios are relative to.
 */
import { setClock } from '../core/clock'
import { resetCommunityStore } from './community'
import { resetCoreStore } from './core'
import { resetFinanceStore } from './finance'
import { resetPeopleStore } from './people'

export interface ResetOptions {
  /** Clock of the demo (default: the real time). */
  now?: () => Date
}

/** Starts the demo again from its scenario, as a page reload does. */
export function resetDemo({ now }: ResetOptions = {}): void {
  setClock(now)
  resetCoreStore()
  resetPeopleStore()
  resetFinanceStore()
  resetCommunityStore()
}
