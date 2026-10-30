/**
 * The finance data of this page load (../scenario/finance.ts): transactions, imported statements,
 * previews under review, categories, tags and rules. Its shape and shared rules live in
 * ./finance-ledger.ts and ./finance-rules.ts.
 */
import { financeScenario, type FinanceScenario } from '../scenario/finance'

export type FinanceState = FinanceScenario

let state: FinanceState | null = null

/** The finance data of this page load, built from the scenario on first use. */
export function financeStore(): FinanceState {
  return (state ??= financeScenario())
}

/** Back to the scenario (tests; a page reload does the same). */
export function resetFinanceStore(): void {
  state = null
}
