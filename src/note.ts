// Port of pdf2note.py: adds a ruled note area and a header band to every page.
// Pure pdf-lib; no vscode API, so it can be exercised from Node.
import { PDFDocument, PDFEmbeddedPage, PDFFont, PDFImage, PDFPage, degrees, rgb } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

// Everything in pt. The reference values apply to an A4-portrait body and are
// scaled by pageScale() so small or large sources keep the same proportions.
const REFERENCE_SIZE = Math.sqrt(595.276 * 841.89);
const LINE_COLOR = rgb(0.8, 0.8, 0.8);
const LINE_WIDTH = 0.5;
const LINE_DASH = [2, 3];
const BORDER_COLOR = rgb(0.85, 0.85, 0.85);
const BORDER_WIDTH = 0.5;
const LANDSCAPE_MARGIN = 24;
const PORTRAIT_MARGIN = 0;
const HEADER_COLOR = rgb(0.5, 0.5, 0.5);
const HEADER_HEIGHT_RATIO = 1.5; // band height = font size × ratio
const HEADER_PAD_X_RATIO = 24 / 18;
const FEEDBACK_GAP = 14;
const DIVIDER_COLOR = rgb(0.75, 0.75, 0.75);

// Message translator; extension.ts installs vscode.l10n.t. The default fills
// {0}, {1}, … so the module still works from plain Node.
type Translate = (message: string, ...args: (string | number)[]) => string;
let t: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (whole, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : whole));
export function setTranslator(translate: Translate): void {
  t = translate;
}
const DIVIDER_WIDTH = 0.7;

const MM = 72 / 25.4;
// (short, long) in pt — ISO sizes, as reportlab.lib.pagesizes in the script.
export const PAPER_SIZES: Record<string, [number, number]> = {
  A0: [841 * MM, 1189 * MM],
  A1: [594 * MM, 841 * MM],
  A2: [420 * MM, 594 * MM],
  A3: [297 * MM, 420 * MM],
  A4: [210 * MM, 297 * MM],
  A5: [148 * MM, 210 * MM],
  A6: [105 * MM, 148 * MM],
  B0: [1000 * MM, 1414 * MM],
  B1: [707 * MM, 1000 * MM],
  B2: [500 * MM, 707 * MM],
  B3: [353 * MM, 500 * MM],
  B4: [250 * MM, 353 * MM],
  B5: [176 * MM, 250 * MM],
  B6: [125 * MM, 176 * MM],
  LETTER: [612, 792],
  LEGAL: [612, 1008],
  TABLOID: [792, 1224],
  LEDGER: [792, 1224],
  // Tablets: the screen's logical size (CSS px at 2x) in pt (1 px = 0.75 pt),
  // the same pages ipynb-pdf-converter produces for these devices.
  iPadPro13: [774.0, 1032.0],
  iPadPro11: [625.5, 907.5],
  iPadAir13: [768.0, 1024.5],
  iPad11: [615.0, 885.0],
  iPadMini: [558.0, 849.75],
  GalaxyTabS11: [600.0, 960.0],
  GalaxyTabS11Ultra: [693.0, 1110.0],
};

export type Align = 'left' | 'center' | 'right';

export interface ImageBytes {
  bytes: Uint8Array;
}

export interface NoteOptions {
  // Header/footer placeholders: {file} {date} {page} {total}
  vars: { file: string; date: string };
  header: { text: string; align: Align };
  footer: { text: string; align: Align };
  fontSize: number; // reference pt (10 in the script)
  fontBytes: Uint8Array; // TTF with Hangul glyphs
  paper: [number, number] | null; // (short, long) pt, or null = grow around the original
  mode: 'note' | 'feedback';
  lineGap: number; // reference pt (18)
  banner: ImageBytes | null; // feedback mode, landscape pages only
  mark: ImageBytes | null; // teacher mode: replaces the header text
  markWidth: number; // reference pt (100)
  onProgress?: (done: number, total: number) => void;
}

export interface NoteResult {
  doc: PDFDocument;
  pages: number;
  warnings: string[];
}

