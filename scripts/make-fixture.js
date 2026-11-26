#!/usr/bin/env node
/* Builds a small fake Eagle library for tests and local development: node scripts/make-fixture.js [dir] [count] */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A soft two-colour gradient with a few discs, so tiles are easy to tell apart. */
function png(w, h, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const a = [rnd() * 255, rnd() * 255, rnd() * 255];
  const b = [rnd() * 255, rnd() * 255, rnd() * 255];
  const discs = Array.from({ length: 3 }, () => ({ x: rnd() * w, y: rnd() * h, r: (0.08 + rnd() * 0.2) * Math.min(w, h), c: [rnd() * 255, rnd() * 255, rnd() * 255] }));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      let c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      for (const d of discs) if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r * d.r) c = d.c;
      raw[row + 1 + x * 3] = c[0];
      raw[row + 2 + x * 3] = c[1];
      raw[row + 3 + x * 3] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return {
    data: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
    color: a.map(Math.round),
  };
}

function makeFixture(dir, count = 150) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const folders = [
    { id: 'FINSPIRATION1', name: 'Inspiration', children: [
      { id: 'FPOSTERS00001', name: 'Posters', children: [], iconColor: 'red' },
      { id: 'FTYPE00000001', name: 'Typography', children: [{ id: 'FSERIF0000001', name: 'Serif', children: [] }] },
    ] },
    { id: 'FUIREFS000001', name: 'UI references', children: [], iconColor: 'blue' },
    { id: 'FTEXTURES0001', name: 'Textures', children: [] },
    { id: 'FPRIVATE00001', name: 'Private', password: 'hunter2', passwordTips: '', children: [{ id: 'FPRIVATECHILD', name: 'Inner', children: [] }] },
  ];
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ folders, smartFolders: [], quickAccess: [], tagsGroups: [], modificationTime: Date.now(), applicationVersion: '4.0.0' }));
  const folderIds = ['FPOSTERS00001', 'FTYPE00000001', 'FSERIF0000001', 'FUIREFS000001', 'FTEXTURES0001', 'FINSPIRATION1'];
  const tagPool = ['blue', 'warm', 'minimal', 'grid', 'poster', 'serif', 'dark mode', 'gradient', 'brutalist', 'mobile', 'dashboard', 'paper', 'grain', 'neon'];
  const words = ['Aurora', 'Signal', 'Harbor', 'Monolith', 'Citrus', 'Lattice', 'Ember', 'Drift', 'Quartz', 'Velvet', 'Orbit', 'Tundra'];
  const mtime = {};
  const base = Date.UTC(2026, 0, 1);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const id = 'L' + (i + 1).toString(36).toUpperCase().padStart(12, '0');
    const name = `${words[i % words.length]} ${String(i + 1).padStart(3, '0')}`;
    const portrait = i % 3 === 0;
    const w = portrait ? 360 : 640;
    const h = portrait ? 540 : 400;
    let ext = 'png';
    if (i % 29 === 7) ext = 'svg';
    else if (i % 37 === 11) ext = 'psd';
    const itemDir = path.join(dir, 'images', id + '.info');
    fs.mkdirSync(itemDir);
    const img = png(w, h, i * 7919 + 13);
    let size;
    if (ext === 'png') {
      fs.writeFileSync(path.join(itemDir, `${name}.png`), img.data);
      size = img.data.length;
      // Eagle only writes thumbnails for larger files.
      if (i % 4 === 0) fs.writeFileSync(path.join(itemDir, `${name}_thumbnail.png`), png(w / 2, h / 2, i * 7919 + 13).data);
    } else if (ext === 'svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="rgb(${img.color})"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 4}" fill="#fff"/><script>document.title='x'</script></svg>`;
      fs.writeFileSync(path.join(itemDir, `${name}.svg`), svg);
      size = svg.length;
    } else {
      const blob = Buffer.alloc(2048, i);
      fs.writeFileSync(path.join(itemDir, `${name}.psd`), blob);
      size = blob.length;
      if (i % 2) fs.writeFileSync(path.join(itemDir, `${name}_thumbnail.png`), img.data);
    }
    const isPrivate = i % 41 === 5;
    const meta = {
      id, name, size, ext, btime: base + i * 3600_000, mtime: base + i * 3600_000,
      tags: i % 9 === 0 ? [] : [tagPool[i % tagPool.length], tagPool[(i * 5 + 3) % tagPool.length]].filter((t, k, a) => a.indexOf(t) === k),
      folders: isPrivate ? ['FPRIVATECHILD'] : i % 6 === 0 ? [] : [folderIds[Math.floor(i / 2) % folderIds.length]],
      isDeleted: i % 53 === 9,
      url: i % 5 === 0 ? `https://example.com/ref/${i + 1}` : '',
      annotation: i % 11 === 0 ? `Note for ${name}: keep for the autumn moodboard.` : '',
      modificationTime: base + i * 5400_000,
      width: w, height: h, lastModified: base + i * 5400_000,
      palettes: [{ color: img.color, ratio: 60 }],
    };
    if (i % 7 === 0) meta.star = (i % 5) + 1;
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify(meta));
    mtime[id] = meta.lastModified;
    ids.push(id);
  }
  // One real video when ffmpeg is around (optional; nothing depends on it).
  try {
    const id = 'LVIDEO0000001';
    const itemDir = path.join(dir, 'images', id + '.info');
    fs.mkdirSync(itemDir);
    const file = path.join(itemDir, 'Test clip.mp4');
    require('child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 20000 });
    fs.writeFileSync(path.join(itemDir, 'Test clip_thumbnail.png'), png(320, 240, 99).data);
    fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify({
      id, name: 'Test clip', size: fs.statSync(file).size, ext: 'mp4', tags: ['video test'], folders: ['FUIREFS000001'], isDeleted: false, url: '', annotation: '',
      modificationTime: base + count * 5400_000, btime: base, mtime: base, width: 320, height: 240, duration: 3, palettes: [],
    }));
    ids.push(id);
    count++;
  } catch {
    fs.rmSync(path.join(dir, 'images', 'LVIDEO0000001.info'), { recursive: true, force: true });
  }
  mtime.all = count;
  fs.writeFileSync(path.join(dir, 'mtime.json'), JSON.stringify(mtime));
  fs.writeFileSync(path.join(dir, 'tags.json'), JSON.stringify({ historyTags: [], starredTags: [] }));
  return { dir, ids };
}

module.exports = { makeFixture, png };
if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', '.fixture', 'Demo.library'));
  const { ids } = makeFixture(dir, Number(process.argv[3]) || 150);
  console.log(`Wrote ${ids.length} items to ${dir}`);
}
