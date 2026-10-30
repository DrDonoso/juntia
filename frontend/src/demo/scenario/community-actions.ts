/**
 * Community actions of Maple Court: nineteen works and proposals spread over every status of the
 * board, with labels, discussions (some comments edited, one withdrawn), PDFs (one renamed, three
 * withdrawn by different authors: the storage page's candidates for a purge) and the history all of
 * it leaves. Dates go back about eight months.
 */
import { demoPdf } from '../core/pdf'
import { isoDay } from '../core/clock'
import { demoRandom } from '../core/random'
import { addAttachment, addComment, createAction, editAction, editComment, editLabel, findLabelByName, renameAttachment, withdrawAttachment, withdrawComment, type ActionEdit } from '../store/community-actions'
import type { ActionStatus, CommunityState } from '../store/community-model'
import { sha256Hex } from '../store/community-sha256'
import { DOCUMENTS, type PdfDocument } from './community-documents'
import { actor, ref, step, type ScenarioRefs, type ScenarioStep, type When, type Who } from './community-script'

/** Labels the administrator had already coloured (each at version 2); "Common areas" appears with its first action. */
const COLOURED_LABELS: readonly (readonly [string, string])[] = [
  ['Accessibility', '#cf7ffd'], ['Energy', '#c6c102'], ['Garden', '#2bccb4'], ['Lift', '#4963de'],
  ['Painting', '#e65909'], ['Plumbing', '#47a4b4'], ['Roof', '#bd9670'], ['Security', '#d77089'],
]

type Change =
  | { status: ActionStatus }
  | { edit: ActionEdit }
  | { comment: string; key?: string }
  | { editComment: string; body: string }
  | { withdrawComment: string }
  | { attach: PdfDocument; key?: string }
  | { rename: string; filename: string }
  | { withdraw: string }

type ActionStep = { at: When; by: Who } & Change

