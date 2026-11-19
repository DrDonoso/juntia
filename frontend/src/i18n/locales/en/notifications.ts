// Notifications (src/notifications): the bell at the top of the portal and its panel, and the
// settings in My profile, push notifications on this device included.
export const notifications = {
  title: 'Notifications',
  // The bell's name says how many are unread, as its badge shows.
  bellUnread: { one: 'Notifications: {count} unread', other: 'Notifications: {count} unread' },
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
  },
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
