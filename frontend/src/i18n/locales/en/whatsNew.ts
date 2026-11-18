// What's new (src/whats-new): the dialog that tells each person what changed since their last visit,
// and the list of every note from the user menu. Each note's own texts live in its JSON file.
export const whatsNew = {
  title: "What's new",
  intro: "Here's what's new since you last came in.",
  allIntro: 'Everything new in the portal, newest first.',
  empty: 'Nothing new yet.',
  gotIt: 'Got it!',
  showMore: { one: 'Show {count} more', other: 'Show {count} more' },
  goThere: 'Take me there',
  // Starts with the visible text (WCAG 2.5.3 Label in Name) and tells the links of several notes apart.
  goThereLabel: 'Take me there: {title}',
  adminsOnly: 'Administrators only',
  /** What kind of change a note is about. */
  kinds: {
    new: 'New',
    improved: 'Improved',
    fixed: 'Fixed',
  },
} as const
