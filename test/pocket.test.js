'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture } = require('../scripts/make-fixture');
const { createPocketServer } = require('../plugin/server');
const Q = require('../plugin/web/query');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-test-'));
const libDir = path.join(tmp, 'Demo.library');
makeFixture(libDir, 60);
const added = [];
const pocket = createPocketServer({
  libraryPath: libDir, port: 0, host: '127.0.0.1', configDir: path.join(tmp, 'config'),
  addItem: async (item) => added.push({ ...item, bytes: fs.readFileSync(item.path).length }),
});
let base;
let token;
let cookie;

const get = (p, headers = {}) => fetch(base + p, { headers: { cookie, ...headers } });

test.before(async () => {
  const info = await pocket.start();
  base = `http://127.0.0.1:${info.port}`;
  token = info.token;
});
test.after(async () => {
  await pocket.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the app shell is public, everything else needs pairing', async () => {
  assert.strictEqual((await fetch(base + '/')).status, 200);
  assert.strictEqual((await fetch(base + '/api/index')).status, 401);
  assert.strictEqual((await fetch(base + '/thumb/L000000000001')).status, 401);
  assert.strictEqual((await fetch(base + '/file/L000000000001')).status, 401);
  assert.strictEqual((await fetch(base + '/../server/index.js')).status, 404);
  assert.strictEqual((await fetch(base + '/%2e%2e/manifest.json')).status, 404);
});

test('pairing rejects a wrong key and accepts the right one', async () => {
  const post = (key) => fetch(base + '/api/pair', { method: 'POST', body: JSON.stringify({ key }) });
  assert.strictEqual((await post('0'.repeat(32))).status, 401);
  const ok = await post(token);
  assert.strictEqual(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.ok(!cookie.includes(token), 'the cookie must not be the pairing key itself');
});

let snapshot;
test('index hides trashed items and locked folders', async () => {
  snapshot = await (await get('/api/index')).json();
  assert.strictEqual(snapshot.full, true);
  const raw = fs.readdirSync(path.join(libDir, 'images')).map((d) => JSON.parse(fs.readFileSync(path.join(libDir, 'images', d, 'metadata.json'), 'utf8')));
  const visible = raw.filter((m) => !m.isDeleted && !m.folders.includes('FPRIVATECHILD'));
  assert.ok(visible.length < raw.length);
  assert.strictEqual(snapshot.items.length, visible.length);
  const names = JSON.stringify(snapshot.library.folders);
  assert.ok(!names.includes('Private') && !names.includes('hunter2') && !names.includes('Inner'));
  const hiddenId = raw.find((m) => m.folders.includes('FPRIVATECHILD')).id;
  assert.strictEqual((await get('/file/' + hiddenId)).status, 404);
  assert.strictEqual((await get('/thumb/' + hiddenId)).status, 404);
});

test('incremental sync returns only what changed', async () => {
  const again = await (await get('/api/index?since=' + snapshot.stamp)).json();
  assert.strictEqual(again.full, false);
  assert.strictEqual(again.items.length, 0);

  const victim = snapshot.items[0].id;
  const edited = snapshot.items[1].id;
  fs.rmSync(path.join(libDir, 'images', victim + '.info'), { recursive: true });
  const metaPath = path.join(libDir, 'images', edited + '.info', 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.tags = ['fresh tag'];
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  fs.utimesSync(metaPath, new Date(), new Date(Date.now() + 5000));
  await pocket.library.refresh({ force: true });

  const diff = await (await get('/api/index?since=' + snapshot.stamp)).json();
  assert.strictEqual(diff.full, false);
  assert.deepStrictEqual(diff.removed, [victim]);
  assert.deepStrictEqual(diff.items.map((i) => i.id), [edited]);
  assert.deepStrictEqual(diff.items[0].g, ['fresh tag']);
  assert.strictEqual((await (await get('/api/index?since=bogus:1')).json()).full, true);
});

test('files stream with range support; thumbnails fall back to the original', async () => {
  const png = snapshot.items.find((i) => i.e === 'png' && i.id !== snapshot.items[0].id);
  const full = await get(`/file/${png.id}?v=${png.v}`);
  assert.strictEqual(full.status, 200);
  assert.strictEqual(full.headers.get('content-type'), 'image/png');
  assert.match(full.headers.get('cache-control'), /immutable/);
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.strictEqual(bytes.length, png.s);

  const part = await get(`/file/${png.id}`, { range: 'bytes=4-11' });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.headers.get('content-range'), `bytes 4-11/${png.s}`);
  assert.deepStrictEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(4, 12));
  assert.strictEqual((await get(`/file/${png.id}`, { range: `bytes=${png.s + 10}-` })).status, 416);

  const thumb = await get(`/thumb/${png.id}`);
  assert.strictEqual(thumb.status, 200);
  assert.strictEqual(thumb.headers.get('content-type'), 'image/png');
  await thumb.arrayBuffer();
});

