/* Runs inside Eagle (Electron renderer with Node). Starts the Pocket server and shows how to connect. */
/* global eagle */
'use strict';
(function () {
  const path = require('path');
  const $ = (id) => document.getElementById(id);
  let pocket = null;
  let qrcode = null;
  let starting = null;

  function setStatus(text, kind) {
    $('status').textContent = text;
    $('dot').className = 'dot' + (kind ? ' ' + kind : '');
  }

  function start(plugin) {
    if (starting) return starting;
    starting = (async () => {
      const { createPocketServer } = require(path.join(plugin.path, 'server'));
      qrcode = require(path.join(plugin.path, 'vendor', 'qrcode.js'));
      pocket = createPocketServer({
        libraryPath: eagle.library.path,
        log: (m) => console.log('[pocket]', m),
        // Imports go through Eagle itself so the library stays consistent.
        addItem: ({ path: file, name, folderId }) => eagle.item.addFromPath(file, { name, folders: folderId ? [folderId] : [] }),
      });
      await pocket.start();
      render();
    })().catch((err) => {
      console.error(err);
      setStatus(`Could not start: ${err.message}`, 'bad');
    });
    return starting;
  }

  function currentBase(info) {
    const sel = $('addr').value;
    if (sel === 'custom') {
      const v = $('custom').value.trim().replace(/\/+$/, '');
      return /^https?:\/\/[^\s/]+$/i.test(v) ? v : null;
    }
    return sel ? `http://${sel}:${info.port}` : null;
  }

  function render() {
    if (!pocket) return;
    const info = pocket.info();
    if (info.library) setStatus(`Sharing “${info.library.name}” · ${info.library.count.toLocaleString()} items · port ${info.port}`, 'ok');
    else setStatus(info.libraryError || 'No library open', 'bad');

    const addr = $('addr');
    const previous = addr.value || localStorage.getItem('pocket.addr') || '';
    addr.replaceChildren(
      ...info.addresses.map((a) => new Option(`${a.address}  (${a.kind === 'tailscale' ? 'Tailscale, works anywhere' : 'home network, ' + a.name})`, a.address)),
      new Option('Custom address (for HTTPS)…', 'custom')
    );
    if (Array.from(addr.options).some((o) => o.value === previous)) addr.value = previous;
    $('custom').hidden = addr.value !== 'custom';
    if (!$('custom').value) $('custom').value = localStorage.getItem('pocket.custom') || '';

    const base = currentBase(info);
    const url = base ? `${base}/#k=${info.token}` : '';
    $('url').textContent = url || (info.addresses.length ? 'Enter the address above, e.g. https://my-pc.my-tailnet.ts.net' : 'This PC is not connected to a network.');
    drawQr(url);
  }

  function drawQr(text) {
    const canvas = $('qr');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!text) return;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = Math.floor(canvas.width / n);
    const offset = Math.floor((canvas.width - size * n) / 2);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(offset + c * size, offset + r * size, size, size);
  }

  $('addr').addEventListener('change', () => {
    localStorage.setItem('pocket.addr', $('addr').value);
    render();
  });
  $('custom').addEventListener('input', () => {
    localStorage.setItem('pocket.custom', $('custom').value.trim());
    render();
  });
  $('copy').addEventListener('click', () => {
    const url = $('url').textContent;
    if (!/^https?:/.test(url)) return;
    eagle.clipboard.writeText(url);
    $('copy').textContent = 'Copied';
    setTimeout(() => ($('copy').textContent = 'Copy link'), 1500);
  });
  $('rekey').addEventListener('click', () => {
    if (!pocket || !confirm('Create a new key? Every phone connected so far will have to scan the new code.')) return;
    pocket.regenerateToken();
    render();
  });

  function applyTheme(theme) {
    const t = String(theme || '').toUpperCase();
    document.body.classList.toggle('light', t === 'LIGHT' || t === 'LIGHTGRAY');
  }

  eagle.onPluginCreate((plugin) => {
    applyTheme(eagle.app.theme);
    start(plugin);
  });
  eagle.onPluginShow(render);
  eagle.onThemeChanged(applyTheme);
  eagle.onLibraryChanged(async (libraryPath) => {
    if (!pocket) return;
    setStatus('Switching library…');
    await pocket.setLibrary(libraryPath || eagle.library.path);
    render();
  });
  window.addEventListener('beforeunload', () => pocket && pocket.stop());
})();
