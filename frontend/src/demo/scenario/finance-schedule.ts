/**
 * What happened in Maple Court's bank account: thirteen months of movements up to today, from the
 * first day of the month a year before the last imported statement. Each month the twelve
 * dwellings pay their fees (€3,600 a month split by ownership coefficient, mostly by direct debit),
 * the roof antenna's lease comes in, and the community pays electricity, lift maintenance, garden
 * care, the lift alarm line, the portal's hosting, cleaning and bank fees; every quarter water, the
 * property manager, pest control and the garage door service; once a year insurance, taxes and
 * inspections. A roof repair was paid with a special assessment collected in five instalments, a
 * few repairs came up, 3C paid late twice, 4C missed a month, and a few movements are still
 * uncategorized.
 *
 * Amounts come from seeded streams with one draw per month (`demoRandom('finance:…')`), so they are
 * the same on every visit; only the calendar follows today. Bank days skip weekends.
 */
import { DWELLINGS, castResidentsOf, type CastDwelling } from '../cast'
import { addDays, addMonths, endOfMonth, parseDay, startOfMonth } from '../core/clock'
import { demoRandom, type Random } from '../core/random'
import { compareText } from '../store/finance-ledger'

/** Category ids of the backend's first-run seed (bootstrap.py order). */
export const CATEGORY = {
  regularFees: 1, specialAssessments: 2, water: 3, electricity: 4, cleaning: 5, maintenance: 6, repairs: 7,
  administration: 8, insurance: 9, professionalServices: 10, taxes: 11, bankFees: 12, other: 13,
} as const

/** Tag ids of the backend's first-run seed. */
export const TAG = { recurring: 1, extraordinary: 2, refund: 3, transfer: 4, directDebit: 5, review: 6 } as const

/** How a movement got its category, merchant and tags. */
export type MovementClass =
  | { readonly kind: 'rule' }
  | { readonly kind: 'manual'; readonly categoryId: number | null; readonly merchant: string; readonly tags: readonly number[] }
  | { readonly kind: 'unclassified' }

export interface Movement {
  bookingDate: string
  valueDate: string
  description: string
  /** Signed cents. */
  amount: number
  /** Minutes after midnight: orders the movements of one day. */
  minute: number
  classification: MovementClass
}

export interface BankMovement extends Movement {
  /** Cents in the account after the movement. */
  balance: number
}

export interface BankTimeline {
  /** Every movement up to today, oldest first. */
  movements: BankMovement[]
  /** Balance before the first movement (cents). */
  openingBalance: number
  /** First day of the oldest statement's month. */
  firstMonth: string
  /** Last day the imported statements cover: later movements wait in the bank's next statement. */
  recordedUntil: string
}

/** Days between the last imported statement and today. */
export const IMPORT_LAG_DAYS = 3

/** Monthly fees of the whole building and each roof assessment instalment, in cents. */
export const MONTHLY_BUDGET = 360_000
export const ROOF_INSTALMENT = 240_000
const OPENING_BALANCE = 984_627

const RULE: MovementClass = { kind: 'rule' }
const UNCLASSIFIED: MovementClass = { kind: 'unclassified' }
const manual = (categoryId: number | null, merchant: string, ...tags: number[]): MovementClass => ({ kind: 'manual', categoryId, merchant, tags })

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
/** Common-area electricity through the year (winter lighting and heating of the lift room). */
const ELECTRICITY_SEASON = [1.32, 1.25, 1.08, 0.94, 0.86, 0.9, 1, 1.02, 0.9, 0.98, 1.15, 1.3]
/** Garden care invoices by season, VAT included. */
const GARDEN_SEASON = [21_780, 21_780, 29_040, 29_040, 29_040, 27_830, 27_830, 27_830, 24_200, 24_200, 24_200, 21_780]

/** How each dwelling pays: most by the community's direct debit on the 2nd, four by transfer. */
const TRANSFER_DAYS: Readonly<Record<string, number>> = { '1B': 4, '2A': 3, '3C': 6, '4A': 1 }
/** Months (relative to the last imported one) when 3C paid late, and the day it did. */
const LATE_PAYMENTS: Readonly<Record<number, number>> = { [-9]: 19, [-4]: 24 }
/** 4C missed this month's direct debit and paid it by transfer the next month. */
const MISSED_MONTH = -2
/** The roof assessment's five instalments, collected in these months. */
const ROOF_MONTHS = [-7, -6, -5, -4, -3]

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