test('svg originals cannot run script on the app origin', async () => {
  const svg = snapshot.items.find((i) => i.e === 'svg');
  const r = await get(`/file/${svg.id}`);
  assert.strictEqual(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  await r.arrayBuffer();
});

test('uploads need the custom header and are handed to Eagle', async () => {
  const body = Buffer.from('hello eagle');
  const url = '/api/upload?name=' + encodeURIComponent('../../evil name.png') + '&folder=FUIREFS000001';
  assert.strictEqual((await fetch(base + url, { method: 'POST', body, headers: { cookie } })).status, 403);
  const ok = await fetch(base + url, { method: 'POST', body, headers: { cookie, 'x-pocket': '1' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].name, 'evil name');
  assert.strictEqual(added[0].folderId, 'FUIREFS000001');
  assert.strictEqual(added[0].bytes, body.length);
  assert.ok(added[0].path.startsWith(os.tmpdir()), 'upload stays inside the temp folder');
});

test('a new key signs out paired phones', async () => {
  pocket.regenerateToken();
  assert.strictEqual((await get('/api/index')).status, 401);
});

test('query: folders include subfolders, search matches across fields', () => {
  const folders = Q.indexFolders(snapshot.library.folders);
  const items = snapshot.items;
  const all = Q.query(items, folders, {});
  assert.strictEqual(all.length, items.length);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].t >= all[i].t, 'newest first by default');

  const parent = Q.query(items, folders, { folder: 'FINSPIRATION1' });
  const child = Q.query(items, folders, { folder: 'FSERIF0000001' });
  assert.ok(child.length > 0 && parent.length > child.length);
  assert.ok(child.every((c) => parent.includes(c)));
  assert.strictEqual(Q.folderCounts(items, folders).get('FINSPIRATION1'), parent.length);

  const uncategorized = Q.query(items, folders, { folder: 'uncategorized' });
  assert.ok(uncategorized.length > 0 && uncategorized.every((i) => !i.f));
  assert.ok(Q.query(items, folders, { folder: 'untagged' }).every((i) => !i.g));

  const tag = Q.tagCounts(items)[0];
  assert.strictEqual(Q.query(items, folders, { tag: tag.tag }).length, tag.count);

  const byFolderName = Q.query(items, folders, { q: 'typography' });
  assert.ok(byFolderName.length > 0 && byFolderName.every((i) => i.f.includes('FTYPE00000001')));
  assert.ok(Q.query(items, folders, { q: 'AURORA moodboard' }).every((i) => /aurora/i.test(i.n) && /moodboard/.test(i.a)));
  assert.strictEqual(Q.query(items, folders, { q: 'zzz-no-such-thing' }).length, 0);

  const names = Q.query(items, folders, { sort: 'name', desc: false }).map((i) => i.n);
  assert.deepStrictEqual(names, names.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
  const a = Q.query(items, folders, { sort: 'random', seed: 7 }).map((i) => i.id);
  assert.deepStrictEqual(a, Q.query(items, folders, { sort: 'random', seed: 7 }).map((i) => i.id));
  assert.notDeepStrictEqual(a, Q.query(items, folders, { sort: 'random', seed: 8 }).map((i) => i.id));
  assert.ok(Q.query(items, folders, { star: 3 }).every((i) => i.r >= 3));
});
