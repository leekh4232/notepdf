import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { PDFDocument, PDFFont, PDFPage, TextRenderingMode, popGraphicsState, pushGraphicsState, setCharacterSqueeze } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { renderNotebook, renderMarkdown } from './render';
import { Notebook } from './notebook';
import { isDarkColor, resolvePageTheme, resolveTheme } from './themes';
import { resolvePageDimensions } from './paper';
import { inlineImages, loadAsDataUrl } from './images';
import { permissionFlags } from './note';
import { registerNoteCommands } from './notes';
import { Mark, MARK_HEIGHT, markLabel, markPath, pickMark } from './marks';

let outputChannel: vscode.OutputChannel;

const SUPPORTED_EXTENSIONS = ['.ipynb', '.md'];

function isSupported(fsPath: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => fsPath.endsWith(ext));
}

// Vendored CSS assets never change during a session, so cache reads by path.
// A `null` entry records an absent optional file (e.g. a theme without chrome).
const cssCache = new Map<string, string | null>();

async function readAssetCached(filePath: string, optional = false): Promise<string> {
  const cached = cssCache.get(filePath);
  if (cached !== undefined) {
    return cached ?? '';
  }
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    cssCache.set(filePath, content);
    return content;
  } catch (error) {
    if (optional) {
      cssCache.set(filePath, null);
      return '';
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const TABLE_NOWRAP_MODES = ['first', 'all', 'none'] as const;
const LINE_NUMBER_MODES = ['auto', 'on', 'off'] as const;
const PAGE_BREAK_MODES = ['h1', 'h1-h2', 'none'] as const;
const IMAGE_FORMATS = ['png', 'jpeg'] as const;
const ALIGNMENTS = ['left', 'center', 'right'] as const;
const PERMISSIONS = ['print', 'modify', 'copy', 'annot-forms'] as const;

export type TableNowrap = (typeof TABLE_NOWRAP_MODES)[number];
export type LineNumberMode = (typeof LINE_NUMBER_MODES)[number];
export type PageBreakMode = (typeof PAGE_BREAK_MODES)[number];
export type ImageFormat = (typeof IMAGE_FORMATS)[number];
export type Alignment = (typeof ALIGNMENTS)[number];
export type Permission = (typeof PERMISSIONS)[number];

// Everything under notepdf.* except pdfPassword, which only the
// "with Password" command reads.
export interface Settings {
  pdfTheme: string;
  codeTheme: string;
  pdfPageSize: string;
  pdfPageOrientation: 'portrait' | 'landscape';
  pdfPageMargin: number;
  outputDirectory: string;
  outputFileName: string;
  openAfterConvert: boolean;
  headerText: string;
  footerText: string;
  headerAlign: Alignment;
  footerAlign: Alignment;
  headerFooterFontSize: number;
  pageBreakBefore: PageBreakMode;
  breakBeforeTags: string[];
  hideCodeCells: boolean;
  hideOutputs: boolean;
  excludeCellTags: string[];
  tableNowrap: TableNowrap;
  showLineNumbers: LineNumberMode;
  baseFontSize: number;
  bodyFontFamily: string;
  codeFontFamily: string;
  imageFormat: ImageFormat;
  jpegQuality: number;
  deviceScaleFactor: number;
  pdfPermissions: Permission[];
  ownerPassword: string;
  coverPage: boolean;
  coverTitle: string;
  coverSubtitle: string;
  coverAuthor: string;
  watermarkImage: string;
  watermarkWidth: number;
  allowRemoteImages: boolean;
  renderTimeoutSeconds: number;
  teacherMode: boolean;
}

// Mirrors the defaults declared in package.json.
export function defaultSettings(): Settings {
  return {
    pdfTheme: 'light',
    codeTheme: 'mdr-dark',
    pdfPageSize: 'A4',
    pdfPageOrientation: 'portrait',
    pdfPageMargin: 48,
    outputDirectory: '',
    outputFileName: '{name}',
    openAfterConvert: false,
    headerText: '{file}',
    footerText: '{page} / {total}',
    headerAlign: 'right',
    footerAlign: 'right',
    headerFooterFontSize: 10,
    pageBreakBefore: 'none',
    breakBeforeTags: [],
    hideCodeCells: false,
    hideOutputs: false,
    excludeCellTags: [],
    tableNowrap: 'first',
    showLineNumbers: 'auto',
    baseFontSize: 16,
    bodyFontFamily: '',
    codeFontFamily: '',
    imageFormat: 'png',
    jpegQuality: 85,
    deviceScaleFactor: 3,
    pdfPermissions: ['annot-forms'],
    ownerPassword: '',
    coverPage: false,
    coverTitle: '{file}',
    coverSubtitle: '',
    coverAuthor: '',
    watermarkImage: '',
    watermarkWidth: 100,
    allowRemoteImages: true,
    renderTimeoutSeconds: 60,
    teacherMode: false,
  };
}

interface ConfigLike {
  get<T>(key: string, defaultValue: T): T;
}

// Reads and validates every setting; anything malformed falls back to its default.
export function readSettings(config: ConfigLike): Settings {
  const d = defaultSettings();
  const str = (key: keyof Settings): string => {
    const value = config.get<unknown>(key, d[key]);
    return typeof value === 'string' ? value : String(d[key]);
  };
  const bool = (key: keyof Settings): boolean => Boolean(config.get<unknown>(key, d[key]));
  const num = (key: keyof Settings, min: number, max: number): number => {
    const value = Number(config.get<unknown>(key, d[key]));
    return clamp(Number.isFinite(value) ? value : (d[key] as number), min, max);
  };
  const list = (key: keyof Settings): string[] => {
    const value = config.get<unknown>(key, d[key]);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  };
  const pick = <T extends string>(key: keyof Settings, allowed: readonly T[]): T => {
    const value = str(key);
    return (allowed as readonly string[]).includes(value) ? (value as T) : (d[key] as T);
  };
  return {
    pdfTheme: str('pdfTheme'),
    codeTheme: str('codeTheme'),
    pdfPageSize: str('pdfPageSize'),
    pdfPageOrientation: pick('pdfPageOrientation', ['portrait', 'landscape'] as const),
    pdfPageMargin: num('pdfPageMargin', 0, 200),
    outputDirectory: str('outputDirectory').trim(),
    outputFileName: str('outputFileName').trim() || d.outputFileName,
    openAfterConvert: bool('openAfterConvert'),
    headerText: str('headerText'),
    footerText: str('footerText'),
    headerAlign: pick('headerAlign', ALIGNMENTS),
    footerAlign: pick('footerAlign', ALIGNMENTS),
    headerFooterFontSize: num('headerFooterFontSize', 6, 24),
    pageBreakBefore: pick('pageBreakBefore', PAGE_BREAK_MODES),
    breakBeforeTags: list('breakBeforeTags'),
    hideCodeCells: bool('hideCodeCells'),
    hideOutputs: bool('hideOutputs'),
    excludeCellTags: list('excludeCellTags'),
    tableNowrap: pick('tableNowrap', TABLE_NOWRAP_MODES),
    showLineNumbers: pick('showLineNumbers', LINE_NUMBER_MODES),
    baseFontSize: num('baseFontSize', 8, 32),
    bodyFontFamily: sanitizeFontFamily(str('bodyFontFamily')),
    codeFontFamily: sanitizeFontFamily(str('codeFontFamily')),
    imageFormat: pick('imageFormat', IMAGE_FORMATS),
    jpegQuality: num('jpegQuality', 10, 100),
    deviceScaleFactor: num('deviceScaleFactor', 1, 5),
    pdfPermissions: list('pdfPermissions').filter((p): p is Permission =>
      (PERMISSIONS as readonly string[]).includes(p)
    ),
    ownerPassword: str('ownerPassword'),
    coverPage: bool('coverPage'),
    coverTitle: str('coverTitle'),
    coverSubtitle: str('coverSubtitle'),
    coverAuthor: str('coverAuthor'),
    watermarkImage: str('watermarkImage').trim(),
    watermarkWidth: num('watermarkWidth', 10, 2000),
    allowRemoteImages: bool('allowRemoteImages'),
    renderTimeoutSeconds: num('renderTimeoutSeconds', 10, 600),
    teacherMode: bool('teacherMode'),
  };
}

// The value is dropped into a <style> block; strip anything that could end
// the declaration or the element.
function sanitizeFontFamily(value: string): string {
  return value.replace(/[;{}<>]/g, '').trim();
}

// {file} = file name without extension, {name} = same (output file names),
// {date} = local YYYY-MM-DD. {page}/{total} are filled in per page later.
export function expandPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// The teacher commands (marks.ts) ask for an instructor mark first. The menus
// show them only while the teacherMode setting is on.
const COMMANDS: { id: string; withPassword: boolean; teacher?: boolean }[] = [
  { id: 'ipynb-pdf-converter.convertToPdf', withPassword: false },
  { id: 'ipynb-pdf-converter.convertToPdfWithPassword', withPassword: true },
  { id: 'ipynb-pdf-converter.convertToPdfTeacher', withPassword: false, teacher: true },
  { id: 'ipynb-pdf-converter.convertToPdfTeacherWithPassword', withPassword: true, teacher: true },
];

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('NotePDF');

  for (const { id, withPassword, teacher } of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown, selected?: unknown) => {
        // The explorer passes the clicked Uri plus every selected Uri; other
        // menus pass one Uri, and notebook cell menus a cell context, so fall
        // back to the active editor's file.
        const targets =
          Array.isArray(selected) && selected.length > 0 && selected.every((u) => u instanceof vscode.Uri)
            ? (selected as vscode.Uri[])
            : [arg instanceof vscode.Uri ? arg : resolveActiveSourceUri()];
        const filePaths = targets.flatMap((u) => (u && isSupported(u.fsPath) ? [u.fsPath] : []));
        if (filePaths.length === 0) {
          vscode.window.showErrorMessage('Please select a .ipynb or .md file');
          return;
        }
        // One mark and one password for the whole selection.
        const mark = teacher ? await pickMark() : undefined;
        if (teacher && mark === undefined) {
          return; // prompt dismissed
        }
        const password = withPassword ? await resolvePassword() : undefined;
        if (withPassword && password === undefined) {
          return; // prompt dismissed
        }
        await convertFilesToPdf(context, filePaths, password, mark);
      })
    );
  }

  registerNoteCommands(context, outputChannel, async (filePath, token, onProgress) => {
    const settings = {
      ...readSettings(vscode.workspace.getConfiguration('notepdf')),
      headerText: '',
      footerText: '',
    };
    const baseName = path.basename(filePath).replace(/\.(ipynb|md)$/i, '');
    const vars = { file: baseName, name: baseName, date: localDate() };
    const { buffer } = await producePdf(context, filePath, settings, vars, undefined, undefined, token, onProgress);
    return buffer;
  });

  void migrateSettings(context);
  void offerAutoUpdate(context);
}

