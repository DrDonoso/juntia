// Static demo (src/demo): banner, welcome dialog, sign-in help and the start error.
export const demo = {
  banner: {
    label: 'About this demo',
    text: 'Demo · synthetic data · changes are lost on reload',
    source: 'Source code on GitHub',
    sourceLabel: 'Source code on GitHub (opens in a new tab)',
  },
  welcome: {
    title: 'Welcome to the Juntia demo',
    intro: "Juntia is the private portal of a residents' community: shared finances from the bank statements, community actions and events, neighbors and contacts.",
    data: 'Everything here is synthetic data that lives in your browser. Change whatever you like: reloading the page starts the demo again.',
    signedIn: 'You are signed in as {name}, a neighbor at {community}. The administration is one click away too.',
    neighbor: 'Explore as a neighbor',
    admin: 'Open administration',
    openingAdmin: 'Opening administration…',
  },
  signIn: {
    resident: 'Demo: sign in as <strong>{email}</strong> with the password <strong>{password}</strong>. Every active neighbor of the demo uses the same password.',
    admin: 'Demo: sign in with the username <strong>{username}</strong> and the password <strong>{password}</strong>.',
  },
  startError: {
    title: 'The demo could not start',
    description: 'This demo runs entirely in your browser and needs service workers. Open it over HTTPS in a regular (not private) window of an up-to-date browser.',
  },
} as const