// The source needs a password to open (owner-only protection is opened silently).
export class SourceEncryptedError extends Error {
  constructor() {
    super('The PDF is password protected');
  }
}
export class WrongPasswordError extends Error {
  constructor() {
    super('Password incorrect');
  }
}

// Opens the source and turns pdf-lib's failures into actionable errors.
export async function loadSource(input: Uint8Array, password?: string): Promise<PDFDocument> {
  const tryLoad = (pw?: string) => PDFDocument.load(input, pw !== undefined ? { password: pw } : {});
  let doc: PDFDocument;
  try {
    doc = await tryLoad(password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const encrypted = (error instanceof Error && error.constructor.name === 'EncryptedPDFError') || /is encrypted/i.test(message);
    if (encrypted && password === undefined) {
      // Owner-only protection has an empty user password.
      try {
        doc = await tryLoad('');
      } catch {
        throw new SourceEncryptedError();
      }
    } else if (encrypted || /password/i.test(message)) {
      throw new WrongPasswordError();
    } else {
      throw new Error(t('Not a readable PDF ({0})', message));
    }
  }
  let pageCount: number;
  try {
    pageCount = doc.getPageCount(); // a truncated file parses but has no page tree
  } catch (error) {
    throw new Error(t('Not a readable PDF ({0})', error instanceof Error ? error.message : String(error)));
  }
  if (pageCount === 0) {
    throw new Error(t('The PDF has no pages'));
  }
  return doc;
}

export async function addNoteArea(src: PDFDocument, options: NoteOptions): Promise<NoteResult> {
  const warnings: string[] = [];
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const font = await out.embedFont(options.fontBytes, { subset: true });
  const banner = options.banner ? await embedImage(out, options.banner.bytes, warnings, t('Feedback banner')) : null;
  const mark = options.mark ? await embedImage(out, options.mark.bytes, warnings, t('Instructor mark')) : null;
  const total = src.getPageCount();

  for (let i = 0; i < total; i++) {
    const srcPage = src.getPage(i);
    // A page without a content stream (a blank sheet) cannot be embedded
    // (pdf-lib only complains at save time), so lay it out as an empty
    // original of the same size.
    let embedded: PDFEmbeddedPage | null = null;
    if (srcPage.node.Contents()) {
      try {
        embedded = await out.embedPage(srcPage);
      } catch (error) {
        throw new Error(t('Page {0} cannot be embedded ({1})', i + 1, error instanceof Error ? error.message : String(error)));
      }
    }
    buildNotePage(out, srcPage, embedded, i + 1, total, { font, banner, mark }, options);
    options.onProgress?.(i + 1, total);
  }
  return { doc: out, pages: total, warnings };
}

interface Assets {
  font: PDFFont;
  banner: PDFImage | null;
  mark: PDFImage | null;
}

function pageScale(bodyW: number, bodyH: number): number {
  return Math.sqrt(bodyW * bodyH) / REFERENCE_SIZE;
}

function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  return Math.min(boxW / w, boxH / h);
}

