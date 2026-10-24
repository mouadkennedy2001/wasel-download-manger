const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const input = $('downloadUrl');
const message = $('message');
const sendButton = $('send');
const captureToggle = $('captureDownloads');
const bridgeDot = $('bridgeDot');
const bridgeText = $('bridgeText');

function setMessage(text, type = '') {
  message.textContent = text;
  message.className = type;
}

function linesOf(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function refreshStatus() {
  try {
    const status = await api.runtime.sendMessage({ type: 'wasel:status' });
    bridgeDot.classList.toggle('on', Boolean(status?.running));
    bridgeText.textContent = status?.running ? 'Connected to Wasel' : 'Wasel is not running';
  } catch {
    bridgeDot.classList.remove('on');
    bridgeText.textContent = 'Wasel is not reachable';
  }
}

async function currentPage() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:\/\//i.test(tab.url)) {
    input.value = tab.url;
    setMessage('The page address is filled in. Edit it or add more links, one per line.');
  } else {
    setMessage('This page cannot be sent. Paste a web link instead.');
  }
}

async function cookiesForPage(url) {
  if (!api.cookies?.getAll) return [];
  try {
    return await api.cookies.getAll({ url });
  } catch {
    return [];
  }
}

sendButton.addEventListener('click', async () => {
  const urls = linesOf(input.value).map((line) => (/^www\./i.test(line) ? `https://${line}` : line));
  const valid = urls.filter((url) => /^https?:\/\/[^\s]+$/i.test(url));
  if (!valid.length) {
    setMessage('Enter at least one http or https link.', 'error');
    return;
  }
  sendButton.disabled = true;
  setMessage('Sending…');
  try {
    const cookies = valid.length === 1 ? await cookiesForPage(valid[0]) : [];
    const payload = {
      urls: valid,
      referer: valid.length === 1 ? valid[0] : '',
      userAgent: navigator.userAgent,
      cookies: cookies.map(({ name, value, domain, path, secure, hostOnly }) => ({ name, value, domain, path, secure, hostOnly })),
      source: 'popup'
    };
    const response = await api.runtime.sendMessage({ type: 'wasel:send', payload });
    if (!response?.ok) throw new Error(response?.error || 'Wasel did not respond.');
    setMessage(valid.length > 1 ? `Sent ${valid.length} links. Confirm them in Wasel.` : 'Sent. Confirm it in Wasel.', 'success');
  } catch (error) {
    setMessage(error.message || 'Could not send the link.', 'error');
  } finally {
    sendButton.disabled = false;
  }
});

captureToggle.addEventListener('change', async () => {
  await api.storage.local.set({ captureBrowserDownloads: captureToggle.checked });
  setMessage(captureToggle.checked ? 'Browser downloads will go to Wasel.' : 'Browser downloads stay in the browser.');
});

api.storage.local.get({ captureBrowserDownloads: true }).then((settings) => {
  captureToggle.checked = settings.captureBrowserDownloads;
});
refreshStatus();
currentPage().catch(() => setMessage('Paste a link to send it.'));
