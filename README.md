# Pocket for Eagle

Browse your [Eagle](https://eagle.cool) image library from your phone.

Pocket is two parts that ship together:

- **An Eagle plugin** that runs quietly on your PC while Eagle is open and shares the current library.
- **A phone app** (an installable web app, so nothing to get from an app store) that mirrors the library's index, shows thumbnails and originals on demand, and can keep chosen folders on the phone for use without the PC.

Your images never leave your own devices. There is no cloud service and no account.

## What it does

- Grid of the whole library, with folders (including nested ones), tags, ratings, file types and sorting
- Instant search across names, tags, notes, source links and folder names, done on the phone
- Full-screen viewer: swipe between items, pinch or double-tap to zoom, swipe down to close, video playback
- Details for each item: size, dimensions, tags, folders, notes, source link, colour
- Share or save the original file to the phone
- **Keep offline**: download a folder, tag or search result to the phone; it then opens with the PC switched off
- **Add to Eagle**: send photos and files from the phone into the library (into the folder you are viewing)
- Picks up changes made in Eagle within a few seconds
- Password-locked Eagle folders and the trash are never shared

## Set up

### 1. Install the plugin (PC)

1. Download this repository (Code → Download ZIP, then unzip) or clone it.
2. In Eagle, click the **Plugins** button in the toolbar → **Developer options** → **Import Local Project**.
3. Select the `plugin` folder from this repository.

Pocket starts by itself each time Eagle starts. Click it in the plugin list to see its window.

The first time, Windows may ask whether to allow Eagle through the firewall. Allow it on **private networks**, otherwise the phone cannot connect.

### 2. Connect the phone

1. Put the phone on the same Wi-Fi as the PC.
2. Open the Pocket window in Eagle and scan the QR code with the phone's camera.
3. In the phone browser, choose **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). It then opens like an app.

The QR code contains a private key. Only phones that scanned it can see the library. **New key** in the Pocket window signs every phone out.

### 3. Use it away from home, and enable offline (recommended)

On plain home Wi-Fi the app works while the phone can reach the PC, but phone browsers only allow offline storage on secure (https) addresses. [Tailscale](https://tailscale.com) (free for personal use) gives you both remote access and https:

1. Install Tailscale on the PC and on the phone and sign both in to the same account.
2. On the PC, run once in a terminal:

   ```
   tailscale serve --bg 41600
   ```

   It prints an address like `https://my-pc.my-tailnet.ts.net`. (Use the port shown in the Pocket window if it is not 41600.)
3. In the Pocket window, set **Address the phone should use** to **Custom address** and paste that address.
4. Scan the new QR code and add it to the home screen again.

Now the app works from anywhere, **Keep offline** appears on folders, tags and searches, and the app itself opens with no connection.

## Good to know

- The PC must be on with Eagle running for anything that is not already kept offline.
- Thumbnails are the ones Eagle already made, so the grid needs no extra processing on the PC.
- Formats a phone cannot draw (PSD, HEIC on some phones, RAW…) show Eagle's thumbnail; use **Save** for the original.
- Pocket only reads the library. The one exception is **Add to Eagle**, which goes through Eagle's own import.
- The library index is held in the phone's memory. This is comfortable up to roughly 100,000 items.

## Run it without the plugin

If you would rather not use the plugin, or want the library available while Eagle is closed, run the same server from a terminal (needs [Node.js](https://nodejs.org) 16 or newer):

```
node bin/pocket.js "D:\Pictures\My.library"
```

It prints the link and QR code. **Add to Eagle** still needs Eagle to be running.

## How it fits together

```
plugin/                 the Eagle plugin (import this folder into Eagle)
  manifest.json         background-service plugin definition
  index.html, js/       the plugin window: status, QR code, address choice
  server/               zero-dependency Node server
    library.js            reads the .library folder, tracks changes
    index.js              pairing, index sync, thumbnails, files, uploads
  web/                  the phone app, served by the server
    app.js, app.css       grid, drawer, viewer, offline, upload
    query.js              search / filter / sort (runs on the phone)
    sw.js                 service worker for offline use
  vendor/qrcode.js      QR code generator (MIT, Kazuhiko Arase)
bin/pocket.js           standalone launcher
scripts/                fake-library and icon generators for development
test/                   server and query tests
```

The phone fetches the whole index once (`/api/index`), then only the differences (`?since=…`). Everything you see in the grid is filtered and sorted on the phone, which is why search is instant and browsing works offline.

## Development

```
npm run fixture                         # build a fake library in .fixture/
node bin/pocket.js .fixture/Demo.library
npm test
```

`http://localhost` counts as secure, so offline features can be tried in a desktop browser.

## Licence

MIT. Not affiliated with Eagle.