interface ActionScript {
  key: string
  at: When
  by: Who
  title: string
  description: string
  labels: readonly string[]
  steps: readonly ActionStep[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `12 September 2026`: the day a document was attached, in the visitor's calendar. */
function longDate(instant: string): string {
  const [year, month, day] = isoDay(new Date(instant)).split('-').map(Number)
  return `${day} ${MONTHS[month - 1]} ${year}`
}

export function printDocument(document: PdfDocument, instant: string): Uint8Array<ArrayBuffer> {
  return demoPdf(document.title, [`Date: ${longDate(instant)}`, '', ...document.lines, '', 'Synthetic document generated for the Juntia demo.'])
}

const SCRIPTS: readonly ActionScript[] = [
  {
    key: 'mailboxes', at: [236, '20:14'], by: 12, labels: ['Security', 'Common areas'],
    title: 'Replace the mailboxes in the entrance hall',
    description: 'Several mailbox doors no longer close and the locks of 2B and 3C are broken, so letters have gone missing twice this month.\n\nProposal: replace the whole block with twelve new mailboxes with individual locks, printed name plates and a parcel slot.',
    steps: [
      { at: [233, '09:40'], by: 1, comment: "I've asked Keystone Locksmiths for a quote. The current mailboxes are the originals from when the building was finished.", key: 'mailboxes:quote-asked' },
      { at: [233, '09:52'], by: 1, editComment: 'mailboxes:quote-asked', body: "I've asked Keystone Locksmiths for a quote. The current mailboxes are the originals from when the building was finished, so spare locks are impossible to find." },
      { at: [228, '18:05'], by: 'admin', status: 'quoting' },
      { at: [220, '11:20'], by: 1, attach: DOCUMENTS.mailboxQuote },
      { at: [219, '12:02'], by: 4, comment: 'The model with the parcel slot looks great. Could the name plates be printed rather than handwritten?' },
      { at: [218, '08:47'], by: 1, comment: 'Yes, printed name plates are included in the quote.' },
      { at: [212, '19:30'], by: 1, status: 'voting' },
      { at: [205, '21:10'], by: 'admin', status: 'approved' },
      { at: [205, '21:12'], by: 'admin', comment: "Approved at the residents' meeting: 9 votes in favour and 1 abstention." },
      { at: [199, '10:00'], by: 'admin', status: 'ordered' },
      { at: [184, '16:45'], by: 12, status: 'done' },
      { at: [184, '16:47'], by: 12, comment: 'Installed today! The new keys are with the president: please collect yours from 1A.' },
      { at: [183, '13:00'], by: 1, attach: DOCUMENTS.mailboxInvoice },
    ],
  },
  {
    key: 'cctv', at: [171, '22:03'], by: 8, labels: ['Security'],
    title: 'CCTV camera at the car park entrance',
    description: "After the two bicycle thefts in the car park, I'd like us to consider a camera covering the entrance ramp. It would only record the entrance, never the parking spaces or the doors of the storage rooms.",
    steps: [
      { at: [170, '08:12'], by: 11, comment: "I'd rather not be recorded every time I go in or out. Better lighting and a gate that closes properly might be enough." },
      { at: [169, '19:55'], by: 9, comment: "Recording common areas comes with legal duties: warning signs, someone responsible for the footage and a short retention period. Let's check that before spending money." },
      { at: [165, '11:31'], by: 'admin', status: 'quoting' },
      { at: [160, '09:10'], by: 8, comment: 'The quote is lower than I expected: EUR 380 per camera, installed.', key: 'cctv:price' },
      { at: [160, '09:12'], by: 8, attach: DOCUMENTS.cctvMixup, key: 'cctv:mixup' },
      { at: [159, '09:25'], by: 8, withdrawComment: 'cctv:price' },
      { at: [159, '09:26'], by: 8, withdraw: 'cctv:mixup' },
      { at: [158, '17:20'], by: 8, attach: DOCUMENTS.cctvQuote },
      { at: [158, '17:24'], by: 8, comment: 'Sorry, I mixed up two quotes. The right one is attached: about EUR 1,180 for two cameras and the recorder.' },
      { at: [151, '19:40'], by: 1, status: 'voting' },
      { at: [151, '19:42'], by: 1, comment: 'On the agenda of the next meeting, together with the alternative of a new gate closer.' },
      { at: [142, '21:30'], by: 'admin', status: 'discarded' },
      { at: [142, '21:32'], by: 'admin', comment: "Rejected at the residents' meeting (4 in favour, 7 against). The car park gate closer will be replaced instead." },
    ],
  },
  {
    key: 'led', at: [150, '21:12'], by: 10, labels: ['Energy'],
    title: 'LED lighting and motion sensors in the stairwells',
    description: 'The stairwell lights are old fluorescent tubes on a timer that switches off before you reach the fourth floor. LED panels with a motion sensor on each landing would use far less electricity and be safer at night.',
    steps: [
      { at: [148, '10:05'], by: 13, comment: "Agreed. The timer only gives 40 seconds, which isn't enough with shopping bags." },
      { at: [140, '18:30'], by: 'admin', status: 'quoting' },
      { at: [133, '12:15'], by: 'admin', attach: DOCUMENTS.ledQuote },
      { at: [132, '16:40'], by: 'admin', attach: DOCUMENTS.ledAlternative },
      { at: [126, '20:00'], by: 1, status: 'voting' },
      { at: [119, '21:40'], by: 'admin', status: 'approved' },
      { at: [119, '21:42'], by: 'admin', comment: 'Approved: Bright Spark Electrical, EUR 3,480 including VAT.' },
      { at: [112, '09:30'], by: 'admin', status: 'ordered' },
      { at: [104, '08:30'], by: 'admin', status: 'in_progress' },
      { at: [102, '17:10'], by: 10, status: 'done' },
      { at: [102, '17:12'], by: 10, comment: 'All the landings are done and the sensors work well. The electricity bill should drop from next quarter.' },
      { at: [101, '11:00'], by: 'admin', attach: DOCUMENTS.ledInvoice },
    ],
  },
  {
    key: 'grass', at: [130, '20:45'], by: 3, labels: ['Garden'],
    title: 'Artificial grass in the courtyard',
    description: 'The lawn in the courtyard is mostly mud from November to March. Artificial grass would stay green all year and would need no watering or mowing.',
    steps: [
      { at: [129, '09:20'], by: 4, comment: "Artificial grass gets very hot in summer and doesn't drain well. I'd rather reseed the lawn and fix the drainage." },
      { at: [128, '22:05'], by: 10, comment: 'Agree with Sofia. The hedges also need the soil to breathe.' },
      { at: [121, '19:00'], by: 1, status: 'voting' },
      { at: [119, '21:45'], by: 'admin', status: 'discarded' },
      { at: [119, '21:46'], by: 'admin', comment: 'Discarded at the ordinary meeting. The gardener will reseed the lawn in spring instead.' },
    ],
  },
  {
    key: 'lift', at: [96, '19:22'], by: 1, labels: ['Lift', 'Accessibility'],
    title: 'Lift modernisation',
    description: 'The lift is 28 years old and Apex Lifts has warned that spare parts for its controller are being discontinued. A modernisation would replace the controller and the motor drive, and add automatic sliding doors, LED cabin lighting and an emergency phone line.\n\nWe need at least two quotes before the vote.',
    steps: [
      { at: [95, '09:15'], by: 2, comment: 'My mother uses a walker and the manual door is very hard for her. Automatic doors would make a huge difference.' },
      { at: [93, '20:40'], by: 5, comment: 'How long would the lift be out of service? Some of us on the upper floors would struggle for more than a few days.' },
      { at: [92, '08:05'], by: 1, comment: 'Usually three to four weeks for a full modernisation. We can ask for a stair-climbing chair during the works.' },
      { at: [80, '11:30'], by: 'admin', status: 'quoting' },
      { at: [61, '13:10'], by: 'admin', attach: DOCUMENTS.liftDraft, key: 'lift:draft' },
      { at: [47, '13:05'], by: 'admin', withdraw: 'lift:draft' },
      { at: [47, '13:12'], by: 'admin', attach: DOCUMENTS.liftQuote },
      { at: [47, '13:15'], by: 'admin', comment: 'I withdrew the draft quote from Apex Lifts: the final version adds the emergency phone line and the alarm.' },
      { at: [43, '18:30'], by: 'admin', attach: DOCUMENTS.liftAlternative },
      { at: [41, '21:00'], by: 6, comment: 'Riverside is cheaper to install, but their maintenance contract costs EUR 95 more per month. Over ten years, Apex comes out about EUR 8,400 cheaper.' },
      { at: [24, '15:40'], by: 'admin', attach: DOCUMENTS.liftInspection },
      { at: [24, '15:45'], by: 'admin', comment: "The inspector rated the controller as 'end of life' and recommends replacing it within twelve months." },
      { at: [12, '19:45'], by: 1, edit: { title: 'Lift modernisation: controller, doors and cabin', status: 'voting' } },
      { at: [12, '19:48'], by: 1, comment: "The vote will be at the next residents' meeting (see the event below). Both quotes and the inspection report are attached." },
      { at: [2, '18:10'], by: 7, comment: 'Will there be a payment plan? EUR 38,720 is a lot to pay at once.' },
      { at: { hoursAgo: 3 }, by: 1, comment: 'Yes: the proposal is a special assessment in ten monthly instalments, shared by ownership coefficient.' },
    ],
  },
  {
    key: 'ramp', at: [88, '10:25'], by: 2, labels: ['Accessibility'],
    title: 'Accessible ramp at the main entrance',
    description: 'The three steps at the main entrance are a barrier for wheelchairs, prams and shopping trolleys. A removable aluminium ramp is not enough: we propose a permanent ramp with handrails on the left side of the steps.',
    steps: [
      { at: [87, '19:30'], by: 5, comment: 'Fully support this. The delivery drivers will thank us too.' },
      { at: [86, '21:15'], by: 9, comment: "I'm an architect, so I can draw the ramp. The slope must stay under 8% and it needs a landing halfway." },
      { at: [80, '09:50'], by: 'admin', status: 'quoting' },
      { at: [70, '22:30'], by: 9, attach: DOCUMENTS.rampDrawings, key: 'ramp:drawings' },
      { at: [69, '08:15'], by: 9, rename: 'ramp:drawings', filename: 'Ramp drawings (revision 2).pdf' },
      { at: [62, '12:00'], by: 'admin', attach: DOCUMENTS.rampQuote },
      { at: [48, '19:05'], by: 1, status: 'voting' },
      { at: [36, '21:00'], by: 'admin', status: 'approved' },
      { at: [36, '21:02'], by: 'admin', comment: 'Approved at the extraordinary meeting: Steelworks Access, EUR 8,954 including VAT.' },
      { at: [15, '10:20'], by: 'admin', status: 'ordered' },
      { at: [15, '10:22'], by: 'admin', comment: 'Ordered. Steelworks Access will install it in about four weeks; the entrance stays usable during the works.' },
    ],
  },
  {
    key: 'roof', at: [76, '22:41'], by: 14, labels: ['Roof'],
    title: 'Roof leak above the fourth-floor landing',
    description: 'Water drips from the ceiling of the fourth-floor landing whenever it rains heavily. The stain next to the skylight keeps growing and the plaster has started to flake.',
    steps: [
      { at: [76, '22:50'], by: 14, attach: DOCUMENTS.roofPhotos },
      { at: [75, '08:20'], by: 13, comment: "Same here: there's a damp patch in our hallway in 4A, right below the skylight." },
      { at: [74, '13:05'], by: 1, comment: "I've called Summit Roof Repairs for an inspection this week." },
      { at: [71, '17:45'], by: 1, attach: DOCUMENTS.roofReport },
      {
        at: [70, '18:02'], by: 1, edit: {
          status: 'quoting', labels: ['Painting', 'Roof'],
          description: 'Water drips from the ceiling of the fourth-floor landing whenever it rains heavily. The stain next to the skylight keeps growing and the plaster has started to flake.\n\nSummit Roof Repairs inspected the roof: the waterproof membrane has split around the skylight and the flashing is loose. Once the roof is fixed, the landing ceiling will need replastering and repainting.',
        },
      },
      { at: [58, '12:30'], by: 'admin', attach: DOCUMENTS.roofSummit },
      { at: [55, '10:10'], by: 'admin', attach: DOCUMENTS.roofNorthgate },
      { at: [54, '21:15'], by: 6, comment: "Northgate includes a 10-year guarantee on the membrane and Summit only 5. I think that's worth the extra EUR 600.", key: 'roof:guarantee' },
      { at: [54, '21:30'], by: 6, editComment: 'roof:guarantee', body: "Northgate includes a 10-year guarantee on the membrane and Summit only 5. I think that's worth the extra EUR 605." },
      { at: [48, '19:00'], by: 1, status: 'voting' },
      { at: [48, '19:02'], by: 1, comment: 'Both quotes go to the vote at the extraordinary meeting.' },
      { at: [36, '21:05'], by: 'admin', status: 'approved' },
      { at: [36, '21:07'], by: 'admin', comment: 'Approved at the extraordinary meeting: Northgate Roofing, EUR 6,050 including VAT, paid from the reserve fund.' },
      { at: [35, '10:30'], by: 'admin', attach: DOCUMENTS.roofMinutes },
      { at: [22, '10:40'], by: 'admin', status: 'ordered' },
      { at: [22, '10:42'], by: 'admin', attach: DOCUMENTS.roofOrder },
      { at: [3, '08:15'], by: 1, status: 'in_progress' },
      { at: [3, '08:17'], by: 1, comment: "The scaffolding goes up today on the rear facade. Please keep the courtyard clear and don't leave bikes next to it." },
      { at: [1, '18:20'], by: 14, comment: "No drips during yesterday's storm. Fingers crossed!" },
      { at: { hoursAgo: 5 }, by: 13, comment: "The roofers asked for access to the 4A terrace tomorrow at 8:00. I'll be at home." },
    ],
  },
  {
    key: 'access', at: [68, '21:30'], by: 9, labels: ['Security'],
    title: 'Entrance door access control',
    description: 'We still use keys that anyone can copy at a kiosk. A fob reader at the street door and at the car park door would let us block a lost fob instead of changing the lock and handing out new keys.',
    steps: [
      { at: [67, '08:40'], by: 8, comment: 'Good idea. Could the fobs also open the bike room if we ever build one?' },
      { at: [66, '20:10'], by: 3, comment: "Please keep a keypad option for neighbours who don't want a fob.", key: 'access:keypad' },
      { at: [66, '20:16'], by: 3, editComment: 'access:keypad', body: "Please keep a keypad option for neighbours who don't want to carry a fob, and for deliveries." },
      { at: [60, '11:45'], by: 'admin', status: 'quoting' },
      { at: [52, '15:20'], by: 'admin', attach: DOCUMENTS.accessQuote },
      { at: [48, '19:10'], by: 1, status: 'voting' },
      { at: [36, '21:10'], by: 'admin', status: 'approved' },
      { at: [36, '21:12'], by: 'admin', comment: 'Approved at the extraordinary meeting: Fortis Door Systems, with a keypad and 40 fobs.' },
    ],
  },
  {
    key: 'pest', at: [64, '08:47'], by: 4, labels: ['Common areas'],
    title: 'Pest control in the basement and bin store',
    description: 'Cockroaches have been seen next to the bin store and in the basement corridor. Pest Away Services can treat both areas and the drains in a single visit.',
    steps: [
      { at: [63, '19:20'], by: 7, comment: 'I saw one in the lift lobby last night as well.' },
      { at: [62, '10:00'], by: 'admin', status: 'quoting' },
      { at: [62, '10:05'], by: 'admin', attach: DOCUMENTS.pestQuote },
      { at: [60, '18:00'], by: 1, status: 'approved' },
      { at: [60, '18:02'], by: 1, comment: "It's a health matter, so I approved it from the emergency budget. It will be reported at the next meeting." },
      { at: [59, '09:15'], by: 'admin', status: 'ordered' },
      { at: [51, '16:30'], by: 'admin', status: 'done' },
      { at: [51, '16:32'], by: 'admin', attach: DOCUMENTS.pestCertificate },
      { at: [51, '16:35'], by: 'admin', comment: 'Treatment done. Please keep the basement doors closed for 48 hours.' },
    ],
  },
  {
    key: 'gutters', at: [58, '17:00'], by: 13, labels: ['Roof', 'Plumbing'],
    title: 'Gutter and downpipe replacement',
    description: 'The gutters on the rear facade overflow every time it rains and one of the downpipes is cracked at ground level. Water runs down the wall into the basement light well.',
    steps: [
      { at: [57, '20:30'], by: 3, comment: 'That would explain the damp in the basement.' },
      { at: [50, '10:15'], by: 'admin', status: 'quoting' },
      { at: [45, '12:40'], by: 'admin', attach: DOCUMENTS.guttersQuote },
      { at: [44, '19:05'], by: 13, comment: 'Northgate can do it together with the roof repair and share the scaffolding, which saves about EUR 900.' },
      { at: [40, '20:00'], by: 1, status: 'voting' },
      { at: [36, '21:14'], by: 'admin', status: 'approved' },
      { at: [36, '21:16'], by: 'admin', comment: 'Approved at the extraordinary meeting, to be done together with the roof repair.' },
    ],
  },
  {
    key: 'irrigation', at: [45, '18:55'], by: 4, labels: ['Garden', 'Plumbing'],
    title: 'Drip irrigation for the courtyard garden',
    description: "Watering the courtyard plants by hand takes a lot of time in summer and depends on a few volunteers. A drip irrigation system with a timer on the garden tap would keep the hedges and flower beds alive while we're on holiday.",
    steps: [
      { at: [44, '09:30'], by: 10, comment: "Please add a rain sensor so that it doesn't water during storms." },
      { at: [43, '21:05'], by: 12, comment: 'Happy to look after the timer settings.' },
      { at: [30, '12:20'], by: 'admin', status: 'quoting' },
      { at: [30, '12:24'], by: 'admin', attach: DOCUMENTS.irrigationQuote },
      { at: [29, '18:45'], by: 4, comment: "The quote includes the rain sensor. I've asked for a second quote as well." },
    ],
  },
  {
    key: 'facade', at: [40, '12:10'], by: 5, labels: ['Painting'],
    title: 'Facade painting',
    description: "The street facade hasn't been painted for fifteen years. The paint is peeling around the balconies and there are damp stains under several window sills.",
    steps: [
      { at: [39, '18:20'], by: 13, comment: "The council may require the original colour on the street facade. Let's check before choosing." },
      { at: [38, '20:00'], by: 1, comment: "We'll also need a permit for the scaffolding on the pavement." },
      { at: [21, '11:10'], by: 'admin', status: 'quoting' },
      { at: [14, '13:30'], by: 'admin', attach: DOCUMENTS.facadeQuote },
      { at: [13, '19:40'], by: 5, comment: 'ColourCraft can start in spring and their price includes the scaffolding permit.' },
    ],
  },
  {
    key: 'solar', at: [33, '20:20'], by: 7, labels: ['Energy', 'Roof'],
    title: 'Solar panels feasibility study',
    description: 'The flat roof gets sun all day. A shared solar installation could power the lift, the lighting and the pumps, and the surplus could be shared among the dwellings. A feasibility study would tell us the size, the cost and the payback time.',
    steps: [
      { at: [33, '20:24'], by: 7, attach: DOCUMENTS.solarSubsidies, key: 'solar:subsidies' },
      { at: [32, '08:35'], by: 10, comment: 'Count me in. We should wait until the roof repair is finished before installing anything.' },
      { at: [31, '21:00'], by: 1, comment: "Agreed: let's ask for the study now and decide after the roof works." },
      { at: [28, '19:10'], by: 7, withdraw: 'solar:subsidies' },
      { at: [28, '19:12'], by: 7, comment: "I withdrew the subsidy summary: it followed last year's call, and the new one changes the percentages. I'll share it once it is published." },
      { at: [25, '10:00'], by: 1, status: 'quoting' },
      { at: [9, '16:15'], by: 'admin', attach: DOCUMENTS.solarProposal },
    ],
  },
  {
    key: 'extinguishers', at: [30, '09:00'], by: 'admin', labels: ['Security'],
    title: 'Fire extinguisher replacement',
    description: 'The annual fire safety inspection found that four extinguishers have reached the end of their service life: ground floor, first and third floor landings and the car park. They must be replaced before the next inspection.',
    steps: [
      { at: [30, '09:05'], by: 'admin', attach: DOCUMENTS.fireReport },
      { at: [26, '10:30'], by: 'admin', status: 'quoting' },
      { at: [18, '12:15'], by: 'admin', attach: DOCUMENTS.fireQuote },
      { at: [16, '19:20'], by: 1, status: 'approved' },
      { at: [16, '19:22'], by: 1, comment: "It's a legal requirement, so I approved it without a vote." },
      { at: [8, '09:40'], by: 'admin', status: 'ordered' },
    ],
  },
  {
    key: 'play', at: [27, '18:30'], by: 12, labels: ['Garden'],
    title: 'Play corner in the courtyard',
    description: 'Seven children live in the building and the courtyard has nothing for them. A small play corner with a rubber floor and a covered sandpit in the sunny corner, away from the bins, would make a big difference.',
    steps: [
      { at: [26, '21:40'], by: 14, comment: "Lovely idea, as long as it's quiet after 21:00." },
      { at: [26, '22:05'], by: 12, comment: 'Of course: the house rules still apply.' },
      { at: [20, '11:00'], by: 'admin', status: 'quoting' },
      { at: [15, '17:25'], by: 'admin', attach: DOCUMENTS.playQuote },
      { at: [6, '20:30'], by: 1, status: 'voting' },
      { at: [6, '20:32'], by: 1, comment: "Added to the agenda of the next residents' meeting." },
    ],
  },
  {
    key: 'intercom', at: [19, '19:05'], by: 8, labels: ['Security'],
    title: 'Intercom repair: no sound in 2C',
    description: "Visitors can hear us, but we can't hear them through the handset in 2C. It started after the storm, so it may be the wiring rather than the handset.",
    steps: [
      { at: [18, '08:50'], by: 7, comment: 'Exactly, since the storm three weeks ago.' },
      { at: [17, '12:30'], by: 'admin', comment: 'Fortis Door Systems will check the wiring.' },
      { at: [12, '10:10'], by: 'admin', status: 'ordered' },
      { at: [4, '13:20'], by: 'admin', status: 'in_progress' },
      { at: [4, '13:25'], by: 'admin', comment: 'The technician replaced the handset. The riser cable will be checked next week.' },
    ],
  },
  {
    key: 'damp', at: [11, '09:40'], by: 3, labels: ['Plumbing'],
    title: 'Damp in the basement storage rooms',
    description: 'Storage rooms 2 and 5 smell of damp and the boxes on the floor are getting mouldy. There may be a leak in the downpipe behind the wall.',
    steps: [
      { at: [10, '20:15'], by: 4, comment: "Same in storage room 4. I've put my things on shelves for now." },
      { at: [9, '08:30'], by: 13, comment: 'The cracked downpipe is right behind that wall. The gutter replacement should fix it.' },
    ],
  },
  {
    key: 'bikes', at: [9, '21:15'], by: 6, labels: ['Common areas'],
    title: 'Bike storage in the basement',
    description: 'There are at least fifteen bikes in the building and most of them end up in hallways or on balconies. The unused room next to the boiler room could hold wall-mounted racks for about twenty bikes.',
    steps: [
      { at: [9, '21:20'], by: 6, attach: DOCUMENTS.bikeCatalogue },
      { at: [8, '07:55'], by: 8, comment: 'Great idea, as long as the room is locked. Once the access control is installed, our fobs could open it.' },
      { at: [7, '19:30'], by: 10, comment: 'I measured the room: 4.2 m by 3 m, with a socket for electric bikes.' },
      { at: [2, '17:45'], by: 6, comment: 'Thanks! The catalogue has a two-tier rack that would fit 24 bikes in that space.' },
    ],
  },
  {
    key: 'tiles', at: [6, '10:05'], by: 'admin', labels: [],
    title: 'Cracked tiles on the second-floor landing',
    description: 'Three floor tiles in front of the lift on the second floor are cracked and one of them wobbles. Reported by the cleaning company.',
    steps: [],
  },
]

/** The step of a script, applied to its action. */
function apply(state: CommunityState, refs: ScenarioRefs, script: ActionScript, item: ActionStep, instant: string, uploadId: () => string): void {
  const action = ref(refs.actions, script.key)
  const by = actor(item.by)
  if ('status' in item) editAction(state, by, action, { status: item.status }, instant)
  else if ('edit' in item) editAction(state, by, action, item.edit, instant)
  else if ('comment' in item) {
    const comment = addComment(state, by, action, item.comment, instant)
    if (item.key) refs.comments.set(item.key, comment)
  } else if ('editComment' in item) editComment(state, by, action, ref(refs.comments, item.editComment), item.body, instant)
  else if ('withdrawComment' in item) withdrawComment(state, by, action, ref(refs.comments, item.withdrawComment), instant)
  else if ('attach' in item) {
    const bytes = printDocument(item.attach, instant)
    const attachment = addAttachment(state, by, action, { id: uploadId(), filename: item.attach.filename, bytes, sha256: sha256Hex(bytes) }, instant)
    if (item.key) refs.attachments.set(item.key, attachment)
  } else if ('rename' in item) renameAttachment(state, by, action, ref(refs.attachments, item.rename), item.filename, instant)
  else withdrawAttachment(state, by, action, ref(refs.attachments, item.withdraw), instant)
}

/** The actions' part of the community timeline. */
export function actionSteps(): ScenarioStep[] {
  // Upload ids in the order the steps run (chronological), so they never depend on the scripts' order.
  const random = demoRandom('community:attachments')
  const uploadId = () => random.uuid()
  const labels = step([400, '09:00'], state => {
    for (const [name, color] of COLOURED_LABELS) state.labels.push({ id: state.sequences.label.next(), name, color, version: 2 })
  })
  // The administrator gave "Security" a stronger colour: the actions labelled then record it.
  const recolour = step([88, '11:30'], (state, _refs, instant) => {
    const label = findLabelByName(state, 'Security')
    if (!label) throw new Error('The community scenario has no Security label')
    editLabel(state, actor('admin'), label, label.name, '#b94644', instant)
  })
  return [labels, recolour, ...SCRIPTS.flatMap(script => [
    step(script.at, (state, refs, instant) => {
      refs.actions.set(script.key, createAction(state, actor(script.by), {
        title: script.title, description: script.description, status: 'detected', labels: script.labels,
      }, instant))
    }),
    ...script.steps.map(item => step(item.at, (state, refs, instant) => apply(state, refs, script, item, instant, uploadId))),
  ])]
}
