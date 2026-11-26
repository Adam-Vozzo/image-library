'use strict';
/**
 * Reads an Eagle `.library` folder straight from disk and keeps an in-memory
 * index of it. Read-only: nothing in the library is ever written.
 *
 *   <name>.library/
 *     metadata.json                 folders, smart folders, tag groups
 *     images/<ID>.info/
 *       metadata.json               one item
 *       <name>.<ext>                the original file
 *       <name>_thumbnail.png        only for files Eagle made a thumbnail for
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const SCAN_CONCURRENCY = 48;
const WEB_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico', 'apng', 'jfif']);

class Library {
  constructor(libraryPath, { log = () => {} } = {}) {
    this.path = libraryPath;
    this.log = log;
    this.epoch = crypto.randomBytes(6).toString('hex');
    this.rev = 0;
    this.name = path.basename(libraryPath).replace(/\.library$/i, '');
    this.folders = [];
    this.items = new Map(); // id -> { v, rev, hidden, data, dir }
    this.removed = []; // [{ id, rev }]
    this.hiddenFolders = new Set();
    this.lastScan = 0;
    this._sig = '';
    this._scanning = null;
    this._paths = new Map(); // id -> { v, file, thumb }
  }

  get imagesDir() {
    return path.join(this.path, 'images');
  }

  /** Throws a readable error if the path is not an Eagle library. */
  async validate() {
    const st = await fsp.stat(this.imagesDir).catch(() => null);
    const meta = await fsp.stat(path.join(this.path, 'metadata.json')).catch(() => null);
    if (!st || !st.isDirectory() || !meta) {
      throw new Error(`Not an Eagle library (expected metadata.json and images/ inside): ${this.path}`);
    }
  }

  /** Cheap fingerprint of the files Eagle touches on every change. */
  async _signature() {
    const parts = await Promise.all(
      ['metadata.json', 'mtime.json', 'images'].map((f) =>
        fsp.stat(path.join(this.path, f)).then((s) => `${s.mtimeMs}:${s.size}`, () => '-')
      )
    );
    return parts.join('|');
  }

  /**
   * Bring the index up to date. Concurrent callers share one scan.
   * With `force` false the scan is skipped when nothing on disk looks changed.
   */
  refresh({ force = false } = {}) {
    if (this._scanning) return this._scanning;
    this._scanning = this._refresh(force).finally(() => {
      this._scanning = null;
    });
    return this._scanning;
  }

  async _refresh(force) {
    const sig = await this._signature();
    // Editing an item rewrites its own metadata.json and, in Eagle, mtime.json.
    // If neither that nor the folder list moved, trust the index for a while.
    if (!force && sig === this._sig && Date.now() - this.lastScan < 60_000) return false;

    const started = Date.now();
    let changed = false;
    const nextRev = this.rev + 1;

    // Library-level metadata (folders).
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(this.path, 'metadata.json'), 'utf8'));
      const hidden = new Set();
      const folders = cleanFolders(raw.folders || [], hidden, false);
      const json = JSON.stringify(folders);
      if (json !== this._foldersJson) {
        this._foldersJson = json;
        this.folders = folders;
        const hiddenChanged = !sameSet(hidden, this.hiddenFolders);
        this.hiddenFolders = hidden;
        changed = true;
        if (hiddenChanged) {
          // Lock state changed: re-evaluate every item's visibility.
          for (const [id, rec] of this.items) {
            const wasHidden = rec.hidden;
            rec.hidden = this._isHidden(rec.raw);
            if (wasHidden !== rec.hidden) {
              rec.rev = nextRev;
              if (rec.hidden) this.removed.push({ id, rev: nextRev });
            }
          }
        }
      }
    } catch (err) {
      this.log(`Could not read library metadata.json: ${err.message}`);
    }

    // Items.
    let names;
    try {
      names = await fsp.readdir(this.imagesDir);
    } catch (err) {
      this.log(`Could not read images folder: ${err.message}`);
      names = null;
    }
    if (names) {
      const seen = new Set();
      const ids = [];
      for (const n of names) {
        if (n.endsWith('.info')) ids.push(n.slice(0, -5));
      }
      await pool(ids, SCAN_CONCURRENCY, async (id) => {
        const dir = path.join(this.imagesDir, id + '.info');
        const metaPath = path.join(dir, 'metadata.json');
        let st;
        try {
          st = await fsp.stat(metaPath);
        } catch {
          return; // half-imported or broken item; pick it up next scan
        }
        seen.add(id);
        const prev = this.items.get(id);
        if (prev && prev.v === st.mtimeMs) return;
        let raw;
        try {
          raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        } catch {
          return; // being written right now
        }
        const gone = !!raw.isDeleted;
        const hidden = gone || this._isHidden(raw);
        if (hidden && (!prev || prev.hidden)) {
          this.items.set(id, { v: st.mtimeMs, rev: prev ? prev.rev : 0, hidden: true, raw, dir });
          return;
        }
        if (hidden) this.removed.push({ id, rev: nextRev });
        this.items.set(id, { v: st.mtimeMs, rev: nextRev, hidden, raw, dir });
        this._paths.delete(id);
        changed = true;
      });
      for (const [id, rec] of this.items) {
        if (seen.has(id)) continue;
        this.items.delete(id);
        this._paths.delete(id);
        if (!rec.hidden) {
          this.removed.push({ id, rev: nextRev });
          changed = true;
        }
      }
    }

    if (changed) {
      this.rev = nextRev;
      if (this.removed.length > 20_000) {
        // Forget old tombstones; clients older than that get a full resync.
        this.removed = this.removed.slice(-10_000);
        this.minRev = this.removed[0].rev;
      }
    }
    this._sig = sig;
    this.lastScan = Date.now();
    this.log(`Scanned ${this.items.size} items in ${Date.now() - started} ms${changed ? ` (rev ${this.rev})` : ''}`);
    return changed;
  }

  _isHidden(raw) {
    if (!this.hiddenFolders.size || !Array.isArray(raw.folders)) return false;
    return raw.folders.some((f) => this.hiddenFolders.has(f));
  }

  get count() {
    let n = 0;
    for (const rec of this.items.values()) if (!rec.hidden) n++;
    return n;
  }

  /**
   * Everything a client needs to mirror the library.
   * `since` is "<epoch>:<rev>" from a previous call; when it still lines up
   * only the differences are returned.
   */
  snapshot(since) {
    let from = -1;
    if (since) {
      const [epoch, rev] = String(since).split(':');
      const n = Number(rev);
      if (epoch === this.epoch && Number.isInteger(n) && n >= (this.minRev || 0) && n <= this.rev) from = n;
    }
    const full = from < 0;
    const items = [];
    for (const [id, rec] of this.items) {
      if (rec.hidden) continue;
      if (full || rec.rev > from) items.push(compact(id, rec));
    }
    return {
      stamp: `${this.epoch}:${this.rev}`,
      full,
      library: { name: this.name, folders: this.folders },
      items,
      removed: full ? [] : this.removed.filter((r) => r.rev > from).map((r) => r.id),
    };
  }

  /** Locate the original file and thumbnail for an item (cached per version). */
  async resolve(id) {
    const rec = this.items.get(id);
    if (!rec || rec.hidden) return null;
    const cached = this._paths.get(id);
    if (cached && cached.v === rec.v) return cached;

    const { raw, dir } = rec;
    const ext = String(raw.ext || '').toLowerCase();
    let file = null;
    let thumb = null;
    const guessFile = path.join(dir, `${raw.name}.${raw.ext}`);
    const guessThumb = path.join(dir, `${raw.name}_thumbnail.png`);
    const [hasFile, hasThumb] = await Promise.all([exists(guessFile), exists(guessThumb)]);
    if (hasFile) file = guessFile;
    if (hasThumb) thumb = guessThumb;
    if (!file || !thumb) {
      // Names can be sanitised on disk; fall back to looking in the folder.
      const names = await fsp.readdir(dir).catch(() => []);
      for (const n of names) {
        if (n === 'metadata.json') continue;
        if (/_thumbnail\.(png|jpe?g|webp)$/i.test(n)) {
          if (!thumb) thumb = path.join(dir, n);
        } else if (!file && (!ext || n.toLowerCase().endsWith('.' + ext))) {
          file = path.join(dir, n);
        }
      }
    }
    if (!thumb && file && WEB_IMAGE_EXTS.has(ext)) thumb = file;
    const out = { v: rec.v, file, thumb, name: raw.name, ext };
    this._paths.set(id, out);
    return out;
  }
}

