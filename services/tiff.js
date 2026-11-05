/**
 * Multi-page RGB TIFF writer.
 * Each page is stored as one Adobe-Deflate strip (compression tag 8) so a
 * merged export stays a single .tif without a system libtiff binary.
 */

const zlib = require('zlib');

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

function encodeMultipageTiff(pages) {
  if (!pages.length) throw new Error('No pages to encode');

  const prepared = pages.map((page) => {
    if (!page.data || page.data.length !== page.width * page.height * 3) {
      throw new Error('TIFF encoder expected packed RGB pixels');
    }
    return {
      width: page.width,
      height: page.height,
      data: zlib.deflateSync(page.data),
    };
  });

  const ifdBytes = 2 + 14 * 12 + 4;
  let cursor = 8;
  const locs = prepared.map((page) => {
    const ifd = cursor;
    cursor += ifdBytes;
    const bps = cursor;
    cursor += 8;
    const xres = cursor;
    cursor += 8;
    const yres = cursor;
    cursor += 8;
    cursor = (cursor + 3) & ~3;
    const data = cursor;
    cursor += page.data.length;
    return { ifd, bps, xres, yres, data };
  });

  const out = Buffer.alloc(cursor);
  out.writeUInt16LE(0x4949, 0);
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(locs[0].ifd, 4);

  prepared.forEach((page, index) => {
    const loc = locs[index];
    const next = index < locs.length - 1 ? locs[index + 1].ifd : 0;
    out.writeUInt16LE(8, loc.bps);
    out.writeUInt16LE(8, loc.bps + 2);
    out.writeUInt16LE(8, loc.bps + 4);
    out.writeUInt32LE(72, loc.xres);
    out.writeUInt32LE(1, loc.xres + 4);
    out.writeUInt32LE(72, loc.yres);
    out.writeUInt32LE(1, loc.yres + 4);
    page.data.copy(out, loc.data);

    const tags = [
      [256, LONG, 1, page.width],
      [257, LONG, 1, page.height],
      [258, SHORT, 3, loc.bps],
      [259, SHORT, 1, 8],
      [262, SHORT, 1, 2],
      [273, LONG, 1, loc.data],
      [277, SHORT, 1, 3],
      [278, LONG, 1, page.height],
      [279, LONG, 1, page.data.length],
      [282, RATIONAL, 1, loc.xres],
      [283, RATIONAL, 1, loc.yres],
      [284, SHORT, 1, 1],
      [296, SHORT, 1, 2],
      [317, SHORT, 1, 1],
    ];

    let at = loc.ifd;
    out.writeUInt16LE(tags.length, at);
    at += 2;
    for (const [tag, type, count, value] of tags) {
      out.writeUInt16LE(tag, at);
      out.writeUInt16LE(type, at + 2);
      out.writeUInt32LE(count, at + 4);
      if (type === SHORT && count === 1) {
        out.writeUInt16LE(value, at + 8);
        out.writeUInt16LE(0, at + 10);
      } else {
        out.writeUInt32LE(value >>> 0, at + 8);
      }
      at += 12;
    }
    out.writeUInt32LE(next, at);
  });

  return out;
}

module.exports = { encodeMultipageTiff };