// Settings were named ipynb-pdf-converter.* up to 0.12.x. Move any value the
// user set there to notepdf.* (unless the new name is already set) and drop
// the old entry, so an update keeps their configuration.
async function migrateSettings(context: vscode.ExtensionContext): Promise<void> {
  const oldConfig = vscode.workspace.getConfiguration('ipynb-pdf-converter');
  const newConfig = vscode.workspace.getConfiguration('notepdf');
  const sections: { properties: Record<string, unknown> }[] = context.extension.packageJSON.contributes.configuration;
  const keys = sections.flatMap((section) => Object.keys(section.properties)).map((name) => name.slice('notepdf.'.length));
  const targets = [
    [vscode.ConfigurationTarget.Global, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, 'workspaceValue'],
  ] as const;
  for (const key of keys) {
    const oldValues = oldConfig.inspect(key);
    const newValues = newConfig.inspect(key);
    for (const [target, field] of targets) {
      if (oldValues?.[field] === undefined) {
        continue;
      }
      try {
        if (newValues?.[field] === undefined) {
          await newConfig.update(key, oldValues[field], target);
        }
        await oldConfig.update(key, undefined, target);
      } catch (error) {
        outputChannel.appendLine(`⚠️ Could not migrate setting ${key}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}

// Whether an extension auto-updates is the user's VS Code setting
// (extensions.autoUpdate); a manifest cannot opt in. So, once, when updates are
// off, offer to turn them on so fixes reach the user.
const AUTO_UPDATE_OFFERED = 'autoUpdateOffered';
async function offerAutoUpdate(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(AUTO_UPDATE_OFFERED)) {
    return;
  }
  const config = vscode.workspace.getConfiguration('extensions');
  // Older VS Code uses true/false, newer 'on'/'off'; 'onlySelectedExtensions'
  // leaves a fresh install unselected. Anything unrecognised is left alone.
  const mode = config.get<boolean | string>('autoUpdate');
  if (mode !== false && mode !== 'off' && mode !== 'onlySelectedExtensions') {
    return;
  }
  await context.globalState.update(AUTO_UPDATE_OFFERED, true);
  const turnOn = 'Turn on auto-update';
  const choice = await vscode.window.showInformationMessage(
    'NotePDF: extension auto-update is off, so fixes and new features will not arrive on their own. Turn it on for all extensions?',
    turnOn,
    'Not now'
  );
  if (choice === turnOn) {
    const on = config.inspect('autoUpdate')?.defaultValue === true ? true : 'on';
    await config.update('autoUpdate', on, vscode.ConfigurationTarget.Global);
  }
}

// The "with Password" command uses the configured default and prompts only when
// it is empty. The plain command never encrypts, even if a default is set.
async function resolvePassword(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('notepdf')
    .get<string>('pdfPassword', '');
  if (configured) {
    return configured;
  }
  return vscode.window.showInputBox({
    title: 'PDF Password',
    prompt: 'No default password is set (notepdf.pdfPassword). Enter a password for this PDF.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value ? undefined : 'Password cannot be empty'),
  });
}

// Converts the files one after another. A single file reports its own result;
// a selection gets one summary at the end, and cancelling stops the rest.
async function convertFilesToPdf(
  context: vscode.ExtensionContext,
  filePaths: string[],
  password?: string,
  mark?: Mark
): Promise<void> {
  const settings = readSettings(vscode.workspace.getConfiguration('notepdf'));
  const batch = filePaths.length > 1;
  const results: ConversionResult[] = [];

  // The log stays in the background; the progress notification is the UI.
  outputChannel.clear();
  for (const [i, filePath] of filePaths.entries()) {
    const fileName = path.basename(filePath);
    const baseName = fileName.replace(/\.(ipynb|md)$/i, '');
    const vars = { file: baseName, name: baseName, date: localDate() };
    const counter = batch ? ` (${i + 1}/${filePaths.length})` : '';
    outputChannel.appendLine(`📝 Converting${counter}: ${fileName} → PDF`);

    // The notification carries a progress bar and a cancel button; stages add up to 100.
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Converting ${fileName} to PDF${counter}`, cancellable: true },
      (progress, token) => runConversion(context, filePath, password, mark, settings, vars, progress, token, !batch)
    );
    results.push(result);
    if (result === 'cancelled') {
      break;
    }
  }
  if (batch) {
    reportBatch(results, filePaths.length, password !== undefined);
  }
}

type ConversionResult = 'ok' | 'warned' | 'failed' | 'cancelled';

function reportBatch(results: ConversionResult[], total: number, encrypted: boolean): void {
  const converted = results.filter((r) => r === 'ok' || r === 'warned').length;
  const failed = results.filter((r) => r === 'failed').length;
  const warned = results.filter((r) => r === 'warned').length;
  const skipped = total - results.length;
  let summary = `Converted ${converted} of ${total} files to PDF${encrypted ? ' (password protected)' : ''}`;
  if (failed > 0) summary += `, ${failed} failed`;
  if (skipped > 0) summary += `, ${skipped} skipped after cancel`;
  if (warned > 0) summary += `, ${warned} with images that could not be embedded`;
  if (failed > 0 || warned > 0) {
    vscode.window.showWarningMessage(`⚠️ ${summary}`, 'Show Log').then((choice) => {
      if (choice === 'Show Log') outputChannel.show();
    });
  } else {
    vscode.window.showInformationMessage(`✅ ${summary}`);
  }
}

async function runConversion(
  context: vscode.ExtensionContext,
  filePath: string,
  password: string | undefined,
  mark: Mark | undefined,
  settings: Settings,
  vars: Record<string, string>,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  notify: boolean
): Promise<ConversionResult> {
  const fileName = path.basename(filePath);
  const baseName = vars.name;
  try {
    const sourceDir = path.dirname(filePath);
    const outputDir = settings.outputDirectory
      ? path.resolve(sourceDir, settings.outputDirectory)
      : sourceDir;
    const outputName = (expandPlaceholders(settings.outputFileName, vars) || baseName).replace(/\.pdf$/i, '');

    // producePdf reports fractions 0..1; the notification wants increments summing to 100.
    let reached = 0;
    const { buffer, pages, warnings } = await producePdf(context, filePath, settings, vars, password, mark, token, (message, fraction) => {
      const next = Math.round(fraction * 90);
      progress.report({ message, increment: next - reached });
      reached = next;
    });
    progress.report({ message: 'Saving…', increment: 100 - reached });
    await fs.mkdir(outputDir, { recursive: true });
    // Never overwrite: an existing "name.pdf" yields "name (1).pdf", then "(2)"…
    const outputPath = await uniquePdfPath(outputDir, outputName);
    await fs.writeFile(outputPath, buffer);
    outputChannel.appendLine(`✅ Saved: ${outputPath} (${pages} page${pages === 1 ? '' : 's'})`);
    const summary = `✅ Converted to PDF${password ? ' (password protected)' : ''}: ${path.basename(outputPath)}`;
    if (settings.openAfterConvert) {
      await vscode.env.openExternal(vscode.Uri.file(outputPath));
    }
    if (warnings > 0) {
      outputChannel.appendLine(`⚠️ ${warnings} image${warnings === 1 ? '' : 's'} could not be embedded`);
    }
    if (!notify) {
      return warnings > 0 ? 'warned' : 'ok';
    }
    // Not awaited: the progress notification must close when this function returns.
    if (warnings > 0) {
      vscode.window
        .showWarningMessage(`${summary} — ${warnings} image${warnings === 1 ? '' : 's'} could not be embedded`, 'Show Log')
        .then((choice) => {
          if (choice === 'Show Log') outputChannel.show();
        });
    } else {
      vscode.window.showInformationMessage(summary);
    }
    return warnings > 0 ? 'warned' : 'ok';
  } catch (error) {
    if (token.isCancellationRequested) {
      outputChannel.appendLine('⏹ Cancelled');
      vscode.window.showInformationMessage(`Conversion of ${fileName} cancelled`);
      return 'cancelled';
    }
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`❌ Error: ${message}`);
    if (notify) {
      vscode.window.showErrorMessage(`Failed to convert notebook: ${message}`, 'Show Log').then((choice) => {
        if (choice === 'Show Log') outputChannel.show();
      });
    }
    return 'failed';
  }
}

