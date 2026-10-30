/**
 * The PDFs attached to the demo's actions (quotes, reports, minutes, invoices): synthetic English
 * documents for Maple Court. The scenario prints them with `demoPdf`, dated on the day they were
 * attached; amounts are in euros, like the community's account.
 */

export interface PdfDocument {
  filename: string
  title: string
  lines: readonly string[]
}

const CLIENT = "Client: Maple Court residents' community"

/** `EUR 1,234.50` from cents. */
export function euros(cents: number): string {
  const whole = Math.trunc(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `EUR ${whole}.${String(cents % 100).padStart(2, '0')}`
}

/** A supplier's quote: numbered items, subtotal, 21% VAT and total. */
function quote(filename: string, company: string, reference: string, subject: string, items: readonly (readonly [string, number])[], terms: readonly string[]): PdfDocument {
  const subtotal = items.reduce((sum, [, amount]) => sum + amount * 100, 0)
  const vat = Math.round(subtotal * 0.21)
  return {
    filename,
    title: `${company} - Quote ${reference}`,
    lines: [
      CLIENT, `Subject: ${subject}`, '',
      ...items.map(([item, amount], index) => `${index + 1}. ${item}: ${euros(amount * 100)}`), '',
      `Subtotal: ${euros(subtotal)}`, `VAT (21%): ${euros(vat)}`, `Total: ${euros(subtotal + vat)}`, '',
      ...terms,
    ],
  }
}

function invoice(filename: string, company: string, reference: string, items: readonly (readonly [string, number])[]): PdfDocument {
  const value = quote(filename, company, reference, 'works completed', items, ['Paid by bank transfer to the account of the supplier.'])
  return { ...value, title: `${company} - Invoice ${reference}` }
}

export const DOCUMENTS = {
  mailboxQuote: quote('Quote - Keystone Locksmiths.pdf', 'Keystone Locksmiths', 'KL-0417', 'new mailboxes in the entrance hall', [
    ['12 steel mailboxes with individual locks and a shared parcel slot', 1740],
    ['Printed name plates (12)', 72],
    ['Removal of the old mailbox block', 120],
    ['Installation and two keys per mailbox', 268],
  ], ['Delivery in three weeks from the order.', 'Validity: 60 days.']),
  mailboxInvoice: invoice('Invoice - Keystone Locksmiths.pdf', 'Keystone Locksmiths', 'KL-INV-2291', [
    ['12 steel mailboxes with individual locks and a shared parcel slot', 1740],
    ['Printed name plates (12)', 72],
    ['Removal of the old mailbox block', 120],
    ['Installation and two keys per mailbox', 268],
  ]),
  cctvQuote: quote('Quote - Fortis Security.pdf', 'Fortis Security', 'FS-1182', 'CCTV at the car park entrance', [
    ['Outdoor cameras covering the entrance ramp (2)', 580],
    ['Recorder with 7-day automatic deletion', 240],
    ['Installation and warning signs', 155],
  ], ['Recording limited to the entrance ramp.', 'Validity: 30 days.']),
  // Attached by mistake and withdrawn the next day (the camera of a private garage).
  cctvMixup: quote('Quote - Fortis Security (single camera).pdf', 'Fortis Security', 'FS-1179', 'one indoor camera for a private garage', [
    ['Indoor camera with motion alerts', 260],
    ['Installation and configuration', 120],
  ], ['Prepared for a private garage, not for the community.', 'Validity: 30 days.']),
  ledQuote: quote('Quote - Bright Spark Electrical.pdf', 'Bright Spark Electrical', 'BSE-2046', 'LED lighting in the stairwells', [
    ['LED panels with built-in motion sensor (14)', 1372],
    ['Emergency lighting units (6)', 510],
    ['Wiring and installation', 900],
    ['Removal and recycling of the old tubes', 94],
  ], ['Two-year guarantee on the installation.', 'Validity: 60 days.']),
  ledAlternative: quote('Quote - Lumen Installations.pdf', 'Lumen Installations', 'LI-77', 'LED lighting in the stairwells', [
    ['LED ceiling lights (14)', 1190],
    ['Motion sensors, one per landing (6)', 690],
    ['Emergency lighting units (6)', 540],
    ['Wiring and installation', 680],
  ], ['One-year guarantee.', 'Validity: 30 days.']),
  ledInvoice: invoice('Invoice - Bright Spark Electrical.pdf', 'Bright Spark Electrical', 'BSE-INV-3310', [
    ['LED panels with built-in motion sensor (14)', 1372],
    ['Emergency lighting units (6)', 510],
    ['Wiring and installation', 900],
    ['Removal and recycling of the old tubes', 94],
  ]),
  liftDraft: quote('Quote - Apex Lifts (draft).pdf', 'Apex Lifts', 'AL-5531 (draft)', 'lift modernisation', [
    ['New controller and motor drive', 14800],
    ['Automatic sliding doors (5 landings and cabin)', 9600],
    ['Cabin refurbishment with LED lighting', 3900],
    ['Installation, testing and certification', 2500],
  ], ['Draft for discussion: emergency phone line not included.']),
  liftQuote: quote('Quote - Apex Lifts.pdf', 'Apex Lifts', 'AL-5531', 'lift modernisation', [
    ['New controller and motor drive', 14800],
    ['Automatic sliding doors (5 landings and cabin)', 9600],
    ['Cabin refurbishment with LED lighting', 3900],
    ['Emergency phone line and alarm', 1200],
    ['Installation, testing and certification', 2500],
  ], ['Works: 3 to 4 weeks, lift out of service.', 'Maintenance contract afterwards: EUR 190.00 per month.', 'Validity: 90 days.']),
  liftAlternative: quote('Quote - Riverside Elevators.pdf', 'Riverside Elevators', 'RE-2026-48', 'lift modernisation', [
    ['Controller and variable-frequency drive', 13200],
    ['Automatic doors (5 landings and cabin)', 9100],
    ['Cabin panels and LED lighting', 3600],
    ['Emergency phone line', 1100],
    ['Installation and certification', 2500],
  ], ['Works: 4 weeks.', 'Maintenance contract afterwards: EUR 285.00 per month.', 'Validity: 60 days.']),
  liftInspection: {
    filename: 'Annual lift inspection report.pdf',
    title: 'Annual lift inspection report',
    lines: [
      'Installation: passenger lift, 6 stops, 450 kg / 6 persons', 'Inspection body: Northern Lift Certification', '',
      'Result: passed with remarks', '',
      '1. Controller: end of life, spare parts no longer manufactured.',
      '   Replacement recommended within 12 months.',
      '2. Landing doors: manual, closing force within limits.',
      '3. Emergency lighting in the cabin: working.',
      '4. Alarm: no permanent phone line connected.',
      '5. Ropes and brakes: good condition.',
      '', 'Next periodic inspection: in 12 months.',
    ],
  },
  rampDrawings: {
    filename: 'ramp-v2-final.pdf',
    title: 'Accessible ramp at the main entrance - revision 2',
    lines: [
      'Drawn by Emily Clarke (3A), for discussion with the suppliers.', '',
      'Length of the ramp: 6.00 m in two runs of 3.00 m', 'Height to overcome: 0.45 m (three steps)',
      'Slope: 7.5% (maximum allowed 8%)', 'Width: 1.20 m clear between handrails',
      'Intermediate landing: 1.50 m x 1.50 m', 'Handrails on both sides at 0.90 m and 0.70 m',
      'Surface: non-slip aluminium', '', 'The steps remain usable on the right-hand side.',
    ],
  },
  rampQuote: quote('Quote - Steelworks Access.pdf', 'Steelworks Access', 'SA-319', 'permanent ramp at the main entrance', [
    ['Aluminium ramp with intermediate landing (6 m)', 4900],
    ['Handrails on both sides', 1350],
    ['Concrete base and anchoring', 950],
    ['Installation', 200],
  ], ['Installation: 2 days. The entrance stays usable.', 'Validity: 90 days.']),
  roofPhotos: {
    filename: 'Ceiling damage photos.pdf',
    title: 'Ceiling damage on the fourth-floor landing',
    lines: [
      'Photos taken by Chloe Dubois (4A) after the rain.', '',
      'Photo 1: water stain next to the skylight, about 60 x 40 cm.',
      'Photo 2: flaking plaster above the door of 4A.',
      'Photo 3: bucket under the drip, half full after one night.',
      'Photo 4: skylight frame seen from the landing.',
    ],
  },
  roofReport: {
    filename: 'Roof inspection report - Summit Roof Repairs.pdf',
    title: 'Summit Roof Repairs - Roof inspection report',
    lines: [
      CLIENT, 'Area: flat roof above the fourth-floor landing', '',
      'Findings:',
      '1. Waterproof membrane split along the skylight upstand (about 2 m).',
      '2. Skylight flashing loose on the north side.',
      '3. Gutter outlet partly blocked by leaves.',
      '4. Rest of the membrane worn but watertight.', '',
      'Recommendation: replace the membrane around the skylight (35 m2) and',
      'renew the flashing before the winter rains.',
    ],
  },
  roofSummit: quote('Quote - Summit Roof Repairs.pdf', 'Summit Roof Repairs', 'SRR-904', 'roof repair above the fourth-floor landing', [
    ['Scaffolding and safety netting', 1100],
    ['Removal of the damaged membrane (35 m2)', 900],
    ['New waterproof membrane (35 m2)', 1700],
    ['Skylight flashing and sealing', 600],
    ['Waste removal', 200],
  ], ['Guarantee on the membrane: 5 years.', 'Validity: 60 days.']),
  roofNorthgate: quote('Quote - Northgate Roofing.pdf', 'Northgate Roofing', 'NR-2611', 'roof repair above the fourth-floor landing', [
    ['Scaffolding and safety netting', 1150],
    ['Removal of the damaged membrane (35 m2)', 980],
    ['New reinforced waterproof membrane (35 m2)', 1950],
    ['Skylight flashing and sealing', 640],
    ['Waste removal and cleaning', 280],
  ], ['Guarantee on the membrane: 10 years.', 'Validity: 60 days.']),
  roofMinutes: {
    filename: 'Minutes - extraordinary meeting.pdf',
    title: "Maple Court - Minutes of the extraordinary residents' meeting",
    lines: [
      'Chair: James Okafor (president). Dwellings present or represented: 11 of 12.', '',
      '1. Roof repair above the fourth-floor landing.',
      '   Approved: Northgate Roofing, EUR 6,050.00 including VAT, from the reserve fund.',
      '   10 in favour, 1 abstention.',
      '2. Accessible ramp at the main entrance.',
      '   Approved: Steelworks Access, EUR 8,954.00 including VAT. 9 in favour, 2 against.',
      '3. Entrance door access control.',
      '   Approved: Fortis Door Systems, EUR 2,637.80 including VAT. Unanimous.',
      '4. Gutter and downpipe replacement.',
      '   Approved, to be done together with the roof repair. Unanimous.', '',
      'The meeting closed at 20:40.',
    ],
  },
  roofOrder: {
    filename: 'Signed work order - Northgate Roofing.pdf',
    title: 'Northgate Roofing - Work order NR-2611',
    lines: [
      CLIENT, 'Works: roof repair above the fourth-floor landing (quote NR-2611)', '',
      'Price: EUR 6,050.00 including VAT', 'Payment: 30% at the start, 70% on completion',
      'Duration: 8 working days, weather permitting', 'Access: rear courtyard and the terrace of 4A', '',
      'Signed for the community: James Okafor, president',
      'Signed for the supplier: Ben Carter, Northgate Roofing',
    ],
  },
  accessQuote: quote('Quote - Fortis Door Systems.pdf', 'Fortis Door Systems', 'FDS-0721', 'access control at the street and car park doors', [
    ['Fob readers (2)', 960],
    ['Control unit and management software', 520],
    ['Fobs (40)', 240],
    ['Keypad at the street door', 180],
    ['Installation and configuration', 280],
  ], ['Lost fobs can be blocked from the software.', 'Validity: 60 days.']),
  pestQuote: quote('Quote - Pest Away Services.pdf', 'Pest Away Services', 'PA-5520', 'cockroach treatment', [
    ['Gel treatment of the basement and the bin store', 280],
    ['Treatment of drains and manholes', 90],
    ['Follow-up visit within 3 months if needed', 0],
  ], ['Products approved for residential buildings.', 'Validity: 30 days.']),
  pestCertificate: {
    filename: 'Treatment certificate - Pest Away Services.pdf',
    title: 'Pest Away Services - Treatment certificate',
    lines: [
      CLIENT, 'Areas treated: basement corridor, storage rooms, bin store, drains', '',
      'Pest: German cockroach (Blattella germanica)', 'Method: insecticide gel and drain foam',
      'Keep basement doors closed for 48 hours.', 'Follow-up visit included within 3 months.',
    ],
  },
  guttersQuote: quote('Quote - Northgate Roofing (gutters).pdf', 'Northgate Roofing', 'NR-2618', 'gutters and downpipes on the rear facade', [
    ['Replacement of the rear gutters (24 m)', 1680],
    ['New downpipes (2)', 720],
    ['Connection to the drain', 300],
  ], ['Price assumes the scaffolding of the roof repair is shared.', 'Validity: 60 days.']),
  irrigationQuote: quote('Quote - Green Thumb Gardens.pdf', 'Green Thumb Gardens', 'GTG-112', 'drip irrigation for the courtyard garden', [
    ['Drip lines for hedges and flower beds (60 m)', 540],
    ['Timer with rain sensor', 210],
    ['Installation and first adjustment', 250],
  ], ['Validity: 60 days.']),
  facadeQuote: quote('Quote - ColourCraft Decorators.pdf', 'ColourCraft Decorators', 'CC-4410', 'painting of the street facade', [
    ['Scaffolding and pavement permit', 6800],
    ['Repair of render and cracks', 4200],
    ['Silicate paint, two coats', 9600],
    ['Balcony edges and window sills', 2400],
  ], ['Colour to be confirmed with the council.', 'Start: spring, 5 weeks of works.', 'Validity: 90 days.']),
  solarProposal: quote('Feasibility study proposal - SunRise Energy.pdf', 'SunRise Energy', 'SRE-031', 'feasibility study for shared solar panels', [
    ['Site visit and shading analysis', 280],
    ['System design and production estimate', 250],
    ['Report with costs, savings and payback time', 120],
  ], ['First estimate: about 18 kWp (40 panels) on the flat roof.', 'Delivery of the report: 3 weeks after the visit.']),
  // Withdrawn by its author: it summarised the previous call for subsidies.
  solarSubsidies: {
    filename: 'Solar subsidies - summary.pdf',
    title: 'Shared solar installations - subsidy summary',
    lines: [
      "Summary prepared by Grace Liu (2C) from the energy agency's guide.", '',
      "Who can apply: residents' communities with a shared self-consumption installation.",
      'Support: up to 40% of the eligible cost, at most EUR 600 per kWp.',
      'Applications: during the yearly call, before the works start.', '',
      'To be checked against the rules of the current call.',
    ],
  },
  fireReport: {
    filename: 'Fire safety inspection report.pdf',
    title: 'Annual fire safety inspection report',
    lines: [
      CLIENT, 'Inspector: Firesafe Services', '',
      '1. Extinguishers past their 20-year service life: 4',
      '   ground floor, 1st floor landing, 3rd floor landing, car park.',
      '2. Other extinguishers: pressure correct, seals intact.',
      '3. Emergency lighting: working on every landing.',
      '4. Fire doors to the car park: closing correctly.', '',
      'Action required: replace the 4 extinguishers before the next inspection.',
    ],
  },
  fireQuote: quote('Quote - Firesafe Services.pdf', 'Firesafe Services', 'FSS-208', 'replacement of four extinguishers', [
    ['ABC powder extinguishers, 6 kg (4)', 248],
    ['Wall brackets and signs', 48],
    ['Collection and recycling of the old extinguishers', 24],
  ], ['Includes the first annual check.']),
  playQuote: quote('Quote - PlaySafe Outdoor.pdf', 'PlaySafe Outdoor', 'PSO-662', 'play corner in the courtyard', [
    ['Rubber safety floor (20 m2)', 1600],
    ['Sandpit with cover', 450],
    ['Small slide for children aged 2 to 6', 700],
    ['Installation', 250],
  ], ['Certified to the European playground standard.', 'Validity: 60 days.']),
  bikeCatalogue: {
    filename: 'Bike rack catalogue.pdf',
    title: 'Bike parking solutions - catalogue extract',
    lines: [
      'Selected by Olivia Bennett (2B) for the basement room.', '',
      'Two-tier rack, 12 bikes per unit, gas-assisted upper tier: EUR 690.00',
      'Wall-mounted hooks, 6 bikes, staggered: EUR 165.00',
      'Floor rack, 8 bikes: EUR 210.00',
      'Charging point for electric bikes, 4 sockets: EUR 240.00', '',
      'Room of 4.2 m x 3 m: two two-tier racks fit 24 bikes.',
    ],
  },
} satisfies Record<string, PdfDocument>
