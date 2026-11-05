# Format Converter

Self-hosted desk for converting and editing documents and images, in English and Arabic. It runs on Node.js, stores every job as a folder, and does not use a database.

Bring in TIFF (including multi-page), PDF, JPEG, PNG, WebP, GIF, AVIF, BMP, JPEG 2000 (`.jpf`, `.jp2`, `.j2k`, `.jpx`), and TrueType / OpenType fonts. Merge them into one PDF or write the pages back out as PNG, JPEG, WebP, or TIFF. Fonts are drawn as a specimen sheet so they can sit in the same PDF as scans and photos.

## Requirements

- Node.js 18 or newer
- No system packages beyond what Node already needs. Image, PDF, font, and JPEG 2000 work is done by the npm dependencies (`sharp`, `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`, `opentype.js`, `jpeg2000`, `archiver`).

## Install and run

```bash
cd ttif
npm install
npm start
```

The server binds to `0.0.0.0:3000` unless you override it:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

On the machine running Format Converter, open <http://localhost:3000>. From another device on the same network, use the LAN address printed at startup, for example `http://192.168.1.20:3000`. Find that address with:

```bash
hostname -I
```

If a firewall is enabled, allow the port (Ubuntu example):

```bash
sudo ufw allow 3000/tcp
```

`npm run dev` restarts the process when source files change.

## Windows without installing Node

`setup-env.cmd` downloads the portable Node.js 22 zip (no installer, nothing added to the system) and installs the npm packages with that copy. Internet is needed for this step. After it finishes, `run.cmd` and IIS both use `runtime\node\node.exe`.

```bat
setup-env.cmd
run.cmd
run.cmd 8080
run.cmd 8080 0.0.0.0
```

The first argument is the port (default `3000`). The second is the host (default `0.0.0.0`, so other PCs on the LAN can open it). Open `http://localhost:3000` on this PC, or the LAN address printed in the window.

## Publish on IIS

The site uses the same portable Node. IIS receives the public port and starts `runtime\node\node.exe` through [HttpPlatformHandler](https://www.iis.net/downloads/microsoft/httpplatformhandler). Install that module once on the server (the ASP.NET hosting bundle does not include it).

1. Copy this folder to the server, for example `C:\inetpub\format-converter`. Do not copy `node_modules` from Linux or macOS.
2. Run `setup-env.cmd` in that folder.
3. Install HttpPlatformHandler 1.2, then create an application pool with **No Managed Code**, **Enable 32-Bit Applications** set to False, and a site whose physical path is this folder. `web.config` is already set: Node listens only on `127.0.0.1` and the port IIS assigns, and uploads up to 2 GB are accepted.
4. Give the pool permission to write job files and the audit log (Command Prompt as Administrator):

```bat
icacls C:\inetpub\format-converter\storage /grant "IIS APPPOOL\FormatConverter:(OI)(CI)M" /T
```

Replace `FormatConverter` with the application pool name.

5. Browse the site. `http://your-server/api/health` should answer. The audit log records the visitor address from `X-Forwarded-For` when IIS is the proxy. Lines stay in English.

A long export can outlive the default IIS connection timeout of 2 minutes. Raise the site’s connection timeout if a large TIFF or PDF is cut off.

`run.cmd` is the standalone window. Leave it stopped when the IIS site is the copy you want people to use, so two servers are not writing the same `storage` folder.

## What you can do

- Drag in many files at once, or add more after the job is open.
- Reorder pages by dragging them. Right-click a page or the preview for crop, rotate, move to top, grayscale, download, and delete.
- Crop with a box on the page. Rotate in 90° steps. Adjust brightness, contrast, and grayscale. Place short text notes.
- Export one PDF, a multi-page TIFF, or a zip of separate pages. An optional watermark is drawn onto the exported file only.
- Page ranges use 1-based numbers: `all` or `1-3,5`.

Previews render in the background (two pages at a time) so the page stays responsive while a large TIFF or PDF is decoded.

## Files on disk

```
storage/jobs/<YYYYMMDD_HHMMSS>_<id>/
  manifest.json
  uploads/     original files
  cache/       decoded page PNGs
  previews/    webp thumbnails
  exports/     files you built
storage/logs/activity.log
```

Delete a job from the desk, or remove its folder, to free the space. Nothing is written to a database.

Each line in `storage/logs/activity.log` looks like:

```
[YYYY-MM-DD HH:mm:ss] | IP: <user_ip> | User-Agent: <agent> | Action: <conversion/edit> | File: <filename> | Time Consumed: <Xms>
```

## Limits

- 250 MB per file, 40 files per upload, 120 pages per job.
- JPEG 2000 is decoded in pure JavaScript and is slower than JPEG or PNG. Very large or exotic JPX files can fail with a clear error on that page.
- Password-protected PDFs are rejected.
- A merged PDF scales each page to fit A4 (landscape when the page is wider than it is tall).

## Layout

| Path | Role |
| --- | --- |
| `server.js` | Express app, static files, host and port |
| `routes/api.js` | Upload, edit, preview, and export endpoints |
| `services/` | Jobs on disk, decoding, edits, PDF / TIFF / zip export, audit log |
| `public/` | Desk UI, drag-and-drop, crop tool, context menu |
| `setup-env.cmd` | Downloads portable Node.js and installs packages |
| `run.cmd` | Starts the portable copy: `run.cmd [port] [host]` |
| `web.config` | IIS HttpPlatformHandler site configuration |
| `runtime/` | Portable Node.js created by `setup-env.cmd` (not in git) |
