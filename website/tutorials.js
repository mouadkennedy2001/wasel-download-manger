// Animated, scene-by-scene tutorials. Every scene is a small mock of the browser or the
// app, re-rendered on each step so its CSS animations (cursor, clicks, progress) replay.
(() => {
  const SCENE_MS = 4600;

  const cursor = (x, y, click = true) => `<span class="m-cursor${click ? ' click' : ''}" style="--x:${x}%;--y:${y}%"></span>`;
  const lights = '<b class="m-lights"><i></i><i></i><i></i></b>';
  const browser = (url, page, extra = '') => `<div class="m-browser">${extra}<div class="m-bar">${lights}<span class="m-url" dir="ltr">${url}</span><span class="m-ext"></span></div><div class="m-page">${page}</div></div>`;
  const row = (name, kind, pct, meta, state = 'run') => `<div class="m-row ${state}"><span class="m-tile k-${kind}"></span><div><b dir="auto">${name}</b><small>${meta}</small><span class="m-bar-track"><span class="m-fill" style="--to:${pct}%"></span></span></div><span class="m-ring"></span></div>`;
  const app = (body, { turbo = false, speed = '0 KB/s' } = {}) => `<div class="m-app"><div class="m-side">${lights}<span class="m-nav on"></span><span class="m-nav"></span><span class="m-nav"></span><span class="m-nav"></span><div class="m-speed${turbo ? ' turbo' : ''}"><b dir="ltr">${speed}</b><span class="m-turbo">Turbo</span><span class="m-graph"></span></div></div><div class="m-main"><div class="m-toolbar"><span class="m-title"></span><span class="m-search"></span><span class="m-add">+</span></div>${body}</div></div>`;
  const sheet = (body) => `<div class="m-scrim"></div><div class="m-sheet">${body}</div>`;
  const toast = (text, tone = '') => `<div class="m-toast ${tone}">${text}</div>`;

  const tracks = [
    {
      id: 'install',
      title: { ar: 'تثبيت واصل', en: 'Install Wasel' },
      scenes: [
        {
          ar: ['نزّل المثبّت', 'اضغط زر «تنزيل لنظام Windows» في هذه الصفحة. يُحفظ الملف في مجلد التنزيلات.'],
          en: ['Download the installer', 'Click “Download for Windows” on this page. The file goes to your Downloads folder.'],
          stage: () => browser('wasel.app', '<div class="m-hero"><span class="m-logo"></span><span class="m-h1"></span><span class="m-cta pulse">Download</span></div>', '<div class="m-chip pop">Wasel-Setup.exe ⬇</div>') + cursor(50, 66)
        },
        {
          ar: ['شغّل المثبّت', 'افتح Wasel-Setup.exe واختر مجلد التثبيت ثم اضغط «تثبيت».'],
          en: ['Run the installer', 'Open Wasel-Setup.exe, choose a folder and press Install.'],
          stage: () => `<div class="m-installer"><div class="m-bar">${lights}<span>Wasel Setup</span></div><span class="m-logo"></span><span class="m-line"></span><span class="m-bar-track wide"><span class="m-fill slow" style="--to:100%"></span></span><span class="m-cta">Install</span></div>` + cursor(70, 78)
        },
        {
          ar: ['إن ظهر تحذير SmartScreen', 'اضغط «More info» ثم «Run anyway». يظهر لأن التطبيق غير موقّع رقميًا بعد.'],
          en: ['If SmartScreen appears', 'Click “More info”, then “Run anyway”. It appears because the app is not code-signed yet.'],
          stage: () => '<div class="m-smart"><b>Windows protected your PC</b><span class="m-line"></span><span class="m-line short"></span><u>More info</u><span class="m-cta ghost">Run anyway</span></div>' + cursor(68, 80)
        },
        {
          ar: ['جاهز!', 'يفتح واصل بالواجهة العربية. ألصق أي رابط لتبدأ.'],
          en: ['Ready!', 'Wasel opens. Paste any link to begin.'],
          stage: () => app('<div class="m-empty"><span class="m-logo"></span><span class="m-line"></span><span class="m-cta">+</span></div>')
        }
      ]
    },
    {
      id: 'download',
      title: { ar: 'تنزيل ملف', en: 'Download a file' },
      scenes: [
        {
          ar: ['انسخ الرابط', 'انسخ رابط الملف من أي موقع (Ctrl+C).'],
          en: ['Copy the link', 'Copy a file link from any website (Ctrl+C).'],
          stage: () => browser('example.com/downloads', '<span class="m-line"></span><span class="m-link sel" dir="ltr">ubuntu-24.04.iso</span><span class="m-line short"></span>') + cursor(36, 52) + toast('Ctrl + C')
        },
        {
          ar: ['ألصقه في واصل', 'اضغط Ctrl+V في أي مكان من واصل. يفحص الرابط ويعرض الاسم والحجم الحقيقيين.'],
          en: ['Paste it into Wasel', 'Press Ctrl+V anywhere in Wasel. It checks the link and shows the real name and size.'],
          stage: () => app(row('ubuntu-24.04.iso', 'archives', 0, '6.1 GB', 'idle')) + sheet('<b class="m-sheet-title">+ ubuntu-24.04.iso</b><span class="m-input type" dir="ltr">https://example.com/ubuntu-24.04.iso</span><span class="m-probe">6.1 GB · ✓</span><span class="m-seg"><i>Auto</i><i>8</i><i>16</i><i>32</i></span><span class="m-cta">⬇</span>') + cursor(78, 82)
        },
        {
          ar: ['يبدأ التنزيل بعدة اتصالات', 'يُقسَّم الملف على 8 اتصالات، وكل اتصال ينهي جزءه يأخذ نصف الجزء الأكبر المتبقي.'],
          en: ['Many connections at once', 'The file is split across 8 connections; each one that finishes takes half of the largest remaining part.'],
          stage: () => app(row('ubuntu-24.04.iso', 'archives', 64, '3.9 GB / 6.1 GB · 9.4 MB/s') + '<div class="m-segments"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>', { speed: '9.4 MB/s' })
        },
        {
          ar: ['شغّل Turbo لأقصى سرعة', 'زر Turbo أسفل الشريط الجانبي: 32 اتصالًا دون حد للسرعة لاستغلال كامل سرعة الإنترنت.'],
          en: ['Turbo for full speed', 'The Turbo button under the sidebar: 32 connections, no speed limit, your full internet speed.'],
          stage: () => app(row('ubuntu-24.04.iso', 'archives', 92, '5.6 GB / 6.1 GB · 38 MB/s'), { turbo: true, speed: '38 MB/s' }) + cursor(17, 82)
        },
        {
          ar: ['اكتمل', 'يصلك إشعار. انقره لفتح المجلد، ويُستأنف أي تنزيل تلقائيًا إن انقطع الاتصال.'],
          en: ['Done', 'A notification appears; click it to open the folder. Interrupted downloads resume automatically.'],
          stage: () => app(row('ubuntu-24.04.iso', 'archives', 100, '6.1 GB · ✓', 'done')) + toast('✓ ubuntu-24.04.iso', 'ok')
        }
      ]
    },
    {
      id: 'browser',
      title: { ar: 'إضافة المتصفح', en: 'Browser extension' },
      scenes: [
        {
          ar: ['افتح إعدادات المتصفح في واصل', 'الإعدادات ← المتصفح، ثم انسخ مسار مجلد الإضافة.'],
          en: ['Open Settings → Browser', 'In Wasel, go to Settings → Browser and copy the extension folder path.'],
          stage: () => app('') + sheet('<b class="m-sheet-title">⚙ Browser</b><span class="m-line"></span><span class="m-input" dir="ltr">…\\browser-extension\\chromium</span><span class="m-cta">Copy</span>') + cursor(78, 72)
        },
        {
          ar: ['حمّل الإضافة', 'افتح chrome://extensions، فعّل «وضع المطوّر»، واضغط «تحميل إضافة غير محزّمة» واختر المجلد.'],
          en: ['Load the extension', 'Open chrome://extensions, turn on Developer mode, click “Load unpacked” and pick the folder.'],
          stage: () => browser('chrome://extensions', '<div class="m-ext-page"><span class="m-toggle on"></span><span class="m-cta ghost">Load unpacked</span><div class="m-card pop"><span class="m-logo small"></span><b>Wasel</b></div></div>') + cursor(30, 34)
        },
        {
          ar: ['نزّل كالعادة من المتصفح', 'اضغط أي رابط تنزيل. تلتقطه الإضافة وترسله إلى واصل مع جلسة تسجيل الدخول.'],
          en: ['Download as usual', 'Click any download link. The extension catches it and sends it to Wasel with your sign-in session.'],
          stage: () => browser('members.site.com/course', '<span class="m-line"></span><span class="m-cta pulse">Download lesson.zip</span><span class="m-line short"></span>') + cursor(50, 50)
        },
        {
          ar: ['أكّد في واصل', 'تظهر نافذة «أُرسل من متصفحك — مع جلسة تسجيل الدخول». اضغط تنزيل.'],
          en: ['Confirm in Wasel', 'Wasel shows “Sent from your browser — your sign-in session is included”. Press Download.'],
          stage: () => app('') + sheet('<b class="m-sheet-title">🔒 lesson.zip</b><span class="m-probe ok">✓ session</span><span class="m-input" dir="ltr">members.site.com/lesson.zip</span><span class="m-cta">⬇</span>') + cursor(78, 82)
        }
      ]
    },
    {
      id: 'anylink',
      title: { ar: 'أي رابط', en: 'Any link' },
      scenes: [
        {
          ar: ['ألصق رابط صفحة', 'ليس عندك رابط مباشر؟ ألصق رابط الصفحة التي فيها الفيديو أو الملف.'],
          en: ['Paste a page link', 'No direct link? Paste the link of the page that contains the video or file.'],
          stage: () => app('') + sheet('<b class="m-sheet-title">+</b><span class="m-input type" dir="ltr">https://videos.site/watch?v=holiday</span><span class="m-probe"><span class="m-spin"></span></span>')
        },
        {
          ar: ['اختر ما تريد', 'يعرض واصل الفيديوهات والبث والملفات الموجودة في الصفحة. الفيديو الرئيسي محدد تلقائيًا.'],
          en: ['Pick what you want', 'Wasel lists the videos, streams and files found on the page. The main video is picked for you.'],
          stage: () => app('') + sheet('<b class="m-sheet-title">3 ×</b><label class="m-check on"><i></i>Holiday 1080p.mp4</label><label class="m-check"><i></i>stream.m3u8</label><label class="m-check"><i></i>notes.pdf</label><span class="m-cta">⬇</span>') + cursor(30, 44)
        },
        {
          ar: ['يُحفظ باسم الصفحة', 'يُسمّى الملف بعنوان الصفحة. روابط البث (m3u8) تُجمع وتُفك تشفيرها في ملف واحد.'],
          en: ['Saved with the page title', 'The file is named after the page. Streams (m3u8) are joined and decrypted into one file.'],
          stage: () => app(row('Holiday Film.mp4', 'video', 100, '412 MB · ✓', 'done') + row('stream.ts', 'video', 58, 'HLS · 6 MB/s'), { speed: '6 MB/s' })
        }
      ]
    }
  ];

  const stage = document.getElementById('stage');
  if (!stage) return;
  let trackIndex = 0;
  let sceneIndex = 0;
  let playing = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null;
  const lang = () => (document.documentElement.lang === 'ar' ? 'ar' : 'en');

  function renderTabs() {
    const tabs = document.getElementById('tutorialTabs');
    tabs.innerHTML = tracks.map((track, index) =>
      `<button type="button" role="tab" aria-selected="${index === trackIndex}" class="${index === trackIndex ? 'active' : ''}" data-track="${index}">${track.title[lang()]}</button>`).join('');
  }

  function render() {
    const track = tracks[trackIndex];
    const scene = track.scenes[sceneIndex];
    const [title, text] = scene[lang()];
    stage.innerHTML = `<div class="scene" data-track="${track.id}">${scene.stage()}</div>`;
    document.getElementById('sceneTitle').textContent = title;
    document.getElementById('sceneText').textContent = text;
    document.getElementById('sceneCount').textContent = `${sceneIndex + 1} / ${track.scenes.length}`;
    document.getElementById('sceneDots').innerHTML = track.scenes.map((_, index) =>
      `<button type="button" class="${index === sceneIndex ? 'active' : ''}" data-scene="${index}" aria-label="${index + 1}"><span style="--d:${SCENE_MS}ms"></span></button>`).join('');
    const play = document.getElementById('scenePlay');
    play.textContent = playing ? '❚❚' : '▶';
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    document.getElementById('tutorial').classList.toggle('playing', playing);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    timer = setTimeout(() => go(1, true), SCENE_MS);
  }

  function go(delta, wrapTrack = false) {
    const track = tracks[trackIndex];
    sceneIndex += delta;
    if (sceneIndex >= track.scenes.length) {
      if (wrapTrack) {
        trackIndex = (trackIndex + 1) % tracks.length;
        renderTabs();
      }
      sceneIndex = 0;
    }
    if (sceneIndex < 0) sceneIndex = track.scenes.length - 1;
    render();
  }

  document.getElementById('tutorialTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-track]');
    if (!button) return;
    trackIndex = Number(button.dataset.track);
    sceneIndex = 0;
    renderTabs();
    render();
  });
  document.getElementById('sceneDots').addEventListener('click', (event) => {
    const button = event.target.closest('[data-scene]');
    if (!button) return;
    sceneIndex = Number(button.dataset.scene);
    render();
  });
  document.getElementById('scenePrev').addEventListener('click', () => go(-1));
  document.getElementById('sceneNext').addEventListener('click', () => go(1));
  document.getElementById('scenePlay').addEventListener('click', () => {
    playing = !playing;
    render();
  });
  // Pause while the player is off screen so it does not advance unseen.
  new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) clearTimeout(timer);
    else schedule();
  }).observe(stage);
  document.addEventListener('wasel:lang', () => {
    renderTabs();
    render();
  });

  renderTabs();
  render();
})();
