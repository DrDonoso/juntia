/**
 * Shared documents of Maple Court: what the residents and the administrator shared over the last
 * seven months. The scenario is a list of dated steps (who did what, when, with which file) that
 * ../store/shared-documents.ts replays through the operations of the API, so ids follow the dates
 * and every history entry matches the data: the house rules and their revised version, meeting
 * minutes filed by year (the latest moved into its folder), an insurance folder renamed by the
 * administrator with a claims log in two versions, a renamed scan, a Word letter, the visitor's
 * garden folder, and two deletions only the administrator sees. Deterministic
 * (`demoRandom('documents:…')`) and relative to today.
 */
import { addDays, daysAgo, parseDay } from '../core/clock'
import { demoPdf } from '../core/pdf'
import { demoRandom } from '../core/random'
import { zipArchive } from '../core/zip'
import { wallClock } from '../store/community-time'
import type { ScenarioFile, SharedDocumentChange, SharedDocumentStep } from '../store/shared-documents'
import { actor, at, type When, type Who } from './community-script'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const encoder = new TextEncoder()

/** `12 September 2026`. */
function longDate(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return `${date} ${MONTHS[month - 1]} ${year}`
}

function pdf(title: string, lines: readonly string[]): Uint8Array<ArrayBuffer> {
  return demoPdf(title, [...lines, '', 'Synthetic document generated for the Juntia demo.'])
}

function text(lines: readonly string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${lines.join('\n')}\n`)
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The smallest Word document (OOXML) that office suites open: one paragraph per line. */
function wordDocument(paragraphs: readonly string[], when: When): Uint8Array<ArrayBuffer> {
  const { year, month, day, hour, minute, second } = wallClock(Date.parse(at(when)))
  const modified = { year, month, day, hour, minute, second }
  const body = paragraphs.map(paragraph => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`).join('')
  const part = (path: string, xml: string) => ({ path, data: encoder.encode(XML + xml), modified })
  return zipArchive([
    part('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'),
    part('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>'),
    part('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
  ])
}

/** The Monday on or after a day. */
function nextMonday(day: string): string {
  return addDays(day, (8 - parseDay(day).getDay()) % 7)
}

const HOUSE_RULES = [
  '2. Rubbish: general waste in the evening; recycling on Tuesdays and Fridays.',
  '3. Bicycles and pushchairs are not left in the entrance hall or on the landings.',
  '4. Courtyard: no ball games after 21:00.',
  '5. Roof terrace: open from 09:00 to 22:00. Leave it as you found it.',
  '6. Pets are kept on a lead in the common areas.',
  '7. Works inside dwellings: weekdays from 09:00 to 19:00, announced on the noticeboard.',
  '8. Nothing is stored in the stairwells, the car park or the meter rooms.',
]

const ROTA = [
  ['Olivia Bennett', '2B'], ['Sofia Rossi', '1C'], ['Mohammed Haddad', '2A'], ['Amara Nwosu', '3C'],
  ['Lucas Moreau', '4B'], ['Priya Sharma', '1A'], ['Zara Ahmed', '4C'], ['Hiroshi Tanaka', '3B'],
] as const

const BIKE_SURVEY = [
  ['1A', 2, 0, 'yes'], ['1B', 1, 1, 'yes'], ['1C', 0, 0, 'no'], ['2A', 3, 1, 'yes'], ['2B', 1, 0, 'yes'],
  ['2C', 2, 2, 'yes'], ['3A', 0, 0, 'no'], ['3B', 1, 0, 'yes'], ['4A', 2, 1, 'yes'], ['4C', 1, 0, 'no'],
] as const

