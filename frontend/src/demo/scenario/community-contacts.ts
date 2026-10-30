/**
 * Contacts of Maple Court: the suppliers, services and emergency numbers the neighbors share, with
 * coloured tags, their history over more than a year, and two contacts deleted into the archive.
 * Emails use example.com/.org and phones the UK drama range (+44 20 7946 0xxx).
 */
import type { ContactTagIn } from '../../api/schema.gen'
import { createContact, deleteContact, editContact, editContactTag, findContactTagByName, type ContactFields } from '../store/community-contacts'
import { actor, ref, step, type ScenarioStep, type When, type Who } from './community-script'

const TAG_COLOURS: Readonly<Record<string, string>> = {
  Administration: '#bd9670', Building: '#d77089', Cleaning: '#cf7ffd', Electrical: '#c6c102', Emergency: '#b94644',
  Garden: '#2bccb4', Insurance: '#896385', Lift: '#4963de', Plumbing: '#47a4b4', Security: '#e65909',
}

interface ContactScript extends ContactFields {
  key: string
  at: When
  by: Who
  /** Tag names: new ones are created with the contact, like the app's tag picker does. */
  tags: readonly string[]
  updates?: readonly ({ at: When; by: Who } & Partial<ContactFields>)[]
  deleted?: { at: When; by: Who }
}