/** Strip folder records down to what the phone needs; drop locked folders. */
function cleanFolders(list, hidden, parentHidden) {
  const out = [];
  for (const f of list) {
    if (!f || !f.id) continue;
    const locked = parentHidden || !!f.password;
    if (locked) {
      hidden.add(f.id);
      cleanFolders(f.children || [], hidden, true);
      continue;
    }
    const node = { id: f.id, name: String(f.name || 'Untitled') };
    if (f.iconColor) node.color = f.iconColor;
    const children = cleanFolders(f.children || [], hidden, false);
    if (children.length) node.children = children;
    out.push(node);
  }
  return out;
}

/** Short keys: this array is the bulk of what goes over the wire. */
function compact(id, rec) {
  const m = rec.raw;
  const o = {
    id,
    n: String(m.name || ''),
    e: String(m.ext || '').toLowerCase(),
    t: m.modificationTime || m.btime || m.mtime || 0,
    v: Math.round(rec.v),
  };
  if (m.width) o.w = m.width;
  if (m.height) o.h = m.height;
  if (m.size) o.s = m.size;
  if (m.btime) o.b = m.btime;
  if (Array.isArray(m.tags) && m.tags.length) o.g = m.tags;
  if (Array.isArray(m.folders) && m.folders.length) o.f = m.folders;
  if (m.star) o.r = m.star;
  if (m.url) o.u = m.url;
  if (m.annotation) o.a = m.annotation;
  if (m.duration) o.d = Math.round(m.duration);
  const p = Array.isArray(m.palettes) && m.palettes[0];
  if (p && Array.isArray(p.color)) o.c = p.color.map((x) => (x & 255).toString(16).padStart(2, '0')).join('');
  return o;
}

async function pool(list, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  });
  await Promise.all(workers);
}

function exists(p) {
  return fsp.access(p).then(() => true, () => false);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

module.exports = { Library, WEB_IMAGE_EXTS };
