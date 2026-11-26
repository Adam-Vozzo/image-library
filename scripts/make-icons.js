#!/usr/bin/env node
/* Renders plugin/web/icon.svg to the PNG sizes phones and Eagle want. Needs Playwright (dev only). */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const web = path.join(__dirname, '..', 'plugin', 'web');
  const svg = fs.readFileSync(path.join(web, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  const targets = [[180, path.join(web, 'icon-180.png')], [192, path.join(web, 'icon-192.png')], [512, path.join(web, 'icon-512.png')], [256, path.join(web, '..', 'logo.png')]];
  for (const [size, file] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: file });
    await page.close();
  }
  await browser.close();
  console.log('Icons written');
})();
