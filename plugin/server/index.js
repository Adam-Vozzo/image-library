'use strict';
/**
 * Pocket server: serves the phone web app plus a small authenticated API over
 * an Eagle library. No dependencies, so it runs unchanged inside an Eagle
 * plugin (Electron) or from plain Node.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Library } = require('./library');

const DEFAULT_PORT = 41600;
const COOKIE = 'pocket';
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', apng: 'image/apng', heic: 'image/heic', tif: 'image/tiff',
  tiff: 'image/tiff', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  ogg: 'audio/ogg', flac: 'audio/flac', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
// Types a browser would execute if opened directly; always sent as downloads.
const ACTIVE_TYPES = new Set(['html', 'htm', 'xhtml', 'svg', 'xml', 'js', 'mjs']);

function createPocketServer(options = {}) {
  const log = options.log || (() => {});
  const configDir = options.configDir || path.join(os.homedir(), '.eagle-pocket');
  const configPath = path.join(configDir, 'config.json');
  const uploadDir = path.join(os.tmpdir(), 'eagle-pocket-uploads');
  const addItem = options.addItem || addViaEagleApi;

  let config = loadConfig();
  let library = null;
  let libraryError = null;
  let server = null;
  let watcher = null;
  let watchTimer = null;
  let pairFailures = [];

  function loadConfig() {
    let c = {};
    try {
      c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {}
    if (!/^[0-9a-f]{32}$/.test(c.token || '')) c.token = crypto.randomBytes(16).toString('hex');
    if (options.port) c.port = options.port;
    if (!Number.isInteger(c.port)) c.port = DEFAULT_PORT;
    return c;
  }

  function saveConfig() {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (err) {
      log(`Could not save config: ${err.message}`);
    }
  }

  const sessionValue = () => crypto.createHash('sha256').update('pocket-session:' + config.token).digest('hex');

  function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  function authed(req) {
    const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([0-9a-f]+)').exec(req.headers.cookie || '');
    return !!m && safeEqual(m[1], sessionValue());
  }

  async function setLibrary(libraryPath) {
    if (watcher) watcher.close();
    watcher = null;
    library = null;
    libraryError = null;
    if (!libraryPath) {
      libraryError = 'No library selected';
      return;
    }
    const lib = new Library(libraryPath, { log });
    try {
      await lib.validate();
      library = lib;
      await lib.refresh({ force: true });
    } catch (err) {
      library = null;
      libraryError = err.message;
      log(err.message);
      return;
    }
    try {
      // Eagle rewrites files in the library root on every change.
      watcher = fs.watch(libraryPath, () => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => lib.refresh({ force: true }).catch(() => {}), 1500);
      });
      watcher.on('error', () => {});
    } catch {}
  }

  // ---- responses -----------------------------------------------------------

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  }

  function sendJson(req, res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    const headers = { 'Content-Type': MIME.json };
    if (buf.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      zlib.gzip(buf, (err, gz) => {
        if (err) return send(res, status, buf, headers);
        send(res, status, gz, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      });
    } else {
      send(res, status, buf, headers);
    }
  }

  /** Stream a file with Range support (needed for video on phones). */
  async function sendFile(req, res, filePath, { type, cache, download }) {
    let st;
    try {
      st = await fsp.stat(filePath);
    } catch {
      return send(res, 404, 'Not found');
    }
    if (!st.isFile()) return send(res, 404, 'Not found');
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': type || 'application/octet-stream',
      'Cache-Control': cache,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag,
    };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0 && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), end);
      } else {
        start = Math.max(0, st.size - Number(range[2]));
      }
      if (start > end || start >= st.size) {
        return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---- routes --------------------------------------------------------------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    const method = req.method;

    if (p.startsWith('/api/') || p.startsWith('/thumb/') || p.startsWith('/file/')) {
      if (p === '/api/pair' && method === 'POST') return pair(req, res);
      if (!authed(req)) return sendJson(req, res, 401, { error: 'unpaired' });
      // Cookies ride along on cross-site form posts; a custom header does not.
      if (method !== 'GET' && method !== 'HEAD' && req.headers['x-pocket'] !== '1') {
        return sendJson(req, res, 403, { error: 'forbidden' });
      }
      if (p === '/api/unpair' && method === 'POST') {
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
        return sendJson(req, res, 200, { ok: true });
      }
      if (!library) return sendJson(req, res, 503, { error: 'no-library', message: libraryError });

      if (p === '/api/index' && method === 'GET') {
        await library.refresh().catch(() => {});
        const snap = library.snapshot(url.searchParams.get('since'));
        snap.canUpload = true;
        return sendJson(req, res, 200, snap);
      }
      if (p === '/api/upload' && method === 'POST') return upload(req, res, url);

      const m = /^\/(thumb|file)\/([A-Za-z0-9_-]+)$/.exec(p);
      if (m && (method === 'GET' || method === 'HEAD')) {
        const found = await library.resolve(m[2]);
        const target = found && (m[1] === 'thumb' ? found.thumb : found.file);
        if (!target) return send(res, 404, 'Not found');
        const ext = path.extname(target).slice(1).toLowerCase();
        const active = ACTIVE_TYPES.has(ext) && ext !== 'svg';
        const download = m[1] === 'file' && (url.searchParams.has('dl') || active || !MIME[ext]);
        // An SVG renders fine inside <img>, but opened as a page it could run
        // script on this origin; the sandbox policy takes that away.
        if (ext === 'svg') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
        return sendFile(req, res, target, {
          type: active ? 'application/octet-stream' : MIME[ext],
          cache: url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
          download: download ? `${found.name}.${found.ext}` : null,
        });
      }
      return sendJson(req, res, 404, { error: 'not-found' });
    }

    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, p);
  }

  async function serveStatic(req, res, p) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.resolve(WEB_DIR, rel);
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) return send(res, 404, 'Not found');
    const ext = path.extname(file).slice(1).toLowerCase();
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return send(res, 404, 'Not found');
    }
    // Lock the app down: only same-origin code, no third-party requests.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The shell is tiny; always revalidate so app updates land immediately.
    return sendFile(req, res, file, { type: MIME[ext], cache: 'no-cache' });
  }

  async function pair(req, res) {
    const now = Date.now();
    pairFailures = pairFailures.filter((t) => now - t < 5 * 60_000);
    if (pairFailures.length >= 20) return sendJson(req, res, 429, { error: 'too-many-attempts' });
    let body;
    try {
      body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
    } catch {
      return sendJson(req, res, 400, { error: 'bad-request' });
    }
    const key = String((body && body.key) || '').trim().toLowerCase();
    if (!safeEqual(key, config.token)) {
      pairFailures.push(now);
      return sendJson(req, res, 401, { error: 'wrong-key' });
    }
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${sessionValue()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
    return sendJson(req, res, 200, { ok: true });
  }

  async function upload(req, res, url) {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return sendJson(req, res, 413, { error: 'too-large' });
    const original = path.basename(String(url.searchParams.get('name') || 'upload')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    const safe = original.replace(/^\.+/, '') || 'upload';
    const folderId = /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('folder') || '') ? url.searchParams.get('folder') : null;
    await cleanUploads();
    const dir = path.join(uploadDir, crypto.randomBytes(8).toString('hex'));
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safe);
    let size = 0;
    try {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) req.destroy(new Error('too large'));
      });
      await pipeline(req, fs.createWriteStream(dest));
      if (!size) throw new Error('empty upload');
      const name = safe.replace(/\.[^.]+$/, '');
      await addItem({ path: dest, name, folderId });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      log(`Upload failed: ${err.message}`);
      return sendJson(req, res, 502, { error: 'upload-failed', message: err.message });
    }
    // Eagle copies the file in the background; the temp copy is swept later.
    setTimeout(() => library && library.refresh({ force: true }).catch(() => {}), 2500);
    return sendJson(req, res, 200, { ok: true });
  }

  async function cleanUploads() {
    const names = await fsp.readdir(uploadDir).catch(() => []);
    for (const n of names) {
      const p = path.join(uploadDir, n);
      const st = await fsp.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 60 * 60_000) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  async function start() {
    await setLibrary(options.libraryPath);
    server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        log(`Request failed: ${err.stack || err}`);
        if (!res.headersSent) send(res, 500, 'Server error');
        else res.destroy();
      });
    });
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host || '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    let port = config.port;
    for (let attempt = 0; ; attempt++) {
      try {
        await tryListen(port);
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || attempt >= 10 || options.port) throw err;
        port++;
      }
    }
    config.port = server.address().port;
    saveConfig();
    log(`Listening on port ${config.port}`);
    return info();
  }

  async function stop() {
    if (watcher) watcher.close();
    clearTimeout(watchTimer);
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections && server.closeAllConnections();
      });
    }
    server = null;
  }

  function info() {
    const addresses = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const o = a.address.split('.').map(Number);
        const tailscale = o[0] === 100 && o[1] >= 64 && o[1] <= 127;
        const linkLocal = o[0] === 169 && o[1] === 254;
        if (linkLocal) continue;
        addresses.push({ name, address: a.address, kind: tailscale ? 'tailscale' : 'lan' });
      }
    }
    addresses.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'lan' ? -1 : 1));
    return {
      port: config.port,
      token: config.token,
      addresses,
      links: addresses.map((a) => ({ ...a, url: `http://${a.address}:${config.port}/#k=${config.token}` })),
      library: library ? { name: library.name, path: library.path, count: library.count } : null,
      libraryError,
    };
  }

  /** New pairing key: every phone paired so far is signed out. */
  function regenerateToken() {
    config.token = crypto.randomBytes(16).toString('hex');
    saveConfig();
    return info();
  }

  return { start, stop, setLibrary, info, regenerateToken, get library() { return library; } };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Default importer: hand the file to the running Eagle app over its local API. */
function addViaEagleApi({ path: filePath, name, folderId }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ path: filePath, name, ...(folderId ? { folderId } : {}) });
    const req = http.request(
      {
        host: '127.0.0.1', port: 41595, path: '/api/item/addFromPath', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15_000,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            if (JSON.parse(text).status === 'success') return resolve();
          } catch {}
          reject(new Error(`Eagle refused the import (${res.statusCode})`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Eagle did not answer')));
    req.on('error', () => reject(new Error('Eagle is not running on this PC, so the upload could not be imported')));
    req.end(body);
  });
}

module.exports = { createPocketServer, DEFAULT_PORT };
