/* Pocket for Eagle: phone client. No build step, no dependencies. */
(function () {
  'use strict';
  const Q = window.PocketQuery;
  const $ = (id) => document.getElementById(id);

  const ICON = {
    menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v7m0 0 3-3m-3 3-3-3M8.5 17h7"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // only ever used with ICON constants
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...clean(kids));
    return el;
  }
  /** Children may be nested arrays or skipped with null/false. */
  const clean = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '');
  const put = (el, ...kids) => el.replaceChildren(...clean(kids));

  const fmtCount = (n) => n.toLocaleString();
  function fmtSize(b) {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
  }
  function fmtDuration(s) {
    const m = Math.floor(s / 60);
    const hh = Math.floor(m / 60);
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  const thumbUrl = (it) => `/thumb/${it.id}?v=${it.v}`;
  const fileUrl = (it) => `/file/${it.id}?v=${it.v}`;

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---- tiny key/value store on IndexedDB ------------------------------------
  const db = {
    open() {
      if (!this._p) {
        this._p = new Promise((resolve, reject) => {
          const r = indexedDB.open('pocket', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      }
      return this._p;
    },
    async get(key) {
      const d = await this.open();
      return new Promise((resolve, reject) => {
        const r = d.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async set(key, value) {
      const d = await this.open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  // ---- state ----------------------------------------------------------------
  const saved = JSON.parse(localStorage.getItem('pocket.view') || '{}');
  const state = {
    items: [],
    byId: new Map(),
    library: { name: 'Library', folders: [] },
    folders: new Map(),
    stamp: null,
    online: true,
    canUpload: false,
    view: { folder: 'all', tag: null, q: '', kind: '', star: 0, sort: saved.sort || 'added', desc: saved.desc !== false, seed: 1 },
    cols: saved.cols || 3,
    results: [],
    pins: new Set(),
    openFolders: new Set(),
  };
  const canCache = 'caches' in window && window.isSecureContext;
  const PIN_CACHE = 'pocket-pinned';

  // ---- sync -----------------------------------------------------------------
  let syncing = false;
  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      let r;
      try {
        r = await fetch('/api/index' + (state.stamp ? '?since=' + encodeURIComponent(state.stamp) : ''));
      } catch {
        setOnline(false);
        return;
      }
      if (r.status === 401) return showPair();
      if (r.status === 503) {
        setOnline(false, 'Eagle library unavailable');
        return;
      }
      if (!r.ok) return setOnline(false);
      apply(await r.json());
      setOnline(true);
    } finally {
      syncing = false;
    }
  }

  function apply(data) {
    let changed = false;
    if (data.full) {
      state.items = data.items;
      changed = true;
    } else if (data.items.length || data.removed.length) {
      const map = new Map(state.items.map((it) => [it.id, it]));
      for (const id of data.removed) map.delete(id);
      for (const it of data.items) map.set(it.id, it);
      state.items = Array.from(map.values());
      changed = true;
    }
    if (JSON.stringify(data.library) !== JSON.stringify(state.library)) changed = true;
    state.library = data.library;
    state.stamp = data.stamp;
    state.canUpload = !!data.canUpload;
    if (!changed) return;
    derive();
    prunePins();
    db.set('index', { stamp: state.stamp, library: state.library, items: state.items }).catch(() => {});
    refresh({ keepScroll: true });
  }

  function derive() {
    state.byId = new Map(state.items.map((it) => [it.id, it]));
    state.folders = Q.indexFolders(state.library.folders);
    const f = state.view.folder;
    if (!['all', 'uncategorized', 'untagged', 'offline'].includes(f) && !state.folders.has(f)) state.view.folder = 'all';
  }

  function setOnline(on, why) {
    state.online = on;
    $('lib-status').textContent = on
      ? `${fmtCount(state.items.length)} items · connected`
      : `${fmtCount(state.items.length)} items · ${why || 'offline'}`;
  }

  // ---- pairing --------------------------------------------------------------
  async function pairWith(raw) {
    const m = /([0-9a-f]{32})/i.exec(raw || '');
    if (!m) return false;
    try {
      const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: m[1] }) });
      if (r.status === 429) $('pair-msg').textContent = 'Too many attempts. Wait a few minutes and try again.';
      return r.ok;
    } catch {
      return false;
    }
  }
  function showPair() {
    $('pair').hidden = false;
  }
  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await pairWith($('pair-key').value)) {
      $('pair').hidden = true;
      sync();
    } else {
      $('pair-msg').textContent = 'That key did not work. Open the Pocket plugin in Eagle and scan its QR code again.';
    }
  });

  // ---- grid -----------------------------------------------------------------
  const grid = $('grid');
  const cells = new Map();
  let geom = { cell: 0, step: 0 };
  const GAP = 2;

  function titleOf(view) {
    if (view.folder === 'uncategorized') return 'Uncategorized';
    if (view.folder === 'untagged') return 'Untagged';
    if (view.folder === 'offline') return 'Kept offline';
    const f = state.folders.get(view.folder);
    return f ? f.name : 'All items';
  }

  function refresh({ keepScroll = false } = {}) {
    const v = state.view;
    const opts = { ...v, folder: v.folder === 'offline' ? 'all' : v.folder, ids: v.folder === 'offline' ? state.pins : null };
    state.results = Q.query(state.items, state.folders, opts);
    $('title').textContent = v.q ? `“${v.q}”` : titleOf(v);
    const n = state.results.length;
    $('subtitle').textContent = `${fmtCount(n)} item${n === 1 ? '' : 's'}${v.q && v.folder !== 'all' ? ' in ' + titleOf(v) : ''}`;
    $('lib-name').textContent = state.library.name;
    setOnline(state.online);

    const tagChip = $('chip-tag');
    tagChip.hidden = !v.tag;
    tagChip.className = 'chip on';
    tagChip.textContent = v.tag ? `# ${v.tag}  ✕` : '';
    $('sel-sort').value = `${v.sort}:${v.desc ? 1 : 0}`;
    $('sel-kind').parentElement.classList.toggle('on', !!v.kind);
    $('sel-star').parentElement.classList.toggle('on', !!v.star);
    updatePinChip();

    const empty = $('empty');
    empty.hidden = n > 0;
    if (!n) {
      empty.replaceChildren(
        h('b', null, state.items.length ? 'Nothing here' : 'No items yet'),
        state.items.length ? 'Try a different folder, tag or search.' : state.online ? 'Waiting for the library…' : 'Connect to your PC to load the library.'
      );
    }
    for (const el of cells.values()) el.remove();
    cells.clear();
    if (!keepScroll) window.scrollTo(0, 0);
    layout();
    if (viewer.open) viewerResync();
    localStorage.setItem('pocket.view', JSON.stringify({ sort: v.sort, desc: v.desc, cols: state.cols }));
  }

  function layout() {
    const w = grid.clientWidth || window.innerWidth;
    const cols = state.cols;
    const cell = (w - GAP * (cols - 1)) / cols;
    const reflow = cell !== geom.cell;
    geom = { cell, step: cell + GAP };
    grid.style.height = Math.max(0, Math.ceil(state.results.length / cols) * geom.step - GAP) + 'px';
    if (reflow) {
      for (const el of cells.values()) el.remove();
      cells.clear();
    }
    draw();
  }

  function draw() {
    const n = state.results.length;
    if (!n) return;
    const cols = state.cols;
    const top = -grid.getBoundingClientRect().top;
    const vh = window.innerHeight;
    const first = Math.max(0, Math.floor((top - vh) / geom.step) * cols);
    const last = Math.min(n, Math.ceil((top + 2 * vh) / geom.step) * cols);
    for (const [i, el] of cells) {
      if (i < first || i >= last) {
        el.remove();
        cells.delete(i);
      }
    }
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      if (cells.has(i)) continue;
      const el = makeCell(state.results[i], i);
      cells.set(i, el);
      frag.append(el);
    }
    grid.append(frag);
  }

  function makeCell(it, i) {
    const cols = state.cols;
    const x = (i % cols) * geom.step;
    const y = Math.floor(i / cols) * geom.step;
    const el = h('button', {
      class: 'cell', role: 'listitem', 'data-i': i, 'aria-label': it.n,
      style: { width: geom.cell + 'px', height: geom.cell + 'px', transform: `translate(${x}px,${y}px)`, background: it.c ? '#' + it.c : '' },
    });
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    img.onload = () => img.classList.add('ok');
    img.onerror = () => img.replaceWith(h('span', { class: 'ext' }, it.e || 'file'));
    img.src = thumbUrl(it);
    el.append(img);
    const kind = Q.kindOf(it);
    const badge = it.d ? fmtDuration(it.d) : kind === 'gif' ? 'GIF' : kind === 'video' ? 'VIDEO' : null;
    if (badge) el.append(h('span', { class: 'badge' }, badge));
    if (state.pins.has(it.id)) el.append(h('span', { class: 'pin' }));
    return el;
  }

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      draw();
    });
  }, { passive: true });
  window.addEventListener('resize', () => {
    layout();
    if (viewer.open) placePanes();
  });
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) openViewer(Number(cell.dataset.i));
  });

  // ---- overlays share the back button ---------------------------------------
  const overlays = [];
  function pushOverlay(close) {
    overlays.push(close);
    history.pushState({ overlay: overlays.length }, '');
  }
  window.addEventListener('popstate', (e) => {
    // One navigation can step back over several overlays at once.
    const depth = (e.state && e.state.overlay) || 0;
    while (overlays.length > depth) overlays.pop()();
  });
  const back = () => history.back();

  // ---- top bar --------------------------------------------------------------
  $('btn-menu').innerHTML = ICON.menu;
  $('btn-search').innerHTML = ICON.search;
  $('btn-search-close').innerHTML = ICON.back;
  $('chip-cols').innerHTML = ICON.grid;
  $('btn-title').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  function setView(patch) {
    Object.assign(state.view, patch);
    refresh();
  }
  $('sel-sort').addEventListener('change', (e) => {
    const [sort, desc] = e.target.value.split(':');
    setView({ sort, desc: desc === '1', seed: (Math.random() * 2 ** 31) | 0 });
  });
  $('sel-kind').addEventListener('change', (e) => setView({ kind: e.target.value }));
  $('sel-star').addEventListener('change', (e) => setView({ star: Number(e.target.value) }));
  $('chip-tag').addEventListener('click', () => setView({ tag: null }));
  $('chip-cols').addEventListener('click', () => {
    state.cols = state.cols >= 5 ? 2 : state.cols + 1;
    refresh({ keepScroll: true });
  });

  let searchTimer;
  $('btn-search').addEventListener('click', () => {
    $('bar-main').hidden = true;
    $('bar-search').hidden = false;
    $('search').focus();
    pushOverlay(() => {
      $('bar-main').hidden = false;
      $('bar-search').hidden = true;
      $('search').value = '';
      if (state.view.q) setView({ q: '' });
    });
  });
  $('btn-search-close').addEventListener('click', back);
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setView({ q: e.target.value.trim() }), 140);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  // ---- drawer ---------------------------------------------------------------
  function openDrawer() {
    renderDrawer();
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    pushOverlay(() => {
      $('drawer').hidden = true;
      $('scrim').hidden = true;
    });
  }
  $('btn-menu').addEventListener('click', openDrawer);
  $('scrim').addEventListener('click', back);

  /** Close the drawer, then change the view once the history entry is gone. */
  function pick(patch) {
    back();
    setTimeout(() => setView({ q: state.view.q, ...patch }), 0);
  }

  function renderDrawer() {
    const v = state.view;
    const counts = Q.folderCounts(state.items, state.folders);
    const row = (label, n, on, onclick, extra) =>
      h('button', { class: 'row' + (on ? ' on' : ''), onclick }, extra, h('span', { class: 'name' }, label), n != null && h('span', { class: 'n' }, fmtCount(n)));

    const quick = [
      row('All items', state.items.length, v.folder === 'all' && !v.tag, () => pick({ folder: 'all', tag: null })),
      row('Uncategorized', Q.query(state.items, state.folders, { folder: 'uncategorized' }).length, v.folder === 'uncategorized', () => pick({ folder: 'uncategorized', tag: null })),
      row('Untagged', Q.query(state.items, state.folders, { folder: 'untagged' }).length, v.folder === 'untagged', () => pick({ folder: 'untagged', tag: null })),
    ];
    if (state.pins.size) quick.push(row('Kept offline', state.pins.size, v.folder === 'offline', () => pick({ folder: 'offline', tag: null })));
    $('nav-quick').replaceChildren(...quick);

    const out = [];
    (function walk(list, depth) {
      for (const node of list) {
        const kids = node.children || [];
        const open = state.openFolders.has(node.id);
        const twisty = kids.length
          ? h('span', {
              class: 'tw' + (open ? ' open' : ''), html: ICON.chev,
              onclick: (e) => {
                e.stopPropagation();
                open ? state.openFolders.delete(node.id) : state.openFolders.add(node.id);
                renderDrawer();
              },
            })
          : h('span', { class: 'tw' });
        const el = row(node.name, counts.get(node.id) || 0, v.folder === node.id, () => pick({ folder: node.id, tag: null }), [
          twisty,
          h('span', { class: 'dot', style: node.color ? { background: FOLDER_COLORS[node.color] || node.color } : null }),
        ]);
        el.style.paddingLeft = 10 + depth * 16 + 'px';
        out.push(el);
        if (open) walk(kids, depth + 1);
      }
    })(state.library.folders, 0);
    $('nav-folders').replaceChildren(...(out.length ? out : [h('div', { class: 'row n' }, 'No folders')]));
    renderTags();
    $('btn-upload').hidden = !state.canUpload;
  }
  const FOLDER_COLORS = { red: '#ff5c5c', orange: '#ff9f43', yellow: '#ffd43b', green: '#51cf66', aqua: '#3bc9db', blue: '#5b9dff', purple: '#b197fc', pink: '#f783ac' };

  function renderTags() {
    const filter = $('tag-filter').value.trim().toLowerCase();
    let tags = Q.tagCounts(state.items);
    if (filter) tags = tags.filter((t) => t.tag.toLowerCase().includes(filter));
    const shown = tags.slice(0, filter ? 80 : 40);
    put($('nav-tags'),
      shown.map((t) =>
        h('button', { class: 'tag' + (state.view.tag === t.tag ? ' on' : ''), onclick: () => pick({ tag: state.view.tag === t.tag ? null : t.tag }) }, t.tag, h('small', null, fmtCount(t.count)))
      ),
      tags.length > shown.length && h('span', { class: 'row n' }, `${fmtCount(tags.length - shown.length)} more: type to find them`),
      !tags.length && h('span', { class: 'row n' }, filter ? 'No matching tags' : 'No tags')
    );
  }
  $('tag-filter').addEventListener('input', renderTags);

  // ---- viewer ---------------------------------------------------------------
  const viewer = { open: false, i: 0, id: null, scale: 1, tx: 0, ty: 0 };
  const vEl = $('viewer');
  const track = $('track');
  let panes = Array.from(track.children); // [previous, current, next]
  const PANE_GAP = 16;

  $('v-close').innerHTML = ICON.back;
  $('v-info').innerHTML = ICON.info;
  $('v-share').firstElementChild.innerHTML = ICON.share;
  $('v-download').firstElementChild.innerHTML = ICON.save;
  $('v-pin').firstElementChild.innerHTML = ICON.pin;
  $('v-link').firstElementChild.innerHTML = ICON.link;
  $('v-close').addEventListener('click', back);

  function openViewer(i) {
    viewer.open = true;
    viewer.i = i;
    vEl.hidden = false;
    vEl.classList.remove('bare');
    vEl.style.background = '#000';
    document.body.style.overflow = 'hidden';
    fillPanes();
    pushOverlay(() => {
      viewer.open = false;
      vEl.hidden = true;
      document.body.style.overflow = '';
      panes.forEach((p) => p.replaceChildren());
      // Bring the grid to wherever the viewer ended up.
      const y = Math.floor(viewer.i / state.cols) * geom.step;
      const top = grid.getBoundingClientRect().top + window.scrollY;
      if (y + top < window.scrollY + 60 || y + top + geom.cell > window.scrollY + window.innerHeight) {
        window.scrollTo(0, Math.max(0, y + top - window.innerHeight / 2 + geom.cell / 2));
      }
    });
  }

  /** The result list changed underneath an open viewer: stay on the same item. */
  function viewerResync() {
    const i = state.results.findIndex((it) => it.id === viewer.id);
    if (i === -1) return back();
    viewer.i = i;
    for (const k of [0, 2]) renderPane(panes[k], state.results[i + k - 1], false);
    updateViewerChrome();
  }

  function placePanes() {
    const w = window.innerWidth + PANE_GAP;
    panes.forEach((p, k) => (p.style.transform = `translateX(${(k - 1) * w}px)`));
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
  }

  function fillPanes() {
    placePanes();
    panes.forEach((p, k) => renderPane(p, state.results[viewer.i + k - 1], k === 1));
    resetZoom();
    updateViewerChrome();
  }

  function renderPane(pane, it, active) {
    pane.replaceChildren();
    pane.dataset.id = it ? it.id : '';
    if (!it) return;
    const kind = Q.kindOf(it);
    const fileCard = (withThumb) =>
      h('div', { class: 'filecard' },
        withThumb ? h('img', { src: thumbUrl(it), alt: '', onerror: (e) => e.target.remove() }) : null,
        h('div', { class: 'big' }, it.e || 'file'),
        kind === 'audio' && active ? h('audio', { controls: true, src: fileUrl(it), preload: 'metadata' }) : null
      );
    if (kind === 'audio') return pane.append(fileCard(true));
    if (kind === 'video' && active) {
      const video = h('video', { class: 'media', controls: true, playsinline: true, preload: 'metadata', poster: thumbUrl(it), src: fileUrl(it) });
      video.addEventListener('error', () => {
        if (pane.dataset.id === it.id) pane.replaceChildren(fileCard(true), h('div', { class: 'filecard', style: { alignSelf: 'end' } }, 'This phone cannot play this format. Use Save to download it.'));
      });
      return pane.append(video);
    }
    const img = h('img', { class: 'media', alt: it.n, draggable: 'false', decoding: 'async' });
    img.onerror = () => {
      if (pane.dataset.id === it.id && img.isConnected) pane.replaceChildren(fileCard(false));
    };
    img.src = thumbUrl(it);
    pane.append(img);
    if (active && Q.VIEWABLE[it.e]) {
      // Show the thumbnail at once, swap in the original when it has loaded.
      const full = new Image();
      full.onload = () => {
        if (pane.dataset.id === it.id && img.isConnected) {
          img.onerror = null;
          img.src = full.src;
        }
      };
      full.src = fileUrl(it);
    }
  }

  function updateViewerChrome() {
    const it = state.results[viewer.i];
    if (!it) return;
    viewer.id = it.id;
    $('v-count').textContent = `${fmtCount(viewer.i + 1)} / ${fmtCount(state.results.length)}`;
    $('v-name').textContent = `${it.n}.${it.e}`;
    const dl = $('v-download');
    dl.href = `/file/${it.id}?v=${it.v}&dl=1`;
    dl.setAttribute('download', `${it.n}.${it.e}`);
    $('v-pin').classList.toggle('on', state.pins.has(it.id));
    $('v-pin').disabled = !canCache;
    $('v-link').disabled = !/^https?:\/\//i.test(it.u || '');
    $('v-share').disabled = !navigator.share;
  }

  function go(dir) {
    const target = viewer.i + dir;
    const w = window.innerWidth + PANE_GAP;
    track.style.transition = 'transform .2s ease-out';
    if (target < 0 || target >= state.results.length) {
      track.style.transform = 'translateX(0)';
      return;
    }
    track.style.transform = `translateX(${-dir * w}px)`;
    const done = () => {
      track.removeEventListener('transitionend', done);
      clearTimeout(timer);
      if (!viewer.open) return;
      const old = panes[1];
      const oldItem = state.results[viewer.i];
      viewer.i = target;
      if (dir > 0) panes.push(panes.shift());
      else panes.unshift(panes.pop());
      placePanes();
      old.querySelectorAll('.media').forEach((m) => (m.style.transform = ''));
      // Only one live video or full-size image at a time.
      if (old.querySelector('video, audio')) renderPane(old, oldItem, false);
      renderPane(panes[1], state.results[target], true);
      renderPane(panes[dir > 0 ? 2 : 0], state.results[target + dir], false);
      resetZoom();
      updateViewerChrome();
    };
    const timer = setTimeout(done, 260);
    track.addEventListener('transitionend', done);
  }

  function media() {
    return panes[1].querySelector('.media');
  }
  function applyZoom(animate) {
    const m = media();
    if (!m) return;
    m.style.transition = animate ? 'transform .18s ease-out' : 'none';
    m.style.transform = `translate(${viewer.tx}px,${viewer.ty}px) scale(${viewer.scale})`;
  }
  function resetZoom(animate) {
    viewer.scale = 1;
    viewer.tx = viewer.ty = 0;
    applyZoom(animate);
  }
  function clampPan() {
    const mx = (window.innerWidth * (viewer.scale - 1)) / 2;
    const my = (window.innerHeight * (viewer.scale - 1)) / 2;
    viewer.tx = Math.max(-mx, Math.min(mx, viewer.tx));
    viewer.ty = Math.max(-my, Math.min(my, viewer.ty));
  }
  function zoomAt(x, y, scale, from) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const s = Math.max(1, Math.min(8, scale));
    viewer.tx = x - cx - ((from.x - cx - from.tx) * s) / from.s;
    viewer.ty = y - cy - ((from.y - cy - from.ty) * s) / from.s;
    viewer.scale = s;
    clampPan();
  }

  const pts = new Map();
  let g = null;
  let lastTap = 0;
  let tapTimer;

  function nativeControl(e) {
    const t = e.target;
    if (t.closest('audio, a, button')) return true;
    if (t.tagName === 'VIDEO') return e.clientY > t.getBoundingClientRect().bottom - 72;
    return false;
  }

  track.addEventListener('pointerdown', (e) => {
    if (nativeControl(e)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      g = { x: e.clientX, y: e.clientY, t: performance.now(), tx: viewer.tx, ty: viewer.ty, mode: null, dx: 0, dy: 0, video: e.target.tagName === 'VIDEO' };
    } else if (pts.size === 2 && g && media() && media().tagName === 'IMG') {
      const [a, b] = Array.from(pts.values());
      g.mode = 'pinch';
      g.d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.from = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, tx: viewer.tx, ty: viewer.ty, s: viewer.scale };
      track.style.transition = 'none';
      track.style.transform = 'translateX(0)';
    }
  });

  track.addEventListener('pointermove', (e) => {
    if (!g || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch') {
      if (pts.size < 2) return;
      const [a, b] = Array.from(pts.values());
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (g.from.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.d, g.from);
      return applyZoom();
    }
    if (g.mode === 'done') return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (!g.mode) {
      if (Math.hypot(g.dx, g.dy) < 8) return;
      g.mode = viewer.scale > 1.02 ? 'pan' : Math.abs(g.dx) > Math.abs(g.dy) ? 'swipe' : g.dy > 0 ? 'dismiss' : 'none';
      track.style.transition = 'none';
    }
    if (g.mode === 'pan') {
      viewer.tx = g.tx + g.dx;
      viewer.ty = g.ty + g.dy;
      clampPan();
      applyZoom();
    } else if (g.mode === 'swipe') {
      const edge = (g.dx > 0 && viewer.i === 0) || (g.dx < 0 && viewer.i === state.results.length - 1);
      track.style.transform = `translateX(${edge ? g.dx / 3 : g.dx}px)`;
    } else if (g.mode === 'dismiss') {
      panes[1].style.transform = `translate(0, ${g.dy}px) scale(${Math.max(0.7, 1 - g.dy / 1400)})`;
      vEl.style.background = `rgba(0,0,0,${Math.max(0.25, 1 - g.dy / 500)})`;
    }
  });

  function pointerEnd(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.mode === 'pinch') {
      if (viewer.scale < 1.08) resetZoom(true);
      g.mode = 'done';
    }
    if (pts.size) return;
    const gest = g;
    g = null;
    const fast = performance.now() - gest.t < 260;
    if (gest.mode === 'swipe') {
      const far = Math.abs(gest.dx) > window.innerWidth * 0.22 || (fast && Math.abs(gest.dx) > 36);
      go(far ? (gest.dx < 0 ? 1 : -1) : 0);
    } else if (gest.mode === 'dismiss') {
      if (gest.dy > 120 || (fast && gest.dy > 50)) {
        panes[1].style.transform = 'translateX(0)';
        back();
      } else {
        panes[1].style.transition = 'transform .18s';
        panes[1].style.transform = 'translateX(0)';
        vEl.style.background = '#000';
        setTimeout(() => (panes[1].style.transition = ''), 200);
      }
    } else if (!gest.mode && e.type === 'pointerup') {
      const now = performance.now();
      const m = media();
      if (now - lastTap < 300 && m && m.tagName === 'IMG') {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (viewer.scale > 1.02) resetZoom(true);
        else {
          zoomAt(gest.x, gest.y, 2.8, { x: gest.x, y: gest.y, tx: 0, ty: 0, s: 1 });
          applyZoom(true);
        }
      } else {
        lastTap = now;
        // A tap on a video belongs to its own controls.
        if (!gest.video) tapTimer = setTimeout(() => vEl.classList.toggle('bare'), 300);
      }
    }
  }
  track.addEventListener('pointerup', pointerEnd);
  track.addEventListener('pointercancel', pointerEnd);
  track.addEventListener('wheel', (e) => {
    const m = media();
    if (!m || m.tagName !== 'IMG') return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, viewer.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), { x: e.clientX, y: e.clientY, tx: viewer.tx, ty: viewer.ty, s: viewer.scale });
    applyZoom();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlays.length) back();
    else if (viewer.open && $('sheet').hidden && e.key === 'ArrowRight') go(1);
    else if (viewer.open && $('sheet').hidden && e.key === 'ArrowLeft') go(-1);
  });

  // ---- viewer actions -------------------------------------------------------
  let shareReady = null;
  $('v-share').addEventListener('click', async () => {
    const it = state.results[viewer.i];
    if (!it) return;
    try {
      if (!shareReady || shareReady.id !== it.id) {
        toast('Preparing…', 0);
        const blob = await (await fetch(fileUrl(it))).blob();
        shareReady = { id: it.id, file: new File([blob], `${it.n}.${it.e}`, { type: blob.type }) };
        $('toast').hidden = true;
      }
      const data = { files: [shareReady.file] };
      if (navigator.canShare && !navigator.canShare(data)) return toast('This file type cannot be shared from the browser. Use Save instead.');
      await navigator.share(data);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Large files can outlive the tap's permission to open the share sheet.
      toast(err.name === 'NotAllowedError' ? 'Ready. Tap Share once more.' : 'Could not share this file.');
    }
  });
  $('v-link').addEventListener('click', () => {
    const it = state.results[viewer.i];
    if (it && /^https?:\/\//i.test(it.u || '')) window.open(it.u, '_blank', 'noopener,noreferrer');
  });
  $('v-pin').addEventListener('click', async () => {
    const it = state.results[viewer.i];
    if (!it || !canCache) return;
    if (state.pins.has(it.id)) {
      await unpin([it.id]);
      toast('Removed from this phone');
    } else {
      try {
        await pinOne(it, await caches.open(PIN_CACHE));
        state.pins.add(it.id);
        savePins();
        toast('Kept offline');
      } catch (err) {
        toast(pinError(err));
      }
    }
    updateViewerChrome();
  });

  // ---- details sheet --------------------------------------------------------
  function openSheet(...content) {
    put($('sheet-body'), content);
    $('sheet').hidden = false;
    $('sheet').scrollTop = 0;
    $('scrim').hidden = false;
    $('scrim').style.zIndex = 39;
    pushOverlay(() => {
      $('sheet').hidden = true;
      $('scrim').style.zIndex = '';
      $('scrim').hidden = $('drawer').hidden;
    });
  }

  $('v-info').addEventListener('click', () => {
    const it = state.results[viewer.i];
    if (!it) return;
    const facts = [it.e.toUpperCase(), it.w && it.h ? `${it.w} × ${it.h}` : null, fmtSize(it.s), it.d ? fmtDuration(it.d) : null, it.r ? '★'.repeat(it.r) : null].filter(Boolean);
    const jump = (patch) => {
      // Close the sheet and the viewer, then filter.
      history.go(-2);
      setTimeout(() => setView({ q: '', kind: '', star: 0, ...patch }), 60);
    };
    const folders = (it.f || []).map((id) => state.folders.get(id)).filter(Boolean);
    const safeUrl = /^https?:\/\//i.test(it.u || '');
    openSheet(
      h('h2', null, it.n),
      h('div', { class: 'meta' }, facts.join(' · ')),
      h('div', { class: 'meta' }, 'Added ' + new Date(it.t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })),
      it.g && [h('h4', null, 'Tags'), h('div', { class: 'wrap' }, it.g.map((t) => h('button', { class: 'tag', onclick: () => jump({ tag: t, folder: 'all' }) }, t)))],
      folders.length ? [h('h4', null, 'Folders'), h('div', { class: 'wrap' }, folders.map((f) => h('button', { class: 'tag', onclick: () => jump({ folder: f.id, tag: null }) }, f.name)))] : null,
      it.a && [h('h4', null, 'Notes'), h('p', null, it.a)],
      it.u && [h('h4', null, 'Source'), safeUrl ? h('a', { href: it.u, target: '_blank', rel: 'noopener noreferrer' }, it.u) : h('p', null, it.u)],
      it.c && [h('h4', null, 'Colour'), h('div', { class: 'swatches' }, h('i', { style: { background: '#' + it.c } }), h('span', { class: 'note', style: { alignSelf: 'center' } }, '#' + it.c))]
    );
  });

  // ---- keeping things offline -----------------------------------------------
  let pinJob = null;

  function savePins() {
    db.set('pins', Array.from(state.pins)).catch(() => {});
  }
  function pinError(err) {
    return err && err.name === 'QuotaExceededError' ? 'This phone is out of storage space.' : 'Could not download. Check the connection to your PC.';
  }

  /** Store the original and its thumbnail where the service worker will find them. */
  async function pinOne(it, cache) {
    for (const kind of ['thumb', 'file']) {
      const key = `/${kind}/${it.id}`;
      if (await cache.match(key)) continue;
      const r = await fetch(`${key}?v=${it.v}`);
      if (r.ok) await cache.put(key, r);
      else if (kind === 'file') throw new Error('fetch failed');
    }
  }

  async function unpin(ids) {
    const cache = await caches.open(PIN_CACHE);
    for (const id of ids) {
      state.pins.delete(id);
      await cache.delete(`/file/${id}`);
      await cache.delete(`/thumb/${id}`);
    }
    savePins();
  }

  /** Drop offline copies of items that were deleted or replaced on the PC. */
  function prunePins() {
    if (!canCache || !state.pins.size) return;
    const stale = [];
    const versions = JSON.parse(localStorage.getItem('pocket.pinv') || '{}');
    for (const id of state.pins) {
      const it = state.byId.get(id);
      if (!it || (versions[id] && versions[id] !== it.v)) stale.push(id);
    }
    if (stale.length) unpin(stale).catch(() => {});
    rememberPinVersions();
  }
  function rememberPinVersions() {
    const versions = {};
    for (const id of state.pins) {
      const it = state.byId.get(id);
      if (it) versions[id] = it.v;
    }
    localStorage.setItem('pocket.pinv', JSON.stringify(versions));
  }

  function updatePinChip() {
    const chip = $('chip-pin');
    const list = state.results;
    chip.hidden = !canCache || !list.length || (state.view.folder === 'all' && !state.view.tag && !state.view.q && !state.view.kind && !state.view.star);
    if (chip.hidden && !pinJob) return;
    if (pinJob) {
      chip.hidden = false;
      chip.className = 'chip on';
      chip.textContent = `Saving ${pinJob.done}/${pinJob.total} · stop`;
      return;
    }
    const missing = list.filter((it) => !state.pins.has(it.id)).length;
    chip.className = 'chip' + (missing ? '' : ' on');
    chip.textContent = missing ? 'Keep offline' : 'Kept offline ✓';
  }

  $('chip-pin').addEventListener('click', async () => {
    if (pinJob) {
      pinJob.cancelled = true;
      return;
    }
    const list = state.results.slice();
    const todo = list.filter((it) => !state.pins.has(it.id));
    if (!todo.length) {
      if (confirm(`Remove the offline copies of these ${fmtCount(list.length)} items from this phone?`)) {
        await unpin(list.map((it) => it.id));
        refresh({ keepScroll: true });
      }
      return;
    }
    const bytes = todo.reduce((sum, it) => sum + (it.s || 0), 0);
    if (!confirm(`Download ${fmtCount(todo.length)} item${todo.length === 1 ? '' : 's'} (${fmtSize(bytes) || 'size unknown'}) to this phone so they open without your PC?`)) return;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    pinJob = { done: 0, total: todo.length, cancelled: false };
    updatePinChip();
    const cache = await caches.open(PIN_CACHE);
    let failure = null;
    for (const it of todo) {
      if (pinJob.cancelled) break;
      try {
        await pinOne(it, cache);
        state.pins.add(it.id);
      } catch (err) {
        failure = err;
        break;
      }
      pinJob.done++;
      if (pinJob.done % 5 === 0) savePins();
      updatePinChip();
    }
    const done = pinJob.done;
    pinJob = null;
    savePins();
    rememberPinVersions();
    refresh({ keepScroll: true });
    toast(failure ? pinError(failure) : `${fmtCount(done)} item${done === 1 ? '' : 's'} kept offline`);
  });

  // ---- adding from the phone ------------------------------------------------
  $('btn-upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const folder = state.folders.has(state.view.folder) ? state.view.folder : '';
    let ok = 0;
    let message = '';
    for (const [n, file] of files.entries()) {
      toast(`Sending ${n + 1} of ${files.length} to Eagle…`, 0);
      try {
        const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}${folder ? '&folder=' + folder : ''}`, {
          method: 'POST', headers: { 'X-Pocket': '1', 'Content-Type': 'application/octet-stream' }, body: file,
        });
        if (r.ok) ok++;
        else message = ((await r.json().catch(() => ({}))).message) || 'Upload failed';
      } catch {
        message = 'Could not reach your PC';
      }
    }
    toast(ok === files.length ? `Added ${ok} to Eagle${folder ? ' in ' + titleOf(state.view) : ''}` : `${ok} of ${files.length} added. ${message}`, 4000);
    setTimeout(sync, 3500);
  });

  // ---- device sheet ---------------------------------------------------------
  $('btn-settings').addEventListener('click', async () => {
    back();
    await new Promise((r) => setTimeout(r, 30));
    let usage = '';
    try {
      const est = await navigator.storage.estimate();
      usage = `${fmtSize(est.usage) || '0 B'} used on this phone`;
    } catch {}
    openSheet(
      h('h2', null, state.library.name),
      h('div', { class: 'meta' }, `${fmtCount(state.items.length)} items · ${state.online ? 'connected to ' + location.host : 'offline'}`),
      h('h4', null, 'Offline'),
      canCache
        ? h('p', { class: 'note' }, `${fmtCount(state.pins.size)} items kept offline. ${usage}. Open a folder, tag or search and tap “Keep offline” to download it.`)
        : h('p', { class: 'note' }, 'Offline copies need a secure (https) connection. See “Use it away from home” in the Pocket readme to set that up with Tailscale.'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn ghost', onclick: () => { back(); sync().then(() => toast(state.online ? 'Up to date' : 'Your PC is not reachable')); } }, 'Sync now'),
        canCache && state.pins.size ? h('button', { class: 'btn ghost', onclick: async () => {
          if (!confirm('Remove all offline copies from this phone?')) return;
          await unpin(Array.from(state.pins));
          back();
          refresh({ keepScroll: true });
        } }, 'Remove offline copies') : null,
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm('Disconnect this phone? The library copy on it will be erased.')) return;
          await fetch('/api/unpair', { method: 'POST', headers: { 'X-Pocket': '1' } }).catch(() => {});
          if (canCache) for (const k of await caches.keys()) if (k !== 'pocket-shell') await caches.delete(k);
          await db.set('index', null);
          await db.set('pins', []);
          localStorage.clear();
          location.reload();
        } }, 'Disconnect this phone')
      )
    );
  });

  // ---- boot -----------------------------------------------------------------
  async function boot() {
    const key = /[#&]k=([0-9a-f]{32})/i.exec(location.hash);
    if (key) {
      history.replaceState(null, '', location.pathname);
      await pairWith(key[1]);
    }
    try {
      const [cached, pins] = await Promise.all([db.get('index'), db.get('pins')]);
      if (pins) state.pins = new Set(pins);
      if (cached && cached.items) {
        state.items = cached.items;
        state.library = cached.library;
        state.stamp = cached.stamp;
        derive();
      }
    } catch {}
    refresh();
    await sync();
    setInterval(() => document.visibilityState === 'visible' && sync(), 30_000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && sync());
    window.addEventListener('online', sync);
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  boot();
})();
