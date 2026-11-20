// Notifications (src/notifications): the bell at the top of the portal and its panel, and the
// settings in My profile, push notifications on this device included.
export const notifications = {
  title: 'Notifications',
  // The bell's name says how many are unread, as its badge shows: above nine, "9+" (`{badge}`).
  bellUnread: { one: 'Notifications: {count} unread', other: 'Notifications: {count} unread' },
  bellUnreadMany: 'Notifications: {badge} unread',
  markAllRead: 'Mark all as read',
  // Each control's name starts with its tooltip and tells apart those of several notifications.
  markRead: 'Mark as read: {title}',
  dismiss: 'Dismiss: {title}',
  // Read out before the title of an unread notification.
  unread: 'Unread',
  empty: 'No notifications. You will be told here when something needs your attention.',
  settingsLink: 'Notification settings',
  enableHere: 'Turn on for this device',
  /** Each kind: its title and text under the bell, and its name and description in the settings. */
  kinds: {
    statement_missing: {
      title: 'Missing statement: {month}',
      body: 'It has not been imported yet: import it in Finances > Import.',
      label: 'Missing bank statement',
      description: "From the first day of each month, while the previous month's statement has not been imported.",
    },
    accounts_ready: {
      title: 'The accounts of {month} are ready',
      body: "See the month's income and expenses in Finances > Overview.",
      label: 'Accounts of the month',
      description: "When the statement of the month that just ended is imported, with the month's income and expenses.",
    },
    action_changes: {
      created: 'New action: {title}',
      createdBody: 'Status: {status}',
      statusBody: 'Now: {status}',
      label: 'Actions',
      description: 'When someone creates an action or changes its status.',
    },
    action_comments: {
      // One comment or PDF names its author; more say how many came since you last read it.
      comment: 'New comment by {author}',
      attachment: 'New PDF by {author}',
      comments: { one: '{count} new comment', other: '{count} new comments' },
      attachments: { one: '{count} new PDF', other: '{count} new PDFs' },
      single: '{items}',
      both: '{comments} and {attachments}',
      label: 'Comments on the actions you follow',
      description: 'Comments and PDFs on the actions you created, edited, commented on or attached a PDF to.',
    },
    event_changes: {
      created: 'New event: {title}',
      changed: 'Event changed: {title}',
      cancelled: 'Event cancelled: {title}',
      label: 'Events',
      description: 'When someone creates an event, changes its date, time or place, or deletes it.',
    },
    event_reminder: {
      today: 'Today: {title}',
      tomorrow: 'Tomorrow: {title}',
      reminder: 'Reminder: {title}',
      label: 'Event reminders',
      description: '24 hours before each event starts (an event of a whole day, the day before).',
    },
  },
  // The day an event starts, as in "Thursday 4 December, 19:00 · Portal"; with the year when it is
  // not this one.
  eventDay: '{weekday} {day} {month}',
  eventDayYear: '{weekday} {day} {month} {year}',
  settings: {
    title: 'Notifications',
    intro: 'They appear under the bell at the top of every page and, on the devices where you turn them on, also as notifications of the phone or computer, from 9:00 to 21:00.',
    device: 'Notifications on this device',
    deviceOn: 'This device receives them while you stay signed in on it.',
    deviceOff: 'Turn them on to receive them on this device too.',
    on: 'On',
    off: 'Off',
    working: 'Saving…',
    /** Why this device cannot receive them. */
    unavailable: {
      demo: 'The demo cannot send notifications to your devices.',
      insecure: 'Notifications need the portal to be opened over HTTPS.',
      unsupported: 'This browser cannot receive notifications from the portal.',
      install: 'On an iPhone or iPad, first add the portal to the Home Screen (Share > Add to Home Screen) and turn them on from there.',
      denied: "Notifications are blocked for this site: allow them in the browser's settings, then come back here.",
    },
    kinds: 'What to be told about',
  },
} as const
