// English dictionary: the source of truth. Each namespace lives in its own file owned by one feature;
// ../es mirrors these shapes, so a missing or extra Spanish key fails `tsc`.
import { accounts } from './accounts'
import { actions } from './actions'
import { admin } from './admin'
import { auth } from './auth'
import { common } from './common'
import { contacts } from './contacts'
import { demo } from './demo'
import { errors } from './errors'
import { events } from './events'
import { finance } from './finance'
import { labels } from './labels'
import { neighbors } from './neighbors'
import { shell } from './shell'
import { storage } from './storage'

export const en = {
  common,
  shell,
  auth,
  errors,
  finance,
  admin,
  actions,
  events,
  accounts,
  neighbors,
  contacts,
  labels,
  storage,
  demo,
} as const
