#!/usr/bin/env node
/* Run Pocket without the Eagle plugin: node bin/pocket.js "D:\Pictures\My.library" [--port 41600] */
'use strict';
const path = require('path');
const { createPocketServer } = require('../plugin/server');
const qrcode = require('../plugin/vendor/qrcode.js');

const args = process.argv.slice(2);
let libraryPath = null;
let port;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!args[i].startsWith('-')) libraryPath = args[i];
}
if (!libraryPath) {
  console.log('Usage: node bin/pocket.js <path to .library folder> [--port 41600]');
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const pocket = createPocketServer({ libraryPath: path.resolve(libraryPath), port, log: (m) => console.log(m) });
pocket.start().then((info) => {
  if (!info.library) {
    console.error(info.libraryError);
    process.exit(1);
  }
  console.log(`\nSharing "${info.library.name}" (${info.library.count} items)\n`);
  const link = info.links[0];
  if (link) {
    const qr = qrcode(0, 'L');
    qr.addData(link.url);
    qr.make();
    const n = qr.getModuleCount();
    const dark = (r, c) => r >= 0 && r < n && c >= 0 && c < n && qr.isDark(r, c);
    // Two rows per line with half-block characters; light-on-dark terminals need the inverse.
    for (let r = -2; r < n + 2; r += 2) {
      let line = '';
      for (let c = -2; c < n + 2; c++) line += dark(r, c) ? (dark(r + 1, c) ? ' ' : '▄') : dark(r + 1, c) ? '▀' : '█';
      console.log(line);
    }
  }
  console.log('\nOpen one of these on your phone (the part after # is your private key):');
  for (const l of info.links) console.log(`  ${l.url}   [${l.kind}]`);
  if (!info.links.length) console.log(`  http://localhost:${info.port}/#k=${info.token}`);
  console.log('\nCtrl+C to stop.');
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
process.on('SIGINT', () => pocket.stop().then(() => process.exit(0)));
