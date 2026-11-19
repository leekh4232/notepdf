import { promises as fs } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { inlineImages, loadAsDataUrl, InlineOptions, InlineResult } from './images';

// An .html source is captured as it is, in a frame inside the webview. That
// frame cannot read files from disk, so everything the document links to is
// written into it first: stylesheets (with their @imports, images and fonts),
// local scripts and <img> files. https resources that are left as links load
// from the network when allowRemoteImages is on.

const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
const STYLE_ATTR = /(\bstyle\s*=\s*)(["'])([\s\S]*?)\2/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const SCRIPT_SRC = /<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gi;
const CSS_IMPORT = /@import\s+(?:url\(\s*(["']?)(.*?)\1\s*\)|(["'])(.*?)\3)([^;]*);/gi;
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const MEDIA_RULE = /@media\b([^{};]*)\{/gi;
const MAX_IMPORT_DEPTH = 3;

interface Context {
  allowRemote: boolean;
  failures: string[];
}

export async function inlineHtmlResources(html: string, baseDir: string, options: InlineOptions = {}): Promise<InlineResult> {
  const ctx: Context = { allowRemote: options.allowRemote !== false, failures: [] };
  const base = pathToFileURL(baseDir.endsWith('/') ? baseDir : `${baseDir}/`);

  // Own <style> blocks and style attributes first, so the sheets written in
  // below (already resolved against their own location) are not touched again.
  let out = await replaceAsync(html, STYLE_BLOCK, async (m) => m[1] + (await inlineCss(m[2], base, ctx, 0)) + m[3]);
  out = await replaceAsync(out, STYLE_ATTR, async (m) =>
    /url\(/i.test(m[3]) ? m[1] + m[2] + (await inlineCss(m[3], base, ctx, 0)) + m[2] : m[0]
  );
  out = await replaceAsync(out, LINK_TAG, async (m) => {
    const href = attr(m[0], 'href');
    if (!href || !/stylesheet/i.test(attr(m[0], 'rel') ?? '')) {
      return m[0];
    }
    try {
      const url = new URL(href, base);
      const css = await inlineCss(await readText(url, ctx), url, ctx, 0);
      const media = attr(m[0], 'media');
      return `<style${media ? ` media="${asPrintMedia(media)}"` : ''}>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
    } catch (error) {
      ctx.failures.push(describe(href, error));
      return m[0];
    }
  });
  out = await replaceAsync(out, SCRIPT_SRC, async (m) => {
    if (/^(https?:|data:|\/\/)/i.test(m[3])) {
      return m[0];
    }
    try {
      const code = await readText(new URL(m[3], base), ctx);
      return `<script${m[1]}${m[4]}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
    } catch (error) {
      ctx.failures.push(describe(m[3], error));
      return m[0];
    }
  });
  const images = await inlineImages(out, baseDir, options);
  return { html: images.html, failures: [...ctx.failures, ...images.failures] };
}

// Writes @imported sheets in place and turns relative url() references into
// data: URLs (local files) or absolute URLs (inside a remote sheet).
async function inlineCss(css: string, base: URL, ctx: Context, depth: number): Promise<string> {
  let out = await replaceAsync(css, CSS_IMPORT, async (m) => {
    const ref = m[2] ?? m[4];
    const condition = m[5].trim();
    if (depth >= MAX_IMPORT_DEPTH || /^(layer|supports)\b/i.test(condition)) {
      return m[0];
    }
    try {
      const url = new URL(ref, base);
      const sheet = await inlineCss(await readText(url, ctx), url, ctx, depth + 1);
      return condition ? `@media ${condition} {\n${sheet}\n}` : sheet;
    } catch (error) {
      ctx.failures.push(describe(ref, error));
      return m[0];
    }
  });
  out = await replaceAsync(out, CSS_URL, async (m) => {
    const ref = m[2].trim();
    if (!ref || /^(data:|blob:|https?:|\/\/|#)/i.test(ref)) {
      return m[0];
    }
    try {
      const url = new URL(ref, base);
      return `url("${url.protocol === 'file:' ? await loadAsDataUrl(url.href, '') : url.href}")`;
    } catch (error) {
      ctx.failures.push(describe(ref, error));
      return m[0];
    }
  });
  // The webview reports the editor's color theme as the preferred scheme. A
  // PDF is paper, so the document always gets its light styles, as in print.
  return out
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(max-width: 0px)')
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(min-width: 0px)')
    .replace(MEDIA_RULE, (_m, query: string) => `@media${asPrintMedia(query)}{`);
}

// The webview is a screen, but the capture becomes paper: `print` rules apply
// and `screen` rules do not, so a margin the document keeps for the browser
// only (@media screen) stays out of the PDF. Written so that `not screen` and
// `screen and (...)` still mean what they say.
function asPrintMedia(query: string): string {
  return query.replace(/\b(screen|print)\b/gi, (type) =>
    type.toLowerCase() === 'print' ? 'all' : 'all and (max-width: 0px)'
  );
}

async function readText(url: URL, ctx: Context): Promise<string> {
  if (url.protocol === 'file:') {
    return fs.readFile(fileURLToPath(url), 'utf-8');
  }
  if (!ctx.allowRemote) {
    throw new Error('remote resources are disabled (allowRemoteImages)');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function describe(ref: string, error: unknown): string {
  return `${ref} (${error instanceof Error ? error.message : String(error)})`;
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  const matches = [...text.matchAll(pattern)];
  const replacements = await Promise.all(matches.map(replacer));
  let index = 0;
  return text.replace(pattern, () => replacements[index++]);
}
