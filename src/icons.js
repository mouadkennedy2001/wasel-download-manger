// Line icons drawn on a 24px grid in the spirit of SF Symbols: rounded caps and joins,
// one stroke weight, optical centering. `mirror` icons flip in right-to-left layouts.
(() => {
  const paths = Object.freeze({
    tray: '<path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5"/><path d="M4 13.5h4.2l1.3 2.2h5l1.3-2.2H20"/><path d="M12 3.5v8.5m-3.5-3.5L12 12l3.5-3.5"/>',
    'arrow-down-circle': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v8.5m-3.5-3.5L12 16l3.5-3.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    'check-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.6"/>',
    alert: '<path d="M10.3 4.6 3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.2M12 16.8h.01"/>',
    film: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
    music: '<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>',
    doc: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z"/><path d="M14 3.5V8h4.5"/>',
    'doc-text': '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8Z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/>',
    archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1.2"/><path d="M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12h4"/>',
    app: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    photo: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m4 17.5 4.6-4.6 3.4 3.4 2.6-2.6 5 5"/>',
    play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l9.6-6.2a.8.8 0 0 0 0-1.4L9.2 5.1a.8.8 0 0 0-1.2.7Z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.8" cy="10.8" r="6"/><path d="m15.4 15.4 4.1 4.1"/>',
    close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
    ellipsis: '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    inspector: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15M16.8 8.5h1.4M16.8 11.5h1.4"/>',
    sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15M5.8 8.5h1.4M5.8 11.5h1.4"/>',
    sort: '<path d="M8 4.5v15m-3.5-3.5L8 19.5l3.5-3.5M16 19.5v-15m-3.5 3.5L16 4.5l3.5 3.5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2.6-1.5L14 2.6h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.6l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3 1 2-3.4Z"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
    'folder-search': '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/><circle cx="11.5" cy="13" r="2.4"/><path d="m13.3 14.8 1.8 1.8"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    trash: '<path d="M4.5 7h15M10 11v6m4-6v6M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/>',
    retry: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2M12 7.8h.01"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5s1.1-6.2 3.5-8.5Z"/>',
    shield: '<path d="M12 20.5s7-3.2 7-9V6.2l-7-2.7-7 2.7v5.3c0 5.8 7 9 7 9Z"/><path d="m9 12 2.2 2.2L15.3 10"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/>',
    bolt: '<path d="M13 3 5.5 13.2H12L11 21l7.5-10.2H12Z"/>',
    gauge: '<path d="M4.4 17.5a8.5 8.5 0 1 1 15.2 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13" r="1.2" fill="currentColor"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    update: '<path d="M12 3.5v10m-4-4 4 4 4-4"/><path d="M4.5 14.5v2a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-2"/>',
    puzzle: '<path d="M9.5 4.5a2 2 0 1 1 4 0V6H17a1.5 1.5 0 0 1 1.5 1.5V11H17a2 2 0 1 0 0 4h1.5v3.5A1.5 1.5 0 0 1 17 20h-3.5v-1.5a2 2 0 1 0-4 0V20H6a1.5 1.5 0 0 1-1.5-1.5V15H6a2 2 0 1 0 0-4H4.5V7.5A1.5 1.5 0 0 1 6 6h3.5Z"/>',
    network: '<rect x="9" y="3.5" width="6" height="5" rx="1.2"/><rect x="3.5" y="15.5" width="6" height="5" rx="1.2"/><rect x="14.5" y="15.5" width="6" height="5" rx="1.2"/><path d="M12 8.5v3.5M6.5 15.5V12h11v3.5"/>',
    'chevron-down': '<path d="m7 10 5 5 5-5"/>',
    chevron: '<path d="m10 6.5 5.5 5.5-5.5 5.5"/>',
    check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
    export: '<path d="M12 15V4m-4 4 4-4 4 4"/><path d="M5.5 13.5v4a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-4"/>',
    import: '<path d="M12 4v11m-4-4 4 4 4-4"/><path d="M5.5 13.5v4a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-4"/>',
    sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>',
    moon: '<path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    power: '<path d="M12 3.5v8"/><path d="M7.1 6.6a7.5 7.5 0 1 0 9.8 0"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
    sparkles: '<path d="M10 3.5 11.6 8 16 9.6 11.6 11.2 10 15.7 8.4 11.2 4 9.6 8.4 8Z"/><path d="m17.5 13.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
    hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15.5M4 15h15.5"/>',
    browser: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18M6.5 6.8h.01M9 6.8h.01"/>',
    clipboard: '<rect x="5.5" y="5" width="13" height="16" rx="2.2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h4"/>',
    download: '<path d="M12 4v11.5m-4.5-4.5 4.5 4.5 4.5-4.5M5 19.5h14"/>',
    wand: '<path d="m4.5 19.5 10-10M13 6l1-2.5L15 6l2.5 1L15 8l-1 2.5L13 8l-2.5-1Z"/>'
  });

  const mirrored = new Set(['chevron', 'external', 'retry']);

  function markup(name, className = 'icon') {
    const path = paths[name];
    if (!path) throw new Error(`Unknown Wasel icon: ${name}`);
    if (!/^[a-zA-Z0-9 _-]*$/.test(className)) throw new Error('Invalid icon class name.');
    const classes = `${className}${mirrored.has(name) ? ' mirror-rtl' : ''}`;
    return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
  }

  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((element) => {
      element.outerHTML = markup(element.dataset.icon, element.className || 'icon');
    });
  }

  window.WaselIcons = Object.freeze({ markup, hydrate, names: Object.keys(paths) });
})();