function buildNotePage(
  out: PDFDocument,
  srcPage: PDFPage,
  embedded: PDFEmbeddedPage | null,
  pageNumber: number,
  total: number,
  assets: Assets,
  o: NoteOptions
): void {
  // /Rotate pages (scans) are laid out as they are displayed.
  const rotation = ((srcPage.getRotation().angle % 360) + 360) % 360;
  const rawW = embedded ? embedded.width : srcPage.getWidth();
  const rawH = embedded ? embedded.height : srcPage.getHeight();
  const w = rotation % 180 ? rawH : rawW;
  const h = rotation % 180 ? rawW : rawH;

  const isLandscape = w > h;
  const margin = isLandscape ? LANDSCAPE_MARGIN : PORTRAIT_MARGIN;
  const hasHeader = Boolean(assets.mark) || Boolean(o.header.text);
  const hasFooter = Boolean(o.footer.text);

  // Page size. The body is the lower part; header/footer bands are added
  // above/below it. Band heights follow the body scale, which itself depends
  // on the body height when a paper size is fixed, so iterate a few times.
  let bodyW: number;
  let bodyH: number;
  let pageW: number;
  let pageH: number;
  let scale: number;
  let headerH = 0;
  let footerH = 0;
  let fit: number;
  const bandFor = (s: number) => o.fontSize * s * HEADER_HEIGHT_RATIO;
  if (!o.paper) {
    bodyW = isLandscape ? w + margin * 2 : w * 2 + margin * 2;
    bodyH = isLandscape ? h * 2 + margin * 2 : h + margin * 2;
    pageW = bodyW;
    scale = pageScale(bodyW, bodyH);
    headerH = hasHeader ? bandFor(scale) : 0;
    footerH = hasFooter ? bandFor(scale) : 0;
    pageH = bodyH + headerH + footerH;
    fit = 1;
  } else {
    const [short, long] = [Math.min(...o.paper), Math.max(...o.paper)];
    [pageW, pageH] = isLandscape ? [short, long] : [long, short];
    bodyW = pageW;
    bodyH = pageH;
    scale = pageScale(bodyW, bodyH);
    for (let k = 0; k < 3; k++) {
      scale = pageScale(bodyW, bodyH);
      headerH = hasHeader ? bandFor(scale) : 0;
      footerH = hasFooter ? bandFor(scale) : 0;
      bodyH = pageH - headerH - footerH;
    }
    fit = isLandscape
      ? fitScale(w, h, bodyW - margin * 2, (bodyH - margin * 2) / 2)
      : fitScale(w, h, (bodyW - margin * 2) / 2, bodyH - margin * 2);
    if (fit <= 0) {
      throw new Error(t('Paper too small for the original: {0}x{1} pt', pageW.toFixed(0), pageH.toFixed(0)));
    }
  }

  const page = out.addPage([pageW, pageH]);
  const by = footerH; // body origin (y) on the page
  const origW = w * fit;
  const origH = h * fit;
  let origX: number;
  let origY: number;
  let note: { x1: number; x2: number; yEnd: number };
  let divider: { x: number; yStart: number; yEnd: number } | null = null;
  let bannerBox: { x: number; y: number; w: number; h: number } | null = null;

  if (isLandscape) {
    origX = (bodyW - origW) / 2;
    origY = by + bodyH - margin - origH;
    note = { x1: margin, x2: bodyW - margin, yEnd: origY - margin * 2 };
    if (o.mode === 'feedback') {
      if (assets.banner) {
        const bannerW = bodyW - margin * 2;
        const bannerH = (bannerW * assets.banner.height) / assets.banner.width;
        const bannerY = origY - FEEDBACK_GAP - bannerH;
        bannerBox = { x: margin, y: bannerY, w: bannerW, h: bannerH };
        note.yEnd = bannerY - FEEDBACK_GAP;
      }
      divider = { x: bodyW / 2, yStart: by + margin, yEnd: note.yEnd };
    }
  } else {
    origX = margin;
    origY = by + margin + (bodyH - margin * 2 - origH) / 2;
    note = { x1: origX + origW + margin, x2: bodyW - margin, yEnd: by + bodyH - margin };
  }

  const lineGap = o.lineGap * scale;
  const yStart = by + margin + lineGap;

  // Original. drawPage rotates counter-clockwise about its origin, so the
  // origin is moved to where the rotated box's bottom-left corner lands.
  const place = { x: origX, y: origY, xScale: fit, yScale: fit, rotate: degrees(0) };
  if (rotation === 90) {
    place.rotate = degrees(-90);
    place.y = origY + rawW * fit;
  } else if (rotation === 180) {
    place.rotate = degrees(180);
    place.x = origX + rawW * fit;
    place.y = origY + rawH * fit;
  } else if (rotation === 270) {
    place.rotate = degrees(90);
    place.x = origX + rawH * fit;
  }
  if (embedded) {
    page.drawPage(embedded, place);
  }

  if (isLandscape) {
    page.drawRectangle({ x: origX, y: origY, width: origW, height: origH, borderColor: BORDER_COLOR, borderWidth: BORDER_WIDTH });
  }
  for (let y = yStart; y <= note.yEnd; y += lineGap) {
    page.drawLine({ start: { x: note.x1, y }, end: { x: note.x2, y }, thickness: LINE_WIDTH, color: LINE_COLOR, dashArray: LINE_DASH });
  }
  if (divider) {
    page.drawLine({ start: { x: divider.x, y: divider.yStart }, end: { x: divider.x, y: divider.yEnd }, thickness: DIVIDER_WIDTH, color: DIVIDER_COLOR });
  }
  if (bannerBox && assets.banner) {
    page.drawImage(assets.banner, { x: bannerBox.x, y: bannerBox.y, width: bannerBox.w, height: bannerBox.h });
  }

  // Header band (plus the body's top margin) and footer band (plus bottom margin).
  const fontSize = o.fontSize * scale;
  const padX = fontSize * HEADER_PAD_X_RATIO;
  const vars = { file: o.vars.file, date: o.vars.date, page: String(pageNumber), total: String(total) };
  if (hasHeader) {
    const zone = headerH + margin;
    const zoneBottom = pageH - zone;
    if (assets.mark) {
      let mw = o.markWidth * scale;
      let mh = (mw * assets.mark.height) / assets.mark.width;
      const maxH = Math.max(zone - 2, 1);
      if (mh > maxH) {
        mw = (mw * maxH) / mh;
        mh = maxH;
      }
      page.drawImage(assets.mark, { x: pageW - padX - mw, y: zoneBottom + (zone - mh) / 2, width: mw, height: mh });
    } else {
      drawBandText(page, assets.font, fontSize, expand(o.header.text, vars), o.header.align, padX, pageW, zoneBottom, zone);
    }
  }
  if (hasFooter) {
    drawBandText(page, assets.font, fontSize, expand(o.footer.text, vars), o.footer.align, padX, pageW, 0, footerH + margin);
  }
}

