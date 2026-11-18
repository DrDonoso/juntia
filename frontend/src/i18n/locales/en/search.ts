// The search box at the top of every page (search.tsx): actions, events, documents, neighbors,
// contacts and transactions at once.
export const search = {
  label: 'Search the portal',
  placeholder: 'Search actions, events, documents, people…',
  // The magnifier that opens the search on narrow screens, and closes it.
  open: 'Search',
  close: 'Close the search',
  results: 'Search results',
  loading: 'Searching…',
  count: { zero: 'No results', one: '{count} result', other: '{count} results' },
  empty: 'Nothing matches “{query}”.',
  more: 'Only the best matches are shown. Add words to narrow the search.',
  // The box on the right of each result.
  kinds: {
    action: 'Action',
    event: 'Event',
    folder: 'Folder',
    file: 'Document',
    neighbor: 'Neighbor',
    contact: 'Contact',
    transaction: 'Transaction',
  },
  // Before the words found in a comment, a PDF's name, labels or tags, rather than in the title.
  sources: {
    comment: 'Comment:',
    attachment: 'PDF:',
    labels: 'Labels:',
    tags: 'Tags:',
  },
  dwelling: 'Dwelling {label}',
} as const
