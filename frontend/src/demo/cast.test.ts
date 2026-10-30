import { describe, expect, test } from 'vitest'
import {
  ADMINISTRATOR_ACTOR_NAME, COMMUNITY, DWELLINGS, PRESIDENT_ID, RESIDENTS, SAMPLE_NEIGHBOR_ID, activeResidents, castDwelling,
  castResident, castResidentsOf,
} from './cast'

/** ISO 13616 check: the IBAN moved four characters left, letters as numbers, modulo 97 is 1. */
function validIban(iban: string): boolean {
  const rotated = iban.slice(4) + iban.slice(0, 4)
  const digits = [...rotated].map(character => /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character).join('')
  return BigInt(digits) % 97n === 1n
}

describe('the cast', () => {
  test('Maple Court has twelve dwellings whose ownership coefficients add up to exactly 100', () => {
    expect(COMMUNITY.name).toBe('Maple Court')
    expect(DWELLINGS).toHaveLength(12)
    expect(new Set(DWELLINGS.map(dwelling => dwelling.id)).size).toBe(12)
    expect(new Set(DWELLINGS.map(dwelling => dwelling.label)).size).toBe(12)
    for (const dwelling of DWELLINGS) expect(dwelling.coefficient).toMatch(/^\d{1,3}\.\d{2}$/)
    const cents = DWELLINGS.reduce((sum, dwelling) => sum + Math.round(Number(dwelling.coefficient) * 100), 0)
    expect(cents).toBe(10_000)
  })

  test('the bank account is a checksum-valid Spanish IBAN on the non-existent bank 9999', () => {
    expect(COMMUNITY.account.iban).toMatch(/^ES\d{2}9999\d{16}$/)
    expect(validIban(COMMUNITY.account.iban)).toBe(true)
  })

  test('neighbors have unique ids and emails, fictional contact data and real dwellings', () => {
    expect(RESIDENTS.length).toBeGreaterThanOrEqual(14)
    expect(new Set(RESIDENTS.map(resident => resident.id)).size).toBe(RESIDENTS.length)
    expect(new Set(RESIDENTS.map(resident => resident.email)).size).toBe(RESIDENTS.length)
    expect(new Set(RESIDENTS.map(resident => resident.name)).size).toBe(RESIDENTS.length)
    for (const resident of RESIDENTS) {
      expect(resident.email).toMatch(/^[a-z]+\.[a-z]+@example\.com$/)
      // Ofcom's drama range +44 20 7946 0000–0999, normalized like the API stores phones.
      expect(resident.phone).toMatch(/^(?:\+442079460\d{3})?$/)
      expect(() => castDwelling(resident.dwellingId)).not.toThrow()
    }
    const phones = RESIDENTS.map(resident => resident.phone).filter(Boolean)
    expect(new Set(phones).size).toBe(phones.length)
    expect(DWELLINGS.every(dwelling => castResidentsOf(dwelling.id).length > 0)).toBe(true)
  })

  test('mostly active neighbors, two pending invitations and one disabled account', () => {
    const byStatus = (status: string) => RESIDENTS.filter(resident => resident.status === status)
    expect(byStatus('pending')).toHaveLength(2)
    expect(byStatus('disabled')).toHaveLength(1)
    expect(activeResidents()).toHaveLength(RESIDENTS.length - 3)
    for (const resident of byStatus('pending')) {
      expect(resident.lastSignInDaysAgo).toBeNull()
      expect(resident.invitedDaysAgo).toBeGreaterThanOrEqual(0)
    }
    for (const resident of RESIDENTS.filter(item => item.status !== 'pending')) expect(resident.invitedDaysAgo).toBeNull()
  })

  test('the president and the sample neighbor are active neighbors', () => {
    expect(castResident(PRESIDENT_ID).status).toBe('active')
    expect(castResident(SAMPLE_NEIGHBOR_ID)).toMatchObject({ status: 'active', name: 'Olivia Bennett', email: 'olivia.bennett@example.com' })
    expect(PRESIDENT_ID).not.toBe(SAMPLE_NEIGHBOR_ID)
    expect(ADMINISTRATOR_ACTOR_NAME).toBe('Technical administrator')
    expect(() => castResident(999)).toThrow()
  })
})