/** The steps of the scenario, in any order: the store replays them chronologically. */
export function sharedDocumentsScenario(): SharedDocumentStep[] {
  const random = demoRandom('documents:uploads')
  const file = (name: string, bytes: Uint8Array<ArrayBuffer>): ScenarioFile => ({ uploadId: random.uuid(), name, bytes })
  const step = (when: When, who: Who, change: SharedDocumentChange): SharedDocumentStep => ({ at: at(when), by: actor(who), ...change })
  const annualMeeting = daysAgo(350), ordinaryMeeting = daysAgo(40)
  const [annualYear, ordinaryYear] = [annualMeeting, ordinaryMeeting].map(day => day.slice(0, 4))
  const claims = [
    `${daysAgo(200)},Fourth-floor landing,Water stain on the ceiling after heavy rain,closed,620.00`,
    `${daysAgo(165)},Entrance hall,Cracked glass panel in the street door,closed,184.50`,
  ]
  const claimsHeader = 'date,area,description,status,amount_eur'
  const rotaStart = nextMonday(daysAgo(60))
  return [
    step([212, '09:00'], 'admin', {
      upload: 'welcome', file: file('Welcome to Documents.txt', text([
        'Welcome to the shared documents of Maple Court.', '',
        'Everyone in the community can read and download every file here, and add folders and files.',
        'You can rename, move, replace or delete what you uploaded yourself; the administration can tidy up anything.',
        'Deleted files are kept for a while: ask the administration if you deleted something by mistake.',
        'Please do not share personal data of other residents, such as phone numbers or bank details.',
      ])),
    }),
    step([210, '10:00'], 'admin', { createFolder: 'rules', name: 'Community rules' }),
    step([210, '10:06'], 'admin', {
      upload: 'house-rules', folder: 'rules', file: file('House rules.pdf', pdf('Maple Court - House rules', [
        `Approved at the annual general meeting of ${longDate(annualMeeting)}.`, '',
        '1. Quiet hours: from 22:00 to 08:00 on weekdays and from 23:00 to 09:00 at weekends.', ...HOUSE_RULES,
      ])),
    }),
    step([200, '18:00'], 1, { createFolder: 'minutes', name: 'Meeting minutes' }),
    step([200, '18:05'], 1, { createFolder: `minutes:${annualYear}`, name: annualYear, parent: 'minutes' }),
    step([200, '18:09'], 1, {
      upload: 'annual-minutes', folder: `minutes:${annualYear}`, file: file('Minutes - annual general meeting.pdf', pdf(
        'Maple Court - Minutes of the annual general meeting', [
          `Held on ${longDate(annualMeeting)} in the community room.`,
          'Chair: James Okafor (president). Dwellings present or represented: 10 of 12.', '',
          '1. Accounts of the past year: approved unanimously.',
          '2. Budget for the coming year: EUR 38,400.00. Approved (9 in favour, 1 abstention).',
          '3. Election of the president: James Okafor re-elected.',
          '4. House rules: the current text stays in force.',
          '5. Cleaning contract: renewed with the same company.', '',
          'The meeting closed at 21:05.',
        ],
      )),
    }),
    step([150, '20:30'], 9, { createFolder: 'insurance', name: 'Insurance papers' }),
    step([148, '09:15'], 'admin', { rename: 'insurance', name: 'Insurance' }),
    step([148, '09:20'], 'admin', {
      upload: 'policy', folder: 'insurance', file: file('Building insurance policy.pdf', pdf('Harbour Mutual - Building insurance policy', [
        "Policyholder: Maple Court residents' community", 'Policy number: HM-BLD-48213',
        'Period of cover: 12 months, renewed every year.', '',
        'Cover:', '- Buildings and common areas: rebuilding value EUR 4,200,000.00',
        '- Third-party liability: up to EUR 1,500,000.00', '- Water damage, including leak detection',
        '- Glass breakage in the common areas', '- Storm and fire', '',
        'Excess: EUR 300.00 per claim (water damage: EUR 600.00).', 'Claims line, 24 hours: +44 20 7946 0123',
      ])),
    }),
    step([146, '21:00'], 9, { upload: 'claims', folder: 'insurance', file: file('Claims log.csv', text([claimsHeader, ...claims])) }),
    step([120, '12:10'], 10, {
      upload: 'lift-contract', file: file('scan_0042.pdf', pdf('Citywide Lift Services - Maintenance contract', [
        "Client: Maple Court residents' community", 'Installation: passenger lift, 6 stops', '',
        'Service: a preventive visit every month and call-outs 24 hours a day.',
        'Response time: 2 hours with people trapped, otherwise the next working day.',
        'Price: EUR 145.00 per month plus VAT, reviewed every year.',
        'Duration: one year, renewed unless cancelled three months before.', '',
        'Signed for the community: James Okafor, president',
      ])),
    }),
    step([120, '12:14'], 10, { rename: 'lift-contract', name: 'Lift maintenance contract' }),
    step([90, '20:05'], 1, {
      upload: 'welcome-letter', folder: 'rules', file: file('Welcome letter for new residents.docx', wordDocument([
        'Welcome to Maple Court!',
        'We are glad you joined the building. A few things make life here easier:',
        'The house rules are in Documents, in the Community rules folder.',
        'Bins go out in the evening; recycling is collected on Tuesdays and Fridays.',
        'Keys for the mailbox and the bike room are with the president in 1A.',
        'Questions? Ask any of us, or write in Actions.',
        'James Okafor, president',
      ], [90, '20:05'])),
    }),
    step([70, '19:00'], 14, { createFolder: 'roof-claim', name: 'Roof claim photos', parent: 'insurance' }),
    step([70, '19:04'], 14, {
      upload: 'roof-claim:photos', folder: 'roof-claim', file: file('Ceiling damage photos.pdf', pdf('Ceiling damage for the insurance claim', [
        'Photos taken by Chloe Dubois (4A) for the claim with Harbour Mutual.', '',
        'Photo 1: water stain next to the skylight, about 60 x 40 cm.',
        'Photo 2: flaking plaster above the door of 4A.',
        'Photo 3: skylight frame seen from the landing.',
      ])),
    }),
    step([60, '17:30'], 6, { createFolder: 'garden', name: 'Garden' }),
    step([60, '17:42'], 6, {
      upload: 'watering', folder: 'garden', file: file('Watering rota.csv', text([
        'week_starting,resident,dwelling',
        ...ROTA.map(([name, dwelling], week) => `${addDays(rotaStart, week * 7)},${name},${dwelling}`),
      ])),
    }),
    ...(ordinaryYear === annualYear ? [] : [step([37, '21:12'], 1, { createFolder: `minutes:${ordinaryYear}`, name: ordinaryYear, parent: 'minutes' })]),
    step([37, '21:15'], 1, {
      upload: 'ordinary-minutes', folder: 'minutes', file: file('Minutes - ordinary meeting.pdf', pdf('Maple Court - Minutes of the ordinary meeting', [
        `Held on ${longDate(ordinaryMeeting)} in the community room.`,
        'Chair: James Okafor (president). Dwellings present or represented: 9 of 12.', '',
        '1. Revised house rules: quiet hours from 22:00 every day, and no charging of',
        '   scooters in the common areas. Approved (8 in favour, 1 against).',
        '2. Building insurance: renewed with Harbour Mutual.',
        '3. Bike storage in the basement: a survey of the bikes in each dwelling.',
        '4. Any other business: none.', '',
        'The meeting closed at 20:30.',
      ])),
    }),
    // Uploaded next to the year folders by mistake.
    step([37, '21:20'], 1, { move: 'ordinary-minutes', into: `minutes:${ordinaryYear}` }),
    step([36, '10:30'], 'admin', {
      newVersion: 'house-rules', file: file('House rules.pdf', pdf('Maple Court - House rules (revised)', [
        `Approved at the ordinary meeting of ${longDate(ordinaryMeeting)}.`, '',
        '1. Quiet hours: from 22:00 to 08:00 every day.', ...HOUSE_RULES,
        '9. Electric scooters and bikes are charged inside dwellings only.',
      ])),
    }),
    step([25, '22:10'], 8, {
      upload: 'parking-draft', file: file('Parking spaces - draft.pdf', pdf('Car park spaces - draft allocation', [
        'Draft prepared by Daniel Mensah (2C).', '',
        'Spaces 1 to 6: dwellings 1A to 2C.', 'Spaces 7 to 12: dwellings 3A to 4C.', 'Visitors: no space left.', '',
        'To be discussed before it is shared.',
      ])),
    }),
    step([24, '08:30'], 8, { remove: 'parking-draft' }),
    step([20, '18:40'], 9, {
      newVersion: 'claims', file: file('Claims log.csv', text([
        claimsHeader, ...claims, `${daysAgo(22)},Rear courtyard,Downpipe leaking onto the bin store,open,`,
      ])),
    }),
    step([12, '10:45'], 14, { remove: 'roof-claim' }),
    step([3, '18:25'], 13, {
      upload: 'bike-survey', file: file('Bike storage survey.csv', text([
        'dwelling,bikes,electric_bikes,interested',
        ...BIKE_SURVEY.map(row => row.join(',')),
      ])),
    }),
  ]
}
