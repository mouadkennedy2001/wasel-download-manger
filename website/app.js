// Language toggle (Arabic is authored in the HTML; English lives here) and a download
// button that always points at the newest installer published on GitHub.
(() => {
  const REPO = 'mouadkennedy2001/wasel-download-manger';
  const english = {
    brand: 'Wasel',
    'nav.features': 'Features',
    'nav.browser': 'Browser',
    'nav.faq': 'FAQ',
    'cta.download': 'Download',
    'cta.downloadWindows': 'Download for Windows',
    'cta.learn': 'Learn more',
    'hero.title': 'Downloads. Beautifully.',
    'hero.lead': 'A fast, free download manager for Windows. Downloads any link — even page and stream links — with 32 connections in Turbo mode, resumes on its own, and works with your browser.',
    'nav.learn': 'Tutorials',
    'learn.eyebrow': 'Tutorials',
    'learn.title': 'Learn Wasel in a minute.',
    'learn.body': 'Animated step-by-step tutorials. Pick one and it plays by itself, or step through the scenes yourself.',
    'help.title': 'Troubleshooting',
    'help.q1': 'Windows (SmartScreen) warns me during install',
    'help.a1': 'The app is not code-signed yet. Click “More info”, then “Run anyway” — only if you downloaded it from this page or the official releases page.',
    'help.q2': 'A site refuses the download (403 or 401)',
    'help.a2': 'The site needs your signed-in session. Install the extension and start the download from the browser; it sends your cookies to Wasel.',
    'help.q3': 'I pasted a page link, not a file link',
    'help.a3': 'No problem. Wasel opens the page and lists the videos and files on it so you can pick, or downloads the main video automatically.',
    'help.q4': 'Downloads are slow',
    'help.a4': 'Turn on Turbo at the bottom of the sidebar: 32 connections per file with no speed limit. Some servers cap connections; Wasel adapts automatically.',
    'help.q5': 'I closed the window and Wasel disappeared',
    'help.a5': 'Wasel keeps running in the tray near the clock and downloads continue. Click its icon to bring it back, or choose “Quit Wasel” from its menu.',
    'help.q6': 'Automatic updates never arrive',
    'help.a6': 'Automatic updates work from version 2 on. Install this version manually once; after that, updates arrive by themselves.',
    'footer.assistant': 'Assistant developer:',
    'speed.eyebrow': 'Speed',
    'speed.title': 'Every connection works to the last byte.',
    'speed.body': 'Wasel splits files dynamically: when a connection finishes its part, it takes half of the largest remaining one, so no connection sits idle. The file is written in place — no merge step.',
    'speed.stat1': 'connections per file in Turbo',
    'speed.stat2': 'simultaneous downloads',
    'speed.stat3': 'merge steps',
    'reliable.eyebrow': 'Reliability',
    'reliable.title': 'The connection drops. The download carries on.',
    'reliable.body': 'Automatic retries resume where they stopped, even after a restart. Wasel recognises expired links and sign-in pages instead of saving them as broken files.',
    'reliable.c1t': 'Works where others fail',
    'reliable.c1': 'Identifies as a modern browser, keeps cookies across redirects, and trusts Windows certificates.',
    'reliable.c2t': 'Real file names',
    'reliable.c2': 'Reads the actual name from the server — Arabic names included — instead of “download.php”.',
    'reliable.c3t': 'Verified files',
    'reliable.c3': 'Paste a SHA-256 or MD5 checksum and Wasel verifies the file when it finishes.',
    'browser.eyebrow': 'Browser',
    'browser.title': 'From your browser to Wasel, session included.',
    'browser.body': 'An extension for Chrome, Edge, Brave and Firefox captures downloads and sends them with cookies and the referring page, so even sign-in-protected downloads work. Everything stays on your computer.',
    'more.eyebrow': 'And more',
    'more.title': 'Designed to stay out of your way.',
    'more.f1t': 'Schedule',
    'more.f1': 'Start the queue at night, pause it in the morning, shut down when done.',
    'more.f2t': 'Speed limit',
    'more.f2': 'One limit across all downloads keeps browsing smooth.',
    'more.f3t': 'Clipboard watch',
    'more.f3': 'Copy a link to a file and Wasel offers to download it.',
    'more.f4t': 'Numbered series',
    'more.f4': 'Add file[1-50].jpg in one go.',
    'more.f5t': 'Proxy',
    'more.f5': 'Uses the system proxy automatically, or set your own.',
    'more.f6t': 'Light & dark',
    'more.f6': 'Follows your system, with eight accent colors.',
    'faq.title': 'Questions',
    'faq.q1': 'Is Wasel free?',
    'faq.a1': 'Yes — completely free and open source, with no ads and no tracking.',
    'faq.q2': 'Why did some sites fail in earlier versions?',
    'faq.a2': 'Older versions sent requests without a browser identity or cookies, so many sites refused them. Version 2 fixes this, and the extension forwards your sign-in session.',
    'faq.q3': 'How do I update?',
    'faq.a3': 'From version 2 on, Wasel updates itself. If you have 1.2 or older, install this version once over the old one — your download list is kept.',
    'faq.q4': 'Does Wasel send my data anywhere?',
    'faq.a4': 'No. The extension only talks to Wasel on your computer. Checking for updates is the only connection to GitHub.',
    'download.title': 'Ready when you are.',
    'download.body': 'Windows 10 and 11, 64-bit. Completely free.',
    'footer.made': 'Made by Zerouki Ahmed Mouad.',
    'footer.report': 'Report a problem',
    'footer.releases': 'Releases'
  };
  const metaText = {
    ar: (version, size) => `الإصدار ${version}${size ? ` · ${size}` : ''}`,
    en: (version, size) => `Version ${version}${size ? ` · ${size}` : ''}`
  };

  const nodes = [...document.querySelectorAll('[data-i18n]')];
  const arabic = new Map(nodes.map((node) => [node, node.textContent]));
  let release = null;
  let language = 'ar';
  try {
    language = localStorage.getItem('wasel.site.lang') || (navigator.language?.startsWith('ar') ? 'ar' : 'en');
  } catch {
    language = navigator.language?.startsWith('ar') ? 'ar' : 'en';
  }

  function apply() {
    const isArabic = language === 'ar';
    document.documentElement.lang = isArabic ? 'ar' : 'en';
    document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
    document.title = isArabic ? 'واصل — مدير التنزيلات' : 'Wasel — Download Manager';
    for (const node of nodes) node.textContent = isArabic ? arabic.get(node) : english[node.dataset.i18n] ?? arabic.get(node);
    document.getElementById('langToggle').textContent = isArabic ? 'English' : 'العربية';
    const suffix = isArabic ? 'light-ara' : 'dark-eng';
    document.getElementById('heroShot').src = `assets/screens/main-${suffix}.png`;
    document.getElementById('addShot').src = `assets/screens/add-${suffix}.png`;
    renderRelease();
    document.dispatchEvent(new CustomEvent('wasel:lang'));
  }

  function formatSize(bytes) {
    return bytes ? `${(bytes / 1024 / 1024).toFixed(0)} MB` : '';
  }

  function renderRelease() {
    if (!release) return;
    const text = metaText[language === 'ar' ? 'ar' : 'en'](release.version, formatSize(release.size));
    document.getElementById('downloadMeta').textContent = text;
    document.getElementById('heroVersion').textContent = text;
  }

  document.getElementById('langToggle').addEventListener('click', () => {
    language = language === 'ar' ? 'en' : 'ar';
    try {
      localStorage.setItem('wasel.site.lang', language);
    } catch {
      // Language preference is optional.
    }
    apply();
  });

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const asset = data?.assets?.find((entry) => /\.exe$/i.test(entry.name));
      if (!asset) return;
      release = { version: data.tag_name.replace(/^v/, ''), size: asset.size };
      for (const id of ['downloadButton', 'heroDownload']) document.getElementById(id).href = asset.browser_download_url;
      renderRelease();
    })
    .catch(() => {});

  apply();
})();