// Renders the source to PDF bytes: document assembly, webview capture and
// pdf-lib assembly. Shared by the convert and note commands.
async function producePdf(
  context: vscode.ExtensionContext,
  filePath: string,
  settings: Settings,
  vars: Record<string, string>,
  password: string | undefined,
  mark: Mark | undefined,
  token: vscode.CancellationToken,
  report: (message: string, fraction: number) => void
): Promise<{ buffer: Buffer; pages: number; warnings: number }> {
  const sourceDir = path.dirname(filePath);
  report('Rendering document…', 0.05);
  const raw = await fs.readFile(filePath, 'utf-8');
  let warnings = 0;
  const bodyHtml = await buildDocumentHtml(filePath, raw, settings, vars, (warning) => {
    warnings++;
    outputChannel.appendLine(`⚠️ ${warning}`);
  });

  let markImage: string | undefined;
  if (mark) {
    try {
      markImage = await loadAsDataUrl(markPath(context, mark), sourceDir);
      outputChannel.appendLine(`🖼️ Teacher mode: ${markLabel(mark)} mark on every page`);
    } catch (error) {
      outputChannel.appendLine(
        `⚠️ Instructor mark not available (${markPath(context, mark)}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const layout = resolveLayout(settings);
  const theme = resolveTheme(settings.codeTheme);
  const pageTheme = resolvePageTheme(settings.pdfTheme);
  outputChannel.appendLine(
    `Rendering in webview (page theme: ${pageTheme.info.label}, code theme: ${theme.info.label}, ` +
      `paper: ${layout.key} ${settings.pdfPageOrientation} = ${layout.widthPx}×${layout.heightPx}px CSS, ` +
      `margin: ${layout.margin}px, scale: ${settings.deviceScaleFactor}x, pages as ${settings.imageFormat.toUpperCase()})…`
  );
  report('Capturing pages…', 0.1);
  // The webview reports each captured chunk; capture spans 10%..85%.
  const { pages, texts } = await captureInWebview(context, { bodyHtml, settings, vars, markImage }, token, (done, total) =>
    report(`Capturing pages… (${done}/${total})`, 0.1 + (done / total) * 0.75)
  );

  report('Assembling PDF…', 0.9);
  outputChannel.appendLine(
    `Assembling PDF (${pages.length} page${pages.length === 1 ? '' : 's'}${password ? ', password protected' : ''})…`
  );
  const buffer = await generatePdfFromPages(pages, texts, layout.widthPx, layout.heightPx, {
    fontBytes: await readTextFont(context),
    password,
    ownerPassword: settings.ownerPassword,
    permissions: settings.pdfPermissions,
  });
  report('Assembled', 1);
  return { buffer, pages: pages.length, warnings };
}

export async function uniquePdfPath(dir: string, name: string): Promise<string> {
  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  let candidate = path.join(dir, `${name}.pdf`);
  for (let n = 1; await exists(candidate); n++) {
    candidate = path.join(dir, `${name} (${n}).pdf`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Document assembly (no vscode API, so it can be exercised outside the host)
// ---------------------------------------------------------------------------

// Renders the source, prepends the optional cover, appends the optional
// watermark and embeds every referenced image as a data: URL.
export async function buildDocumentHtml(
  filePath: string,
  raw: string,
  settings: Settings,
  vars: Record<string, string>,
  warn: (message: string) => void
): Promise<string> {
  const rendered = filePath.toLowerCase().endsWith('.md')
    ? renderMarkdown(raw)
    : renderNotebook(JSON.parse(raw) as Notebook, {
        hideCodeCells: settings.hideCodeCells,
        hideOutputs: settings.hideOutputs,
        excludeCellTags: settings.excludeCellTags,
        breakBeforeTags: settings.breakBeforeTags,
      });
  // The watermark goes last: it is absolutely positioned, so order only
  // decides paint order, and the cover must stay the first element in flow.
  const cover = settings.coverPage ? coverHtml(settings, vars) : '';
  const watermark = settings.watermarkImage
    ? `<img class="jp-Watermark" src="${escapeAttr(settings.watermarkImage)}" style="width:${settings.watermarkWidth}px" alt="" />`
    : '';
  // Referenced images (relative/absolute paths, file: or http(s) URLs) are
  // embedded as data: URLs; the webview cannot load them from disk itself.
  const { html, failures } = await inlineImages(cover + rendered + watermark, path.dirname(filePath), {
    allowRemote: settings.allowRemoteImages,
  });
  for (const failure of failures) {
    warn(`Image not embedded: ${failure}`);
  }
  return html;
}

// A full-page cover: .jp-PageBreakAfter makes the paginator end the page
// exactly at its bottom edge, and the CSS sizes it to one content area.
function coverHtml(settings: Settings, vars: Record<string, string>): string {
  const title = expandPlaceholders(settings.coverTitle || '{file}', vars);
  const subtitle = expandPlaceholders(settings.coverSubtitle, vars);
  const author = expandPlaceholders(settings.coverAuthor, vars);
  return (
    `<section class="pdf-cover jp-PageBreakAfter"><h1>${escapeHtml(title)}</h1>` +
    (subtitle ? `<p class="pdf-cover-subtitle">${escapeHtml(subtitle)}</p>` : '') +
    (author ? `<p class="pdf-cover-author">${escapeHtml(author)}</p>` : '') +
    `</section>`
  );
}

interface Layout {
  key: string;
  widthPx: number;
  heightPx: number;
  margin: number;
}

function resolveLayout(settings: Settings): Layout {
  const page = resolvePageDimensions(settings.pdfPageSize, settings.pdfPageOrientation);
  const margin = clamp(
    settings.pdfPageMargin,
    0,
    Math.min(Math.floor(page.widthPx / 2) - 1, Math.floor(page.heightPx / 2) - 1)
  );
  return { key: page.key, widthPx: page.widthPx, heightPx: page.heightPx, margin };
}

export interface CaptureParams {
  bodyHtml: string;
  settings: Settings;
  vars: Record<string, string>;
  // data: URL of the instructor mark (teacher mode); replaces the header text.
  markImage?: string;
}

// One line of text on a page, in CSS px from the page's top-left corner.
export interface TextRun {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fs: number; // font size
}

export interface CaptureResult {
  pages: string[]; // one image data: URL per page
  texts: TextRun[][]; // the text drawn on each page, for the invisible text layer
}

let textFontCache: Uint8Array | undefined;

// The text layer needs a font with Hangul; only the glyphs used are embedded.
async function readTextFont(context: vscode.ExtensionContext): Promise<Uint8Array> {
  if (!textFontCache) {
    const fontPath = context.asAbsolutePath(path.join('media', 'fonts', 'NanumGothic.ttf'));
    textFontCache = new Uint8Array(await fs.readFile(fontPath));
  }
  return textFontCache;
}

async function captureInWebview(
  context: vscode.ExtensionContext,
  params: CaptureParams,
  token: vscode.CancellationToken,
  onProgress: (done: number, total: number) => void
): Promise<CaptureResult> {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');

  const panel = vscode.window.createWebviewPanel(
    'ipynbPdfRenderer',
    'Converting notebook…',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    }
  );

  const html2canvasUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(mediaRoot, 'html2canvas.min.js')
  );

  let html: string;
  try {
    html = await buildCaptureHtml(
      mediaRoot.fsPath,
      params,
      panel.webview.cspSource,
      html2canvasUri.toString()
    );
  } catch (error) {
    panel.dispose();
    throw error;
  }

  const timeoutSeconds = params.settings.renderTimeoutSeconds;
  return new Promise((resolve, reject) => {
    const disposables: vscode.Disposable[] = [];
    const finish = (settle: () => void) => {
      clearTimeout(timeout);
      disposables.forEach((d) => d.dispose());
      panel.dispose();
      settle();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`Webview rendering timed out after ${timeoutSeconds}s (renderTimeoutSeconds)`))),
      timeoutSeconds * 1000
    );

    disposables.push(
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'progress') {
          onProgress(Number(msg.done), Number(msg.total));
        } else if (msg?.type === 'result') {
          const pages = msg.pages as string[];
          const texts = (msg.texts as TextRun[][] | undefined) ?? pages.map(() => []);
          finish(() => resolve({ pages, texts }));
        } else if (msg?.type === 'error') {
          finish(() => reject(new Error(String(msg.message ?? 'Unknown webview error'))));
        }
      }),
      token.onCancellationRequested(() => finish(() => reject(new Error('Cancelled')))),
      // Closing the panel by hand also cancels.
      panel.onDidDispose(() => finish(() => reject(new Error('Cancelled: the conversion view was closed'))))
    );

    panel.webview.html = html;
  });
}

// Builds the page the webview renders and captures. Free of the vscode API so
// it can be exercised outside the extension host.
export async function buildCaptureHtml(
  mediaDir: string,
  params: CaptureParams,
  cspSource: string,
  html2canvasUri: string
): Promise<string> {
  const { bodyHtml, settings, vars, markImage } = params;
  const asset = (...segments: string[]) => path.join(mediaDir, ...segments);
  const layout = resolveLayout(settings);
  const theme = resolveTheme(settings.codeTheme);
  const pageTheme = resolvePageTheme(settings.pdfTheme);
  const themeKey = theme.key;
  const captureWidth = layout.widthPx - 2 * layout.margin;

  // Inline CSS into a <style> tag. html2canvas clones the DOM into an iframe
  // and cannot fetch external stylesheets across webview origins, so <link>
  // tags would produce an unstyled capture even though the live webview looks
  // correct. Order matters: later sheets override earlier ones.
  // 'default' keeps the GitHub look plus the optional per-code-theme chrome
  // (headings, tables, output accents). The Markdown Reader themes replace
  // github-markdown.css with mdr.css and own the page chrome themselves.
  const isMdr = pageTheme.key !== 'default';
  const sheets = isMdr
    ? [
        readAssetCached(asset('page-themes', 'mdr.css')),
        readAssetCached(asset('themes', `${themeKey}.css`)),
        readAssetCached(asset('styles.css')),
        readAssetCached(asset('page-themes', 'mdr-overrides.css')),
      ]
    : [
        readAssetCached(asset('github-markdown.css')),
        readAssetCached(asset('themes', `${themeKey}.css`)),
        readAssetCached(asset('styles.css')),
        readAssetCached(asset('themes', `${themeKey}.chrome.css`), true),
      ];
  const css = (await Promise.all(sheets)).join('\n');

  // The Markdown Reader themes add nb_convert.py's 30 px body margin on top of
  // the first page; the cover fills what is left of that page.
  const coverHeight = layout.heightPx - 2 * layout.margin - (isMdr ? 30 : 0);
  const themeVars = `:root {
  --capture-width: ${captureWidth}px;
  --cover-height: ${coverHeight}px;
  --code-bg: ${theme.info.background};
  --code-fg: ${theme.info.foreground};
  --code-border: ${theme.info.border};
  --line-number-color: ${theme.info.lineNumber};
}`;
  // User overrides win over every theme sheet.
  const userCss = [
    settings.baseFontSize !== 16 ? `html, body { font-size: ${settings.baseFontSize}px; }` : '',
    settings.bodyFontFamily
      ? `body, .mdr-content, .markdown-body { font-family: ${settings.bodyFontFamily} !important; }`
      : '',
    settings.codeFontFamily
      ? `.jp-InputArea-editor pre, .jp-RenderedText, .markdown-body pre, .markdown-body code, ` +
        `.mdr-content pre, .mdr-content code { font-family: ${settings.codeFontFamily} !important; }`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  // mdr.css selects its palette from these attributes and expects the content
  // wrapped in body.mdr-pre.mdr > article.mdr-content (apply_mdr_dom in nb_convert.py).
  const codeBlockTheme = isDarkColor(theme.info.background) ? 'dark' : 'light';
  const htmlAttrs =
    ` data-table-nowrap="${settings.tableNowrap}"` +
    (settings.showLineNumbers !== 'auto' ? ` data-line-numbers="${settings.showLineNumbers}"` : '') +
    (isMdr ? ` data-mdr-theme="${pageTheme.key}" data-mdr-code-block-theme="${codeBlockTheme}"` : '');
  const bodyAttrs = isMdr ? ' class="mdr-pre mdr"' : '';
  const content = isMdr ? `<article class="mdr-content">${bodyHtml}</article>` : bodyHtml;

  const breakBeforeSelector = {
    h1: 'h1, .jp-PageBreakBefore',
    'h1-h2': 'h1, h2, .jp-PageBreakBefore',
    none: '.jp-PageBreakBefore',
  }[settings.pageBreakBefore];

  return buildWebviewHtml({
    bodyHtml: content,
    htmlAttrs,
    bodyAttrs,
    cspSource,
    html2canvasUri,
    inlineCss: `${themeVars}\n${css}\n${userCss}`,
    config: {
      scale: settings.deviceScaleFactor,
      pageW: layout.widthPx,
      pageH: layout.heightPx,
      margin: layout.margin,
      background: pageTheme.info.background,
      imageFormat: settings.imageFormat,
      jpegQuality: settings.jpegQuality / 100,
      header: { text: expandPlaceholders(settings.headerText, vars), align: settings.headerAlign },
      footer: { text: expandPlaceholders(settings.footerText, vars), align: settings.footerAlign },
      runningFontPx: settings.headerFooterFontSize,
      breakBeforeSelector,
      mark: markImage ? { image: markImage, height: MARK_HEIGHT } : null,
    },
  });
}

interface WebviewConfig {
  scale: number;
  pageW: number;
  pageH: number;
  margin: number;
  background: string;
  imageFormat: ImageFormat;
  jpegQuality: number;
  header: { text: string; align: Alignment };
  footer: { text: string; align: Alignment };
  runningFontPx: number;
  breakBeforeSelector: string;
  mark: { image: string; height: number } | null;
}

function buildWebviewHtml(params: {
  bodyHtml: string;
  htmlAttrs: string;
  bodyAttrs: string;
  cspSource: string;
  html2canvasUri: string;
  inlineCss: string;
  config: WebviewConfig;
}): string {
  const { bodyHtml, htmlAttrs, bodyAttrs, cspSource, html2canvasUri, inlineCss, config } = params;
  // The config lands inside a <script>; keep it JSON-safe and tag-safe.
  const configJs = JSON.stringify(config).replace(/</g, '\\u003c');
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en"${htmlAttrs}>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>${inlineCss}</style>
<script src="${html2canvasUri}"></script>
</head>
<body${bodyAttrs}>
<div id="capture-root">${bodyHtml}</div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const cfg = ${configJs};
  const scale = cfg.scale;
  const contentH = cfg.pageH - 2 * cfg.margin;
  // Running header and footer sit in the margin band. They are drawn on the
  // canvas so Korean text uses the system fonts instead of a PDF-embedded one.
  const RUNNING_COLOR = '#909090';
  // CSS px kept together at the top and bottom of a box (border + padding +
  // one line), so a page never ends with a bare box edge or an orphaned heading.
  const EDGE = 32;

  // Ranges (CSS px from the top of #capture-root) a page may not cut through.
  // Mirrors how WeasyPrint paginates the same document in nb_convert.py: never
  // inside a line of text, a table row or an image.
  function collectKeepTogether(root) {
    const rootTop = root.getBoundingClientRect().top;
    const boxes = [];
    const add = (top, bottom) => {
      if (bottom - top > 0.5) boxes.push({ top: top - rootTop, bottom: bottom - rootTop });
    };
    // The watermark is absolutely positioned and must not steer the cuts.
    root.querySelectorAll('tr, img:not(.jp-Watermark), svg, figure').forEach((el) => {
      const r = el.getBoundingClientRect();
      add(r.top, r.bottom);
    });
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el) => {
      const r = el.getBoundingClientRect();
      add(r.top, r.bottom + EDGE);
    });
    root.querySelectorAll('pre, blockquote, table, ul, ol, .jp-InputArea-editor, .jp-OutputArea').forEach((el) => {
      const r = el.getBoundingClientRect();
      add(r.top, Math.min(r.bottom, r.top + EDGE));
      add(Math.max(r.top, r.bottom - EDGE), r.bottom);
    });
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) add(r.top, r.bottom);
    }
    return boxes;
  }

  // Page starts forced by the pageBreakBefore setting (nb_convert.py: h1 { break-before: page }),
  // by tagged cells (.jp-PageBreakBefore) and after the cover (.jp-PageBreakAfter).
  // An element already at the very top of the document needs no break.
  function forcedBreaks(root, boxes) {
    const rootTop = root.getBoundingClientRect().top;
    const firstTop = boxes.reduce((min, b) => Math.min(min, b.top), Infinity);
    const tops = Array.from(root.querySelectorAll(cfg.breakBeforeSelector))
      .filter((el) => !el.closest('.pdf-cover')) // the cover's own title is not a section start
      .map((el) => el.getBoundingClientRect().top - rootTop);
    const bottoms = Array.from(root.querySelectorAll('.jp-PageBreakAfter')).map(
      (el) => el.getBoundingClientRect().bottom - rootTop
    );
    return tops.concat(bottoms).filter((y) => y > firstTop + 2);
  }

  function computeCuts(totalH, pageH, boxes, forced) {
    const cuts = [];
    // A forced break that would leave the page empty (e.g. a heading right
    // after the cover, or two breaks back to back) is skipped.
    const hasContent = (from, to) => boxes.some((b) => b.top >= from - 0.5 && b.top < to);
    let y = 0;
    while (y < totalH - 0.5) {
      let end = Math.min(y + pageH, totalH);
      const nextForced = forced.find((f) => f > y + 1 && f < end && hasContent(y, f));
      if (nextForced !== undefined) {
        end = nextForced;
      } else if (end < totalH) {
        // Pull the cut up to the top of whatever it would split; a box that
        // started on this page already (taller than the page) is cut anyway.
        for (let moved = true, guard = 0; moved && guard < 10000; guard++) {
          moved = false;
          for (const b of boxes) {
            if (b.top < end - 0.5 && b.bottom > end + 0.5 && b.top > y + 1) {
              end = b.top;
              moved = true;
            }
          }
        }
      }
      cuts.push([y, end]);
      y = end;
    }
    return cuts;
  }

  function encodePage(canvas) {
    return cfg.imageFormat === 'jpeg'
      ? canvas.toDataURL('image/jpeg', cfg.jpegQuality)
      : canvas.toDataURL('image/png');
  }

  // Chromium caps a canvas at 32,767 px per side and html2canvas then returns
  // a blank one, which a long notebook at scale 3 hits after about ten pages.
  // So the document is captured in chunks that end on page cuts.
  const MAX_CHUNK_PX = 16000;

  function groupCuts(cuts, maxChunkCss) {
    const chunks = [];
    let chunk = null;
    for (const cut of cuts) {
      if (!chunk || cut[1] - chunk.top > maxChunkCss) {
        chunk = { top: cut[0], bottom: cut[1], cuts: [] };
        chunks.push(chunk);
      }
      chunk.cuts.push(cut);
      chunk.bottom = cut[1];
    }
    return chunks;
  }

  // Each page as { image, text }: the text runs whose middle falls inside the
  // page's cut, moved into page coordinates, plus the header and footer.
  function sliceIntoPages(srcCanvas, chunk, firstPageNo, pageCount, runs) {
    const W = Math.round(cfg.pageW * scale);
    const H = Math.round(cfg.pageH * scale);
    const M = Math.round(cfg.margin * scale);
    return chunk.cuts.map(([y0, y1], i) => {
      const sy = Math.round((y0 - chunk.top) * scale);
      const sh = Math.min(Math.round((y1 - chunk.top) * scale), srcCanvas.height) - sy;
      const page = document.createElement('canvas');
      page.width = W;
      page.height = H;
      const ctx = page.getContext('2d');
      ctx.fillStyle = cfg.background;
      ctx.fillRect(0, 0, W, H);
      if (sh > 0) ctx.drawImage(srcCanvas, 0, sy, srcCanvas.width, sh, M, M, srcCanvas.width, sh);
      const text = runs
        .filter((r) => r.y + r.h / 2 >= y0 && r.y + r.h / 2 < y1)
        .map((r) => ({ t: r.t, x: cfg.margin + r.x, y: cfg.margin + r.y - y0, w: r.w, h: r.h, fs: r.fs }));
      text.push(...drawRunning(ctx, W, H, M, firstPageNo + i, pageCount));
      return { image: encodePage(page), text };
    });
  }

  let markImg = null; // teacher mode: decoded instructor mark

  // Returns the header/footer as text runs (CSS px) for the text layer.
  function drawRunning(ctx, W, H, M, pageNo, pageCount) {
    const runs = [];
    const px = cfg.runningFontPx * scale;
    ctx.fillStyle = RUNNING_COLOR;
    ctx.font = px + 'px "Helvetica Neue", -apple-system, "Segoe UI", "Noto Sans CJK KR", sans-serif';
    ctx.textBaseline = 'middle';
    const place = (part, y) => {
      if (!part.text || M < 2 * px) return; // margin band too thin to hold the text
      const text = fitText(
        ctx,
        part.text.replace(/\\{page\\}/g, String(pageNo)).replace(/\\{total\\}/g, String(pageCount)),
        W - 2 * M
      );
      ctx.textAlign = part.align;
      const x = part.align === 'left' ? M : part.align === 'center' ? W / 2 : W - M;
      ctx.fillText(text, x, y);
      const w = ctx.measureText(text).width;
      const left = part.align === 'left' ? x : part.align === 'center' ? x - w / 2 : x - w;
      runs.push({ t: text, x: left / scale, y: (y - px * 0.6) / scale, w: w / scale, h: (px * 1.2) / scale, fs: cfg.runningFontPx });
    };
    if (markImg) {
      // Right-aligned to the content edge, centred in the top margin band and
      // shrunk if the band is too thin; it takes the header's place.
      let h = cfg.mark.height * scale;
      let w = (h * markImg.naturalWidth) / markImg.naturalHeight;
      const maxH = Math.max(M - 4 * scale, 1);
      if (h > maxH) {
        w = (w * maxH) / h;
        h = maxH;
      }
      ctx.drawImage(markImg, W - M - w, (M - h) / 2, w, h);
    } else {
      place(cfg.header, M / 2);
    }
    place(cfg.footer, H - M / 2);
    return runs;
  }

  function loadMark() {
    if (!cfg.mark) return Promise.resolve();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { markImg = img; resolve(); };
      img.onerror = () => resolve();
      img.src = cfg.mark.image;
    });
  }

  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '\\u2026').width > maxWidth) t = t.slice(0, -1);
    return t + '\\u2026';
  }

  function isSpaceCode(c) {
    return c === 32 || c === 9 || c === 13 || c === 12 || c === 160;
  }

  // The text the page images show, as runs of one line each (CSS px from the
  // top-left of the root). The PDF lays them over the images as invisible text
  // so it can be selected, copied and searched. Pieces on one line merge into a
  // run; a wide gap (table cells) starts a new run. Whitespace in pre/code
  // blocks is kept so indentation survives a copy.
  function collectTextRuns(root) {
    const rootRect = root.getBoundingClientRect();
    const runs = [];
    const range = document.createRange();
    let cur = null;
    let pendingSpace = false;
    const flush = () => {
      if (cur && cur.t.trim()) runs.push(cur);
      cur = null;
      pendingSpace = false;
    };
    const add = (text, r, fs) => {
      const x = r.left - rootRect.left;
      const y = r.top - rootRect.top;
      if (cur) {
        const end = cur.x + cur.w;
        const gap = x - end;
        const sameLine = Math.abs(y + r.height / 2 - (cur.y + cur.h / 2)) < Math.max(2, Math.min(r.height, cur.h) / 2);
        if (sameLine && gap > -fs * 0.3 && gap < fs * 1.2) {
          const lastSpace = cur.t.charCodeAt(cur.t.length - 1) === 32;
          if ((pendingSpace || gap > fs * 0.2) && !lastSpace && text.charCodeAt(0) !== 32) cur.t += ' ';
          cur.t += text;
          const top = Math.min(cur.y, y);
          const bottom = Math.max(cur.y + cur.h, y + r.height);
          cur.w = Math.max(end, r.right - rootRect.left) - cur.x;
          cur.y = top;
          cur.h = bottom - top;
          cur.fs = Math.max(cur.fs, fs);
          pendingSpace = false;
          return;
        }
        flush();
      }
      cur = { t: text, x: x, y: y, w: r.width, h: r.height, fs: fs };
      pendingSpace = false;
    };
    const rectsOf = (node, start, end) => {
      range.setStart(node, start);
      range.setEnd(node, end);
      return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const data = node.data;
      if (!el || !data || el.closest('script, style, svg, .jp-Watermark')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const fs = parseFloat(cs.fontSize) || 16;
      const pre = cs.whiteSpace.indexOf('pre') === 0 || cs.whiteSpace === 'break-spaces';
      let i = 0;
      while (i < data.length) {
        const c = data.charCodeAt(i);
        if (c === 10) {
          if (pre) flush();
          else pendingSpace = true;
          i++;
          continue;
        }
        const space = isSpaceCode(c);
        let j = i + 1;
        while (j < data.length && data.charCodeAt(j) !== 10 && isSpaceCode(data.charCodeAt(j)) === space) j++;
        if (space && !pre) {
          pendingSpace = true;
          i = j;
          continue;
        }
        const rects = rectsOf(node, i, j);
        if (rects.length === 1) {
          add(data.slice(i, j), rects[0], fs);
        } else if (rects.length > 1) {
          // The piece wraps onto the next line: place it character by character.
          for (let k = i; k < j; k++) {
            const rk = rectsOf(node, k, k + 1);
            if (rk.length) add(data[k], rk[0], fs);
          }
        }
        i = j;
      }
    }
    flush();
    return runs;
  }

  function capture() {
    const target = document.getElementById('capture-root');
    const runs = collectTextRuns(target);
    const boxes = collectKeepTogether(target);
    const forced = forcedBreaks(target, boxes);
    const rect = target.getBoundingClientRect();
    // Document position of the root, fixed now: the chunks are captured one
    // after another, and scrolling the view meanwhile must not move them.
    const originX = rect.left + window.scrollX;
    const originY = rect.top + window.scrollY;
    const cuts = computeCuts(rect.height, contentH, boxes, forced);
    if (cuts.length === 0) cuts.push([0, 1]); // empty document: still one page
    const chunks = groupCuts(cuts, MAX_CHUNK_PX / scale);
    const pages = [];
    const texts = [];
    let firstPageNo = 1;
    let chain = Promise.resolve();
    for (const chunk of chunks) {
      const pageNo = firstPageNo;
      chain = chain
        .then(() =>
          html2canvas(target, {
            scale: scale,
            backgroundColor: cfg.background,
            useCORS: true,
            logging: false,
            windowWidth: target.scrollWidth,
            windowHeight: target.scrollHeight,
            x: originX,
            y: originY + chunk.top,
            width: Math.ceil(rect.width),
            height: Math.ceil(chunk.bottom - chunk.top),
          })
        )
        .then((canvas) => {
          for (const page of sliceIntoPages(canvas, chunk, pageNo, cuts.length, runs)) {
            pages.push(page.image);
            texts.push(page.text);
          }
          vscode.postMessage({ type: 'progress', done: chunks.indexOf(chunk) + 1, total: chunks.length });
        });
      firstPageNo += chunk.cuts.length;
    }
    chain
      .then(() => {
        vscode.postMessage({ type: 'result', pages, texts, debug: { forced, cuts, chunks: chunks.length } });
      })
      .catch((err) => {
        vscode.postMessage({ type: 'error', message: String(err && err.message || err) });
      });
  }
  // SVGs are rasterised to PNG at the capture scale before html2canvas runs.
  // html2canvas draws an <img> whose SVG has only a viewBox (no width/height)
  // at a wrong intrinsic size — the drawing comes out enlarged and cropped —
  // and re-serialises inline <svg> without a viewBox, which crops it too.
  // Drawing each SVG onto a canvas at its laid-out size sidesteps both; the
  // layout does not change, so the page cuts are unaffected.
  function svgTextFromDataUrl(src) {
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    const meta = src.slice(0, comma);
    const body = src.slice(comma + 1);
    try {
      if (/;base64/i.test(meta)) {
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      }
      return decodeURIComponent(body);
    } catch {
      return null;
    }
  }
  // Parsed <svg> root with explicit pixel width/height (and a viewBox so the
  // drawing scales to them), serialised back to a data: URL.
  function sizedSvgUrl(root, w, h) {
    if (!root.hasAttribute('viewBox')) {
      const vw = root.width.baseVal;
      const vh = root.height.baseVal;
      const PERCENT = 2; // SVGLength.SVG_LENGTHTYPE_PERCENTAGE
      if (vw.unitType !== PERCENT && vh.unitType !== PERCENT && vw.value > 0 && vh.value > 0) {
        root.setAttribute('viewBox', '0 0 ' + vw.value + ' ' + vh.value);
      }
    }
    root.setAttribute('width', w + 'px');
    root.setAttribute('height', h + 'px');
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
  }
  function rasterize(url, w, h) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  async function rasterizeSvgs(root) {
    const jobs = [];
    root.querySelectorAll('img').forEach((img) => {
      if (!/^data:image\\/svg\\+xml/i.test(img.getAttribute('src') || '')) return;
      const r = img.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const text = svgTextFromDataUrl(img.getAttribute('src'));
      const doc = text && new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc && doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== 'svg') return;
      jobs.push(
        rasterize(sizedSvgUrl(svg, r.width, r.height), r.width, r.height).then((png) => {
          if (!png) return;
          img.style.width = r.width + 'px';
          img.style.height = r.height + 'px';
          img.src = png;
        })
      );
    });
    root.querySelectorAll('svg').forEach((svg) => {
      if (svg.ownerSVGElement) return; // nested
      const r = svg.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const style = getComputedStyle(svg);
      jobs.push(
        rasterize(sizedSvgUrl(svg.cloneNode(true), r.width, r.height), r.width, r.height).then((png) => {
          if (!png) return;
          const img = document.createElement('img');
          img.src = png;
          img.alt = '';
          img.style.display = style.display === 'inline' ? 'inline-block' : style.display;
          img.style.verticalAlign = style.verticalAlign;
          img.style.margin = style.margin;
          img.style.width = r.width + 'px';
          img.style.height = r.height + 'px';
          svg.replaceWith(img);
        })
      );
    });
    await Promise.all(jobs);
    // Let the new PNGs decode before measuring and capturing.
    await Promise.all(
      Array.from(root.querySelectorAll('img')).map((img) => (img.decode ? img.decode().catch(() => undefined) : undefined))
    );
  }
  // Wait for fonts and images before capturing
  const imgPromises = Array.from(document.images).map((img) =>
    img.complete ? Promise.resolve() : new Promise((r) => {
      img.addEventListener('load', r);
      img.addEventListener('error', r);
    })
  );
  Promise.all([document.fonts ? document.fonts.ready : Promise.resolve(), loadMark(), ...imgPromises])
    .then(() => rasterizeSvgs(document.getElementById('capture-root')))
    .catch(() => undefined)
    .then(() => requestAnimationFrame(() => requestAnimationFrame(capture)));
})();
</script>
</body>
</html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

// pdf-lib works in points; the page and the runs are in CSS px (1/96 in).
const PT_PER_CSS_PX = 0.75;

export async function generatePdfFromPages(
  pages: string[],
  texts: TextRun[][],
  pageWidthCss: number,
  pageHeightCss: number,
  options: { fontBytes?: Uint8Array; password?: string; ownerPassword?: string; permissions?: Permission[] }
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const hasText = texts.some((page) => page.length > 0);
  const font = options.fontBytes && hasText ? await pdf.embedFont(options.fontBytes, { subset: true }) : undefined;
  const supported = font ? new Set(font.getCharacterSet()) : new Set<number>();
  const widthCache = new Map<number, number>();
  const W = pageWidthCss * PT_PER_CSS_PX;
  const H = pageHeightCss * PT_PER_CSS_PX;
  // Each page image already carries margins, paper color, header and footer;
  // the text layer goes on top of it, invisible.
  for (let i = 0; i < pages.length; i++) {
    const page = pdf.addPage([W, H]);
    const [meta, data] = pages[i].split(',', 2);
    const bytes = Buffer.from(data, 'base64');
    const image = meta.includes('image/jpeg') ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    page.drawImage(image, { x: 0, y: 0, width: W, height: H });
    if (font) drawTextLayer(page, font, texts[i] ?? [], H, supported, widthCache);
  }
  // Default permissions mirror secure_pdf_with_pikepdf in nb_convert.py
  // (annotations/forms only). An empty ownerPassword falls back to the user
  // password, so the author can always lift the limits; anyone with that
  // password gets owner rights too.
  if (options.password) {
    pdf.encrypt({
      userPassword: options.password,
      ownerPassword: options.ownerPassword || options.password,
      permissions: permissionFlags(options.permissions ?? ['annot-forms']),
      algorithm: 'AES-256',
    });
  }
  return Buffer.from(await pdf.save());
}

// Writes each run as invisible text (render mode 3) stretched horizontally to
// the width it has on the image, so selection lines up with what is shown.
// Characters the font lacks (e.g. emoji) are left out of the layer.
function drawTextLayer(
  page: PDFPage,
  font: PDFFont,
  runs: TextRun[],
  pageHeightPt: number,
  supported: Set<number>,
  widthCache: Map<number, number>
): void {
  for (const run of runs) {
    let text = '';
    for (const ch of run.t.replace(/\t/g, '    ')) {
      if (supported.has(ch.codePointAt(0) ?? 0)) text += ch;
    }
    if (!text.trim()) continue;
    const size = Math.max(1, run.fs * PT_PER_CSS_PX);
    const natural = textWidth(font, text, widthCache) * size;
    const target = run.w * PT_PER_CSS_PX;
    const squeeze = natural > 0 ? clamp((target / natural) * 100, 1, 1000) : 100;
    // Baseline about a third of an em below the middle of the line box.
    const baseline = run.y + run.h / 2 + run.fs * 0.35;
    page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
    page.drawText(text, {
      x: run.x * PT_PER_CSS_PX,
      y: pageHeightPt - baseline * PT_PER_CSS_PX,
      size,
      font,
      renderMode: TextRenderingMode.Invisible,
    });
    page.pushOperators(popGraphicsState());
  }
}

// Width at size 1, summed from per-character advances (cached), which is far
// cheaper than shaping every run and accurate enough for the stretch factor.
function textWidth(font: PDFFont, text: string, cache: Map<number, number>): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    let w = cache.get(code);
    if (w === undefined) {
      w = font.widthOfTextAtSize(ch, 1);
      cache.set(code, w);
    }
    width += w;
  }
  return width;
}

function resolveActiveSourceUri(): vscode.Uri | undefined {
  const notebook = vscode.window.activeNotebookEditor?.notebook.uri;
  if (notebook && isSupported(notebook.fsPath)) {
    return notebook;
  }
  const editor = vscode.window.activeTextEditor?.document.uri;
  if (editor && isSupported(editor.fsPath)) {
    return editor;
  }
  return undefined;
}

export function deactivate() {}
