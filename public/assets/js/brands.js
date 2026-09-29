/* The seven editors. Keyed by the page's folder (<html data-editor="…">); colours live in editor.css.
     mem    the editor's key for the API (/api/menu-state/:mem, bug reports). Must match the
            allowlist in api/menu-state/[editor].mjs.
     mark   a brand mark from /assets/brand/ (see .mark in editor.css), or `text` for a typeset name
     tabs   the menu's pages, as the rail labels them
     pages  the PDF page each tab shows (0-based), when that isn't simply the tab's position
     menu   true once the editor's menu is in place: its folder holds the PDF, fieldmap.json and an
            engine.js that its index.html loads (see editor.js)
     sections  false for a one-section menu (the drinks menus): no section list in the rail */
window.CHUCKY_BRANDS = {
  capiche: {
    mem: 'capiche', name: 'Capiche', mark: 'capiche', tag: 'Menu Editor', menu: true,
    tabs: ['Front', 'Back'], search: 'Search items…', boot: 'Warming up the kitchen…', personalise: true,
  },
  aiko: {
    mem: 'aiko', name: 'Aiko', mark: 'aiko', bootMark: 'aiko-word', tag: 'Menu Editor', menu: true,
    tabs: ['Page 1', 'Page 2'], search: 'Search items…', boot: 'Warming up the kitchen…', personalise: true,
  },
  churnd: {
    mem: 'churnd', name: "Churn'd", text: { label: "Churn'd", cls: 'churnd' }, tag: 'Menu Editor',
    tabs: ['Menu', 'Cover'], search: 'Search flavors…', boot: 'Scooping…',
  },
  beshak: {
    mem: 'beshak', name: 'Beshak', text: { label: 'BESHAK', cls: 'beshak' }, tag: 'Menu Editor', menu: true,
    tabs: ['Page 1', 'Page 2'], search: 'Search items…', boot: 'Warming up the kitchen…',
  },
  drinks: {
    mem: 'aiko-drinks', name: 'Aiko Drinks', mark: 'aiko', tag: 'Drinks Editor', menu: true,
    tabs: ['Menu', 'Cover'], pages: [1, 0], search: 'Search drinks…', boot: 'Chilling the glasses…',
  },
  'capiche-surat': {
    mem: 'capiche-surat', name: 'Capiche Surat Drinks', mark: 'capiche', tag: 'Surat · Drinks', menu: true,
    tabs: ['Page 1'], sections: false, search: 'Search drinks…', boot: 'Chilling the glasses…',
  },
  'capiche-ahm': {
    mem: 'capiche-ahm', name: 'Capiche Ahmedabad Drinks', mark: 'capiche', tag: 'Ahmedabad · Drinks', menu: true,
    tabs: ['Page 1', 'Page 2', 'Page 3'], sections: false, search: 'Search drinks…', boot: 'Chilling the glasses…',
  },
};
