/*
 * Filtering, searching and sorting over the mirrored item list.
 * Runs on the phone (the whole index is local, so this works offline) and is
 * loadable from Node for tests.
 *
 * Item wire format (see server/library.js): id, n(ame), e(xt), t(added), v(ersion),
 * w, h, s(ize), b(created), g(tags), f(olders), r(ating), u(rl), a(nnotation),
 * d(uration), c(olour).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PocketQuery = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = {
    image: ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'arw', 'dng', 'tga', 'exr', 'hdr'],
    gif: ['gif', 'apng'],
    video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv'],
    audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'aiff'],
  };
  var KIND_OF = {};
  Object.keys(KINDS).forEach(function (k) {
    KINDS[k].forEach(function (e) {
      KIND_OF[e] = k;
    });
  });

  /** Formats a phone browser can draw in an <img>. */
  var VIEWABLE = { jpg: 1, jpeg: 1, jfif: 1, png: 1, gif: 1, webp: 1, avif: 1, bmp: 1, svg: 1, ico: 1, apng: 1 };

  function kindOf(item) {
    return KIND_OF[item.e] || 'other';
  }

  /** Flatten the folder tree: id -> { id, name, parent, depth, children, color }. */
  function indexFolders(tree) {
    var byId = new Map();
    (function walk(list, parent, depth) {
      (list || []).forEach(function (f) {
        byId.set(f.id, { id: f.id, name: f.name, color: f.color, parent: parent, depth: depth, children: (f.children || []).map(function (c) { return c.id; }) });
        walk(f.children, f.id, depth + 1);
      });
    })(tree, null, 0);
    return byId;
  }

  /** A folder plus everything nested under it. */
  function descendants(folders, id) {
    var out = new Set();
    (function add(x) {
      var f = folders.get(x);
      if (!f || out.has(x)) return;
      out.add(x);
      f.children.forEach(add);
    })(id);
    return out;
  }

  /** Item counts per folder; a folder counts what is in its subfolders too. */
  function folderCounts(items, folders) {
    var counts = new Map();
    var seen = new Set();
    for (var i = 0; i < items.length; i++) {
      var fs = items[i].f;
      if (!fs) continue;
      seen.clear();
      for (var j = 0; j < fs.length; j++) {
        var id = fs[j];
        while (id && folders.has(id) && !seen.has(id)) {
          seen.add(id);
          counts.set(id, (counts.get(id) || 0) + 1);
          id = folders.get(id).parent;
        }
      }
    }
    return counts;
  }

  function tagCounts(items) {
    var counts = new Map();
    for (var i = 0; i < items.length; i++) {
      var g = items[i].g;
      if (!g) continue;
      for (var j = 0; j < g.length; j++) counts.set(g[j], (counts.get(g[j]) || 0) + 1);
    }
    return Array.from(counts, function (e) { return { tag: e[0], count: e[1] }; }).sort(function (a, b) {
      return b.count - a.count || a.tag.localeCompare(b.tag);
    });
  }

  var haystacks = new WeakMap();
  function haystack(item, folders) {
    var h = haystacks.get(item);
    if (h === undefined) {
      var parts = [item.n, item.e];
      if (item.g) parts.push(item.g.join(' '));
      if (item.a) parts.push(item.a);
      if (item.u) parts.push(item.u);
      if (item.f && folders) {
        item.f.forEach(function (id) {
          var f = folders.get(id);
          if (f) parts.push(f.name);
        });
      }
      h = parts.join('\n').toLowerCase();
      haystacks.set(item, h);
    }
    return h;
  }

  var SORTS = {
    added: function (a, b) { return a.t - b.t; },
    created: function (a, b) { return (a.b || a.t) - (b.b || b.t); },
    name: function (a, b) { return collator.compare(a.n, b.n); },
    size: function (a, b) { return (a.s || 0) - (b.s || 0); },
    rating: function (a, b) { return (a.r || 0) - (b.r || 0) || a.t - b.t; },
  };
  var collator = typeof Intl !== 'undefined' && Intl.Collator
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    : { compare: function (a, b) { return a < b ? -1 : a > b ? 1 : 0; } };

  /**
   * opts: folder ('all' | 'uncategorized' | 'untagged' | folder id), tag, q,
   *       kind, star (minimum rating), ids (Set to restrict to),
   *       sort ('added' | 'created' | 'name' | 'size' | 'rating' | 'random'), desc
   */
  function query(items, folders, opts) {
    opts = opts || {};
    var folder = opts.folder || 'all';
    var inFolders = null;
    if (folder !== 'all' && folder !== 'uncategorized' && folder !== 'untagged') inFolders = descendants(folders, folder);
    var words = String(opts.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    var out = [];
    outer: for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (opts.ids && !opts.ids.has(it.id)) continue;
      if (folder === 'uncategorized') {
        if (it.f && it.f.some(function (id) { return folders.has(id); })) continue;
      } else if (folder === 'untagged') {
        if (it.g && it.g.length) continue;
      } else if (inFolders) {
        if (!it.f) continue;
        var hit = false;
        for (var j = 0; j < it.f.length; j++) if (inFolders.has(it.f[j])) { hit = true; break; }
        if (!hit) continue;
      }
      if (opts.tag && !(it.g && it.g.indexOf(opts.tag) !== -1)) continue;
      if (opts.kind && kindOf(it) !== opts.kind) continue;
      if (opts.star && (it.r || 0) < opts.star) continue;
      if (words.length) {
        var h = haystack(it, folders);
        for (var w = 0; w < words.length; w++) if (h.indexOf(words[w]) === -1) continue outer;
      }
      out.push(it);
    }
    if (opts.sort === 'random') {
      // Stable for a given seed so scrolling and paging stay consistent.
      var seed = (opts.seed || 1) >>> 0;
      var keyed = out.map(function (it) { return { it: it, k: hash(it.id, seed) }; });
      keyed.sort(function (a, b) { return a.k - b.k; });
      return keyed.map(function (x) { return x.it; });
    }
    var cmp = SORTS[opts.sort] || SORTS.added;
    var dir = opts.desc === false ? 1 : -1;
    out.sort(function (a, b) { return dir * cmp(a, b) || (a.id < b.id ? -1 : 1); });
    return out;
  }

  function hash(str, seed) {
    var h = seed ^ 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  return { query: query, indexFolders: indexFolders, descendants: descendants, folderCounts: folderCounts, tagCounts: tagCounts, kindOf: kindOf, VIEWABLE: VIEWABLE };
});
