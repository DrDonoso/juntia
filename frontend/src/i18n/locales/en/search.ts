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
  // The last option of the list, which opens the page with every result.
  seeAll: 'See all results',
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
  // The filters and headings of the page of results.
  plural: {
    action: 'Actions',
    event: 'Events',
    folder: 'Folders',
    file: 'Documents',
    neighbor: 'Neighbors',
    contact: 'Contacts',
    transaction: 'Transactions',
  },
  // The page with every result (search-results.tsx).
  page: {
    eyebrow: 'Search',
    title: 'Results for “{query}”',
    untitled: 'Search results',
    short: 'Type at least two characters in the search box at the top of the page.',
    filters: 'Filter by type',
    all: 'All',
    // Below the best few of a kind, to list them all.
    seeKind: {
      action: 'See all {count} actions',
      event: 'See all {count} events',
      folder: 'See all {count} folders',
      file: 'See all {count} documents',
      neighbor: 'See all {count} neighbors',
      contact: 'See all {count} contacts',
      transaction: 'See all {count} transactions',
    },
  },
} as const
