import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// The webview's CSP and localResourceRoots admit only the extension's own media
// folder, so images a document references by path or URL never load there.
// Rewrite every <img src> into a data: URL before the HTML reaches the webview.

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  // Fonts a stylesheet of an .html source refers to (htmlsource.ts).
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

export interface InlineResult {
  html: string;
  // One entry per image that could not be embedded: "src (reason)".
  failures: string[];
}

export interface InlineOptions {
  // false leaves http(s) images out and reports them (allowRemoteImages).
  allowRemote?: boolean;
}

export async function inlineImages(
  html: string,
  baseDir: string,
  options: InlineOptions = {}
): Promise<InlineResult> {
  const failures: string[] = [];
  const matches = [...html.matchAll(IMG_SRC)];
  const dataUrls = await Promise.all(
    matches.map(async (match) => {
      const src = decodeEntities(match[3]);
      if (/^(data|attachment|blob):/i.test(src)) {
        return undefined;
      }
      try {
        if (/^https?:/i.test(src) && options.allowRemote === false) {
          throw new Error('remote images are disabled (allowRemoteImages)');
        }
        return await loadAsDataUrl(src, baseDir);
      } catch (error) {
        failures.push(`${src} (${error instanceof Error ? error.message : String(error)})`);
        return undefined;
      }
    })
  );
  let index = 0;
  const out = html.replace(IMG_SRC, (whole, prefix: string, quote: string) => {
    const dataUrl = dataUrls[index++];
    return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : whole;
  });
  return { html: out, failures };
}

// Loads one image (path, file: or http(s) URL) as a data: URL; throws when it
// cannot be read or is not an image.
export async function loadAsDataUrl(src: string, baseDir: string): Promise<string> {
  const bare = src.split(/[?#]/)[0];
  let bytes: Buffer;
  let mime: string | undefined;
  if (/^https?:/i.test(src)) {
    const response = await fetch(src, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    mime = type?.startsWith('image/') ? type : undefined;
  } else {
    const file = src.startsWith('file:') ? fileURLToPath(src) : path.resolve(baseDir, safeDecode(bare));
    bytes = await fs.readFile(file);
  }
  mime = mime ?? MIME_BY_EXT[path.extname(bare).toLowerCase()] ?? sniffMime(bytes);
  if (!mime) {
    throw new Error('not a recognised image format');
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function sniffMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  const head = bytes.subarray(0, 1024).toString('utf8');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg\b/i.test(head)) return 'image/svg+xml';
  return undefined;
}

// marked percent-encodes URLs; raw <img> tags may carry them unencoded.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