const SCRIPTS: readonly ContactScript[] = [
  {
    key: 'manager', at: [410, '10:00'], by: 'admin', tags: ['Administration'],
    name: 'Sarah Lane', company: 'Harper & Lane Property Management', email: 's.lane@example.com', phone: '+442079460148',
    notes: 'Prepares the annual accounts and the minutes of the meetings. Office hours: Monday to Friday, 9:00 to 14:00.',
    updates: [{ at: [150, '12:10'], by: 1, email: 'sarah.lane@example.com' }],
  },
  {
    key: 'lift', at: [405, '11:30'], by: 'admin', tags: ['Lift', 'Emergency'],
    name: 'Apex Lifts service desk', company: 'Apex Lifts', email: 'apexlifts.service@example.com', phone: '+442079460125',
    notes: 'Maintenance contract ML-20417. If someone is trapped in the lift, call the 24-hour line: they arrive within 45 minutes.',
    updates: [{
      at: [24, '16:00'], by: 'admin',
      notes: 'Maintenance contract ML-20417. If someone is trapped in the lift, call the 24-hour line: they arrive within 45 minutes.\n\nLast inspection passed with remarks: the controller is at the end of its life (see the lift modernisation action).',
    }],
  },
  {
    key: 'gardener', at: [400, '09:00'], by: 4, tags: ['Garden'],
    name: 'Peter Doyle', company: 'Doyle Garden Care', email: 'peter.doyle@example.com', phone: '+442079460259',
    notes: 'Mows the lawn every two weeks from April to October.',
    updates: [{ at: [205, '18:00'], by: 4, notes: 'Mows the lawn every two weeks from April to October.\nRetiring at the end of the season: Green Thumb Gardens takes over.' }],
    deleted: { at: [198, '18:30'], by: 4 },
  },
  {
    key: 'old-cleaning', at: [395, '17:00'], by: 'admin', tags: ['Cleaning'],
    name: 'Laura Mills', company: 'Shine & Co Cleaning', email: 'laura.mills@example.com', phone: '+442079460248',
    notes: 'Cleaning on Tuesdays and Fridays.',
    updates: [{ at: [122, '10:20'], by: 'admin', notes: 'Cleaning on Tuesdays and Fridays.\nContract ended: replaced by Sparkle Cleaning Services.' }],
    deleted: { at: [120, '10:30'], by: 'admin' },
  },
  {
    key: 'gas', at: [390, '20:00'], by: 'admin', tags: ['Emergency'],
    name: 'Gas emergencies', company: 'City Gas Network', email: null, phone: '+442079460199',
    notes: "If you smell gas: open the windows, don't touch any switches, leave the building and call this number.",
  },
  {
    key: 'water', at: [390, '20:05'], by: 'admin', tags: ['Emergency', 'Plumbing'],
    name: 'Water emergencies', company: 'Riverside Water', email: null, phone: '+442079460203',
    notes: 'Leaks in the street or no water supply. Customer number of the community: RW-77812.',
  },
  {
    key: 'plumber', at: [380, '19:00'], by: 5, tags: ['Plumbing', 'Emergency'],
    name: 'Marcus Hill', company: 'Northgate Plumbing', email: 'marcus.hill@example.com', phone: '+442079460109',
    notes: "Fixed the leak in the basement pipes. 24-hour callout for leaks; weekday visits from 8:00. Ask for the invoice in the community's name, not the dwelling's.",
    updates: [{ at: [60, '10:00'], by: 3, phone: '+442079460102' }],
  },
  {
    key: 'insurance', at: [370, '12:00'], by: 'admin', tags: ['Insurance', 'Emergency'],
    name: 'Claims line', company: 'Meridian Home Insurance', email: 'claims.meridian@example.com', phone: '+442079460156',
    notes: 'Policy MC-558201 covers the building and the common areas. Report water damage within 7 days, with photos.',
  },
  {
    key: 'boilers', at: [330, '09:20'], by: 'admin', tags: ['Plumbing'],
    name: 'Nadia Petrova', company: 'Heatwise Boilers', email: 'nadia.petrova@example.com', phone: '+442079460226',
    notes: 'Services the hot water pumps of the boiler room once a year.',
  },
  {
    key: 'council', at: [300, '19:30'], by: 2, tags: ['Administration'],
    name: 'Bulky waste collection', company: 'Borough Council', email: 'bulky.waste@example.org', phone: '+442079460190',
    notes: 'Book a collection online or by phone at least three days ahead. Items must be on the pavement before 8:00.',
  },
  {
    key: 'locksmith', at: [222, '18:40'], by: 1, tags: ['Security', 'Emergency'],
    name: 'Keystone Locksmiths', company: '', email: null, phone: '+442079460161',
    notes: '24-hour emergency door opening. Their quote for the new mailboxes is attached to the action.',
    updates: [{ at: [183, '13:10'], by: 1, notes: '24-hour emergency door opening. Supplied and installed the new mailboxes in the entrance hall.' }],
  },
  {
    key: 'garden', at: [199, '10:15'], by: 4, tags: ['Garden'],
    name: 'Oliver Green', company: 'Green Thumb Gardens', email: 'oliver.green@example.com', phone: '',
    notes: 'Prunes the hedges in March and October and reseeds the lawn in spring. Prefers email; usually replies within two days.',
  },
  {
    key: 'electrician', at: [134, '09:00'], by: 10, tags: ['Electrical'],
    name: 'Aisha Khan', company: 'Bright Spark Electrical', email: 'aisha.khan@example.com', phone: '+442079460117',
    notes: 'Installed the LED lighting and motion sensors in the stairwells. Two-year guarantee on the installation.',
  },
  {
    key: 'cleaning', at: [121, '09:40'], by: 'admin', tags: ['Cleaning'],
    name: 'Joanna Price', company: 'Sparkle Cleaning Services', email: 'joanna.price@example.com', phone: '+442079460133',
    notes: 'Cleaning on Mondays and Thursdays from 9:00 to 12:00. Windows of the common areas every three months.',
  },
  {
    key: 'windows', at: [95, '18:00'], by: 14, tags: ['Cleaning'],
    name: 'Tom Ellis', company: 'Crystal Clear Windows', email: 'tom.ellis@example.com', phone: '+442079460214',
    notes: 'Cleans outside windows with rope access. Quote per dwelling on request.',
  },
  {
    key: 'pests', at: [62, '10:10'], by: 'admin', tags: [],
    name: 'Kevin Shaw', company: 'Pest Away Services', email: 'kevin.shaw@example.com', phone: '+442079460189',
    notes: 'Treated the basement and the bin store. A follow-up visit within three months is included.',
  },
  {
    key: 'roofer', at: [56, '12:00'], by: 1, tags: ['Building'],
    name: 'Ben Carter', company: 'Northgate Roofing', email: 'ben.carter@example.com', phone: '+442079460174',
    notes: 'Repairing the roof membrane above the fourth-floor landing and the rear gutters. Ask for him on site.',
  },
  {
    key: 'doors', at: [52, '15:30'], by: 9, tags: ['Security'],
    name: 'Fortis Door Systems', company: '', email: 'support.fortis@example.com', phone: '+442079460237',
    notes: "Intercom and access control. Their quote for the fob readers is attached to the action 'Entrance door access control'.",
  },
]

function newTags(names: readonly string[]): ContactTagIn[] {
  return names.map(name => ({ name, color: TAG_COLOURS[name] }))
}

/** The contacts' part of the community timeline. */
export function contactSteps(): ScenarioStep[] {
  const rename = step([20, '10:00'], (state, _refs, instant) => {
    const tag = findContactTagByName(state, 'Building')
    if (!tag) throw new Error('The community scenario has no Building tag')
    editContactTag(state, actor('admin'), tag, { name: 'Building works', color: tag.color }, instant)
  })
  return [rename, ...SCRIPTS.flatMap(script => {
    const { key, at: when, by, tags, updates = [], deleted, ...fields } = script
    return [
      step(when, (state, refs, instant) => {
        refs.contacts.set(key, createContact(state, actor(by), fields, [], newTags(tags), instant))
      }),
      ...updates.map(({ at: changed, by: editor, ...changes }) => step(changed, (state, refs, instant) => {
        editContact(state, actor(editor), ref(refs.contacts, key), changes, undefined, [], instant)
      })),
      ...(deleted ? [step(deleted.at, (state, refs, instant) => deleteContact(state, actor(deleted.by), ref(refs.contacts, key), instant))] : []),
    ]
  })]
}