function isWeekend(day: string): boolean {
  const weekday = parseDay(day).getDay()
  return weekday === 0 || weekday === 6
}

/** The bank books what happens on a weekend on the next Monday. */
export function businessDay(day: string): string {
  let result = day
  while (isWeekend(result)) result = addDays(result, 1)
  return result
}

/** The last bank day on or before `day`. */
export function previousBusinessDay(day: string): string {
  let result = day
  while (isWeekend(result)) result = addDays(result, -1)
  return result
}

/** Day `dayOfMonth` of a month, clamped to its length. */
function dayOf(month: string, dayOfMonth: number): string {
  const last = Number(endOfMonth(month).slice(8))
  return `${month.slice(0, 8)}${pad(Math.min(dayOfMonth, last))}`
}

/** `OCT 26`. */
export function monthLabel(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(2, 4)}`
}

/** A neighbor's name as banks print it: `OKAFOR JAMES`. */
function bankName(name: string): string {
  const words = name.toUpperCase().split(' ')
  return [...words.slice(-1), ...words.slice(0, -1)].join(' ')
}

/** Who pays for a dwelling: its first neighbor. */
function payer(dwelling: CastDwelling): string {
  const resident = castResidentsOf(dwelling.id)[0]
  if (!resident) throw new Error(`Dwelling ${dwelling.label} has no neighbor`)
  return bankName(resident.name)
}

/** A dwelling's share of an amount (cents), by its ownership coefficient. */
export function share(dwelling: CastDwelling, total: number): number {
  const [units, hundredths = '0'] = dwelling.coefficient.split('.')
  return Math.round(total * (Number(units) * 100 + Number(hundredths.padEnd(2, '0'))) / 10_000)
}

interface Streams {
  electricity: Random
  water: Random
  references: Random
}

/** Collects the movements of one month. */
class MonthBook {
  readonly movements: Movement[] = []

  constructor(readonly month: string) {}

  /** Money received by direct debit (the community collects it on the nominal day). */
  collected(day: number, description: string, amount: number, minute: number, classification: MovementClass): void {
    const date = businessDay(dayOf(this.month, day))
    this.movements.push({ bookingDate: date, valueDate: date, description, amount, minute, classification })
  }

  /** A transfer received: a weekend one is booked on Monday with the day it was sent as value date. */
  received(day: number, description: string, amount: number, minute: number, classification: MovementClass): void {
    const sent = dayOf(this.month, day)
    this.movements.push({ bookingDate: businessDay(sent), valueDate: sent, description, amount, minute, classification })
  }

  /** A bill paid by direct debit, or a transfer sent. */
  paid(day: number, description: string, amount: number, minute: number, classification: MovementClass): void {
    const date = businessDay(dayOf(this.month, day))
    this.movements.push({ bookingDate: date, valueDate: date, description, amount: -amount, minute, classification })
  }

  /** A card payment: booked the next bank day, valued the day of the purchase. */
  card(day: number, description: string, amount: number, classification: MovementClass): void {
    const purchase = dayOf(this.month, day)
    this.movements.push({ bookingDate: businessDay(addDays(purchase, 1)), valueDate: purchase, description, amount: -amount, minute: 960, classification })
  }

  /** A bank fee: valued on the last day of the month even when it is booked on the next bank day. */
  charged(description: string, amount: number, minute: number): void {
    const last = endOfMonth(this.month)
    this.movements.push({ bookingDate: businessDay(last), valueDate: last, description, amount: -amount, minute, classification: RULE })
  }

  /** Transfers sent this month (the bank charges for each one). */
  get transfersSent(): number {
    return this.movements.filter(movement => movement.description.startsWith('TRANSFER TO ')).length
  }
}

/** The fees (and roof instalments) of each dwelling in a month. */
function dwellingPayments(book: MonthBook, offset: number, current: boolean): void {
  const label = monthLabel(book.month)
  const instalment = ROOF_MONTHS.indexOf(offset) + 1
  for (const dwelling of DWELLINGS) {
    const name = payer(dwelling)
    const fee = share(dwelling, MONTHLY_BUDGET)
    const transferDay = TRANSFER_DAYS[dwelling.label]
    // 1B always pays by hand: this month's transfer arrives in the bank's next statement.
    const pending = current && dwelling.label === '1B'
    if (transferDay !== undefined && !pending) {
      const day = dwelling.label === '3C' ? LATE_PAYMENTS[offset] ?? transferDay : transferDay
      book.received(day, `TRANSFER FROM ${name} MONTHLY FEE ${dwelling.label} ${label}`, fee, 600 + dwelling.id * 5, RULE)
    } else if (transferDay === undefined && !(dwelling.label === '4C' && offset === MISSED_MONTH)) {
      book.collected(2, `DIRECT DEBIT COLLECTED MONTHLY FEE ${dwelling.label} ${label} ${name}`, fee, 360 + dwelling.id, RULE)
    }
    if (dwelling.label === '4C' && offset === MISSED_MONTH + 1) {
      const missed = monthLabel(addMonths(book.month, -1))
      book.received(12, `TRANSFER FROM ${name} MONTHLY FEE 4C ${missed}`, fee, 690, RULE)
    }
    if (instalment > 0) {
      const amount = share(dwelling, ROOF_INSTALMENT)
      if (transferDay === undefined) {
        book.collected(12, `DIRECT DEBIT COLLECTED ROOF ASSESSMENT ${instalment}/5 ${dwelling.label} ${name}`, amount, 380 + dwelling.id, RULE)
      } else {
        book.received(transferDay + 9, `TRANSFER FROM ${name} ROOF ASSESSMENT ${instalment}/5 ${dwelling.label}`, amount, 610 + dwelling.id * 5, RULE)
      }
    }
  }
}

/** Bills and services that come back every month or quarter. */
function recurringPayments(book: MonthBook, offset: number, streams: Streams): void {
  const date = parseDay(book.month)
  const calendarMonth = date.getMonth() + 1
  const year = date.getFullYear()
  const yy = pad(year % 100), mm = pad(calendarMonth)
  const label = monthLabel(book.month)
  const reference = pad(streams.references.between(100, 9999), 4)
  const electricity = Math.round(52_000 * ELECTRICITY_SEASON[calendarMonth - 1] * streams.electricity.uniform(0.96, 1.04))
  const water = Math.round(69_000 * streams.water.uniform(0.9, 1.1))

  book.received(5, `TRANSFER FROM SKYMAST NETWORKS ANTENNA LEASE ${label}`, 25_000, 700,
    manual(CATEGORY.other, 'Skymast Networks', TAG.recurring, TAG.transfer))
  book.paid(5, `DIRECT DEBIT LIFTWELL MAINTENANCE CONTRACT LW-7712 ${label}`, 24_684, 420, RULE)
  book.paid(9, `DIRECT DEBIT LUMENVALE ENERGY INV LE${yy}${mm}${reference} COMMON AREAS`, electricity, 425, RULE)
  book.paid(20, `TRANSFER TO GREENLEAF GARDENS INV GG-${yy}${mm}`, GARDEN_SEASON[calendarMonth - 1], 800, RULE)
  book.paid(23, `DIRECT DEBIT RINGWISE TELECOM LIFT ALARM LINE ${label}`, 1_815, 430,
    manual(CATEGORY.maintenance, 'Ringwise Telecom', TAG.recurring, TAG.directDebit))
  book.card(24, 'CARD PAYMENT CLOUDNEST HOSTING JUNTIA PORTAL', 605, manual(CATEGORY.administration, 'Cloudnest Hosting', TAG.recurring))
  // The cleaning company's new rate started half a year ago.
  book.paid(27, `TRANSFER TO SPARKLE CLEANING CO INV SC-${yy}${mm}`, offset < -6 ? 94_380 : 96_800, 810, RULE)
  if (calendarMonth % 3 === 1) {
    const quarter = (calendarMonth + 2) / 3
    const previous = quarter === 1 ? { quarter: 4, year: year - 1 } : { quarter: quarter - 1, year }
    book.paid(10, `TRANSFER TO NORTHGATE PROPERTY MGMT Q${quarter} ${year} FEES INV NPM-${yy}${quarter}`, 121_000, 820,
      manual(CATEGORY.administration, 'Northgate Property Management', TAG.recurring, TAG.transfer))
    book.paid(14, `DIRECT DEBIT BRIGHTWATER UTILITIES Q${previous.quarter} ${previous.year} METER 0038812`, water, 435, RULE)
  }
  if (calendarMonth % 3 === 2) {
    book.paid(18, `TRANSFER TO SHIELDLINE PEST CONTROL INV SP-${yy}${mm} QUARTERLY TREATMENT`, 9_680, 830,
      manual(CATEGORY.maintenance, 'Shieldline Pest Control', TAG.recurring, TAG.transfer))
  }
  if (calendarMonth % 3 === 0) {
    book.paid(16, `TRANSFER TO DOORLINE AUTOMATICS GARAGE DOOR SERVICE INV DA-${yy}${mm}`, 14_520, 835,
      manual(CATEGORY.maintenance, 'Doorline Automatics', TAG.recurring, TAG.transfer))
  }
}

/** Yearly bills, the roof repair, repairs, refunds and the movements nobody classified yet. */
function occasionalMovements(book: MonthBook, offset: number): void {
  const year = book.month.slice(0, 4)
  switch (offset) {
    case -11:
      book.paid(17, 'TRANSFER TO SWIFTFLOW PLUMBING INV 2219 GARAGE LEAK', 14_520, 840, manual(CATEGORY.repairs, 'Swiftflow Plumbing', TAG.transfer))
      break
    case -10:
      book.card(6, 'CARD PAYMENT KEYFOLD LOCKSMITHS GARAGE KEYS', 8_500, manual(CATEGORY.repairs, 'Keyfold Locksmiths'))
      book.paid(13, 'TRANSFER TO BRIGHTWIRE ELECTRICAL INV BW-118 INTERCOM REPAIR', 118_000, 840,
        manual(CATEGORY.repairs, 'Brightwire Electrical', TAG.extraordinary, TAG.transfer))
      book.paid(22, `TRANSFER TO EMBERGUARD FIRE SAFETY EXTINGUISHER CHECK ${year}`, 24_200, 845,
        manual(CATEGORY.maintenance, 'Emberguard Fire Safety', TAG.transfer))
      break
    case -9:
      book.paid(26, 'TRANSFER TO HOLLIS GRANT ACCOUNTANTS ANNUAL ACCOUNTS REVIEW', 45_000, 840,
        manual(CATEGORY.professionalServices, 'Hollis & Grant Accountants', TAG.transfer))
      break
    case -8:
      book.received(11, 'TRANSFER RECEIVED REF 4471-0098', 5_000, 650, manual(null, '', TAG.review))
      // The lift maintenance rule matched this repair; the administrator reclassified it by hand.
      book.paid(24, 'TRANSFER TO LIFTWELL MAINTENANCE INV LW-4471 DOOR SENSOR', 36_890, 840,
        manual(CATEGORY.repairs, 'Liftwell Maintenance', TAG.transfer))
      break
    case -7:
      book.paid(3, 'DIRECT DEBIT HARBOR MUTUAL INSURANCE POLICY HM-558201 ANNUAL PREMIUM', 238_640, 440,
        manual(CATEGORY.insurance, 'Harbor Mutual Insurance', TAG.recurring, TAG.directDebit))
      book.received(21, 'REFUND LUMENVALE ENERGY BILLING ADJUSTMENT LE-0388', 4_682, 660,
        manual(CATEGORY.electricity, 'Lumenvale Energy', TAG.refund))
      break
    case -6:
      book.paid(12, 'TRANSFER TO ASHCOMBE BUILDING SURVEYS INSPECTION REPORT', 133_100, 840,
        manual(CATEGORY.professionalServices, 'Ashcombe Building Surveys', TAG.extraordinary, TAG.transfer))
      book.paid(15, `DIRECT DEBIT CITY COUNCIL DRIVEWAY ACCESS FEE ${year}`, 31_240, 445, manual(CATEGORY.taxes, 'City Council', TAG.directDebit))
      book.received(27, 'CASH DEPOSIT BRANCH 0231', 18_000, 670, UNCLASSIFIED)
      break
    case -5:
      book.paid(19, 'TRANSFER TO SLATECREST ROOFING LTD ROOF REPAIR DEPOSIT 40% INV SR-2291', 484_000, 840,
        manual(CATEGORY.repairs, 'Slatecrest Roofing Ltd.', TAG.extraordinary, TAG.transfer))
      break
    case -4:
      book.paid(9, 'TRANSFER TO SWIFTFLOW PLUMBING INV 2287 DOWNPIPE REPAIR', 21_175, 840, manual(CATEGORY.repairs, 'Swiftflow Plumbing', TAG.transfer))
      book.paid(14, 'TRANSFER TO LINDEN COMMUNITY HALL AGM ROOM HIRE', 9_000, 845, manual(CATEGORY.other, 'Linden Community Hall', TAG.transfer))
      break
    case -3:
      book.received(22, `TRANSFER FROM HARBOR MUTUAL INSURANCE CLAIM HM-${year}-0418 SETTLEMENT`, 64_000, 660,
        manual(CATEGORY.insurance, 'Harbor Mutual Insurance', TAG.refund))
      book.paid(23, 'TRANSFER TO KEYFOLD LOCKSMITHS INV KL-0907 MAIN DOOR LOCK', 15_840, 840, manual(CATEGORY.repairs, 'Keyfold Locksmiths', TAG.transfer))
      break
    case -2:
      book.paid(8, 'TRANSFER TO SLATECREST ROOFING LTD ROOF REPAIR FINAL PAYMENT INV SR-2318', 726_000, 840,
        manual(CATEGORY.repairs, 'Slatecrest Roofing Ltd.', TAG.extraordinary, TAG.transfer))
      book.card(17, 'CARD PAYMENT HARTLEY HARDWARE 0412', 3_785, UNCLASSIFIED)
      break
    case -1:
      book.paid(6, 'TRANSFER TO OKAFOR JAMES EXPENSES REIMBURSEMENT', 6_430, 845, manual(null, '', TAG.review))
      book.card(21, 'CARD PAYMENT SWIFTFLOW PLUMBING CALL-OUT', 9_680, manual(CATEGORY.repairs, 'Swiftflow Plumbing'))
      break
    case 0:
      book.paid(3, 'DIRECT DEBIT LINDEN COMMUNITY HALL BOOKING 2291', 12_000, 450, UNCLASSIFIED)
      break
  }
}

/** The bank's monthly fees: account maintenance and €0.45 for each transfer sent. */
function bankFees(book: MonthBook): void {
  const label = monthLabel(book.month)
  const transfers = book.transfersSent
  book.charged(`ACCOUNT MAINTENANCE FEE ${label}`, 1_200, 1_380)
  if (transfers > 0) book.charged(`TRANSFER FEES ${label} ${transfers} TRANSFERS`, 45 * transfers, 1_385)
}

/**
 * Movements of the last days that the latest imported statement does not include yet: 1B's fee,
 * paid by hand, a plumber's invoice and a small card payment nobody has classified.
 */
function latestMovements(today: string): Movement[] {
  const day = previousBusinessDay(today)
  const fee = DWELLINGS.find(dwelling => dwelling.label === '1B')!
  return [
    { bookingDate: day, valueDate: day, description: `TRANSFER FROM ${payer(fee)} MONTHLY FEE 1B ${monthLabel(today)}`,
      amount: share(fee, MONTHLY_BUDGET), minute: 640, classification: RULE },
    { bookingDate: day, valueDate: day, description: 'TRANSFER TO SWIFTFLOW PLUMBING INV 2341 BOILER ROOM VALVE', amount: -13_255, minute: 850, classification: UNCLASSIFIED },
    { bookingDate: day, valueDate: addDays(day, -1), description: 'CARD PAYMENT HARTLEY HARDWARE 0731', amount: -2_340, minute: 965, classification: UNCLASSIFIED },
  ]
}

/** Every movement of the account up to `today`, oldest first, with the balance after each one. */
export function bankTimeline(today: string): BankTimeline {
  const recordedUntil = addDays(today, -IMPORT_LAG_DAYS)
  const latestMonth = startOfMonth(recordedUntil)
  const firstMonth = addMonths(latestMonth, -12)
  const currentMonth = startOfMonth(today)
  const streams: Streams = {
    electricity: demoRandom('finance:electricity'),
    water: demoRandom('finance:water'),
    references: demoRandom('finance:references'),
  }
  const movements: Movement[] = []
  for (let month = firstMonth, offset = -12; month <= currentMonth; month = addMonths(month, 1), offset += 1) {
    const book = new MonthBook(month)
    dwellingPayments(book, offset, month === currentMonth)
    recurringPayments(book, offset, streams)
    occasionalMovements(book, offset)
    bankFees(book)
    movements.push(...book.movements)
  }
  movements.push(...latestMovements(today))
  const happened = movements
    .map((movement, index) => ({ movement, index }))
    .filter(({ movement }) => movement.bookingDate <= today)
    .sort((left, right) => compareText(left.movement.bookingDate, right.movement.bookingDate)
      || left.movement.minute - right.movement.minute || left.index - right.index)
  let balance = OPENING_BALANCE
  return {
    movements: happened.map(({ movement }) => {
      balance += movement.amount
      return { ...movement, balance }
    }),
    openingBalance: OPENING_BALANCE,
    firstMonth,
    recordedUntil,
  }
}