// Text vertically centred on its real ink height (ascent to descent) in the band.
function drawBandText(
  page: PDFPage,
  font: PDFFont,
  size: number,
  rawText: string,
  align: Align,
  padX: number,
  pageW: number,
  zoneBottom: number,
  zone: number
): void {
  const text = supportedChars(font, rawText.normalize('NFC'));
  if (!text) return;
  const ascent = font.heightAtSize(size, { descender: false });
  const full = font.heightAtSize(size);
  const descent = ascent - full; // negative
  const baseline = zoneBottom + (zone - full) / 2 - descent;
  const width = font.widthOfTextAtSize(text, size);
  const x = align === 'left' ? padX : align === 'center' ? (pageW - width) / 2 : pageW - padX - width;
  page.drawText(text, { x, y: baseline, size, font, color: HEADER_COLOR });
}

// Glyphs the font lacks (emoji, symbols) would print as boxes; drop them.
function supportedChars(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return Array.from(text)
    .filter((ch) => set.has(ch.codePointAt(0) as number))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function expand(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

async function embedImage(doc: PDFDocument, bytes: Uint8Array, warnings: string[], what: string): Promise<PDFImage | null> {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
    warnings.push(t('{0}: not a PNG or JPEG image', what));
  } catch (error) {
    warnings.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

// Case-insensitive ('a4', 'GalaxyTabS11'); 'original' or unknown names mean no fixed paper.
export function resolvePaper(name: string): [number, number] | null {
  const wanted = name.trim().toUpperCase();
  const key = Object.keys(PAPER_SIZES).find((k) => k.toUpperCase() === wanted);
  return key ? PAPER_SIZES[key] : null;
}

// Mirrors ipynb-pdf-converter's permission list onto pdf-lib's flags.
export function permissionFlags(allowed: string[]): {
  printing: boolean | 'highResolution';
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
} {
  return {
    printing: allowed.includes('print') ? 'highResolution' : false,
    modifying: allowed.includes('modify'),
    copying: allowed.includes('copy'),
    annotating: allowed.includes('annot-forms'),
    fillingForms: allowed.includes('annot-forms'),
  };
}
