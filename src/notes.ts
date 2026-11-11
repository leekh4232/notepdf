// Note area commands (formerly the PDF2Note extension): add a ruled note area
// and a header band to every page of a PDF, or of an .ipynb/.md converted first.
import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { addNoteArea, loadSource, permissionFlags, resolvePaper, setTranslator, Align, SourceEncryptedError, WrongPasswordError } from './note';
import type { PDFDocument } from '@cantoo/pdf-lib';

const SUPPORTED = ['.pdf', '.ipynb', '.md'];

// Teacher mode marks (nb_convert.py --ssam), drawn in place of the header text.
type Mark = 'ho' | 'ju';
const MARK_IMAGES: Record<Mark, string> = {
  ho: 'https://data.hossam.kr/itwill-ho.png',
  ju: 'https://data.hossam.kr/itwill-ju.png',
};
const MARK_WIDTH = 100;

const ALIGNMENTS = ['left', 'center', 'right'] as const;
const PERMISSIONS = ['print', 'modify', 'copy', 'annot-forms'] as const;
const LAYOUT_MODES = ['note', 'feedback'] as const;

interface Settings {
  paperSize: string;
  layoutMode: (typeof LAYOUT_MODES)[number];
  feedbackBannerImage: string;
  lineGap: number;
  headerText: string;
  footerText: string;
  headerAlign: Align;
  footerAlign: Align;
  headerFooterFontSize: number;
  outputDirectory: string;
  outputFileName: string;
  openAfterConvert: boolean;
  pdfPermissions: string[];
  ownerPassword: string;
  teacherMode: boolean;
}

function defaultSettings(): Settings {
  return {
    paperSize: 'original',
    layoutMode: 'note',
    feedbackBannerImage: '',
    lineGap: 18,
    headerText: '{file}',
    footerText: '{page} / {total}',
    headerAlign: 'left',
    footerAlign: 'right',
    headerFooterFontSize: 10,
    outputDirectory: '',
    outputFileName: '{name}_note',
    openAfterConvert: false,
    pdfPermissions: ['annot-forms'],
    ownerPassword: '',
    teacherMode: false,
  };
}

// Settings shared with the converter (passwords, permissions, output folder,
// teacher mode) sit at the top level; the note layout ones under "note.".
const SHARED_KEYS: (keyof Settings)[] = ['outputDirectory', 'openAfterConvert', 'pdfPermissions', 'ownerPassword', 'teacherMode'];
const keyOf = (key: keyof Settings) => (SHARED_KEYS.includes(key) ? key : `note.${key}`);

function readSettings(config: vscode.WorkspaceConfiguration): Settings {
  const d = defaultSettings();
  const str = (key: keyof Settings): string => {
    const value = config.get<unknown>(keyOf(key), d[key]);
    return typeof value === 'string' ? value : String(d[key]);
  };
  const num = (key: keyof Settings, min: number, max: number): number => {
    const value = Number(config.get<unknown>(keyOf(key), d[key]));
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : (d[key] as number)));
  };
  const pick = <T extends string>(key: keyof Settings, allowed: readonly T[]): T => {
    const value = str(key);
    return (allowed as readonly string[]).includes(value) ? (value as T) : (d[key] as T);
  };
  const permissions = config.get<unknown>('pdfPermissions', d.pdfPermissions);
  return {
    paperSize: str('paperSize'),
    layoutMode: pick('layoutMode', LAYOUT_MODES),
    feedbackBannerImage: str('feedbackBannerImage').trim(),
    lineGap: num('lineGap', 6, 60),
    headerText: str('headerText'),
    footerText: str('footerText'),
    headerAlign: pick('headerAlign', ALIGNMENTS),
    footerAlign: pick('footerAlign', ALIGNMENTS),
    headerFooterFontSize: num('headerFooterFontSize', 6, 24),
    outputDirectory: str('outputDirectory').trim(),
    outputFileName: str('outputFileName').trim() || d.outputFileName,
    openAfterConvert: Boolean(config.get<unknown>('openAfterConvert', false)),
    pdfPermissions: Array.isArray(permissions)
      ? permissions.map(String).filter((p) => (PERMISSIONS as readonly string[]).includes(p))
      : d.pdfPermissions,
    ownerPassword: str('ownerPassword'),
    teacherMode: Boolean(config.get<unknown>('teacherMode', false)),
  };
}

let outputChannel: vscode.OutputChannel;
let fontCache: Uint8Array | undefined;

// Thrown when the user dismisses a prompt; reported like a cancellation.
class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

const COMMANDS: { id: string; withPassword: boolean; mark?: Mark }[] = [
  { id: 'ipynb-pdf-converter.addNotes', withPassword: false },
  { id: 'ipynb-pdf-converter.addNotesWithPassword', withPassword: true },
  { id: 'ipynb-pdf-converter.addNotesHossam', withPassword: false, mark: 'ho' },
  { id: 'ipynb-pdf-converter.addNotesHossamWithPassword', withPassword: true, mark: 'ho' },
  { id: 'ipynb-pdf-converter.addNotesJussam', withPassword: false, mark: 'ju' },
  { id: 'ipynb-pdf-converter.addNotesJussamWithPassword', withPassword: true, mark: 'ju' },
];

// Renders an .ipynb/.md to PDF bytes without its own header/footer; this
// module draws them on the new, larger page.
export type ConvertToBytes = (
  filePath: string,
  token: vscode.CancellationToken,
  onProgress: (message: string, fraction: number) => void
) => Promise<Uint8Array>;

let convertToBytes: ConvertToBytes;

export function registerNoteCommands(context: vscode.ExtensionContext, channel: vscode.OutputChannel, convert: ConvertToBytes): void {
  outputChannel = channel;
  convertToBytes = convert;
  // UI strings follow the VS Code display language (l10n/bundle.l10n.*.json).
  setTranslator(vscode.l10n.t);
  for (const { id, withPassword, mark } of COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg?: unknown, selected?: unknown) => {
        // The explorer passes the clicked Uri plus every selected Uri; other
        // menus pass one Uri, and notebook cell menus a cell context, so fall
        // back to the active tab's file.
        const targets =
          Array.isArray(selected) && selected.length > 0 && selected.every((u) => u instanceof vscode.Uri)
            ? (selected as vscode.Uri[])
            : [arg instanceof vscode.Uri ? arg : resolveActiveUri()];
        const filePaths = targets.flatMap((u) =>
          u && SUPPORTED.includes(path.extname(u.fsPath).toLowerCase()) ? [u.fsPath] : []
        );
        if (filePaths.length === 0) {
          vscode.window.showErrorMessage(vscode.l10n.t('Please select a .pdf, .ipynb or .md file'));
          return;
        }
        // One password for the whole selection.
        const password = withPassword ? await resolvePassword() : undefined;
        if (withPassword && password === undefined) {
          return; // prompt dismissed
        }
        await runAll(context, filePaths, password, mark);
      })
    );
  }
}

function resolveActiveUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
  return input?.uri instanceof vscode.Uri ? input.uri : vscode.window.activeTextEditor?.document.uri;
}

// Same rule as the converter: the configured default, else a prompt.
async function resolvePassword(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('notepdf').get<string>('pdfPassword', '');
  if (configured) {
    return configured;
  }
  return vscode.window.showInputBox({
    title: vscode.l10n.t('PDF Password'),
    prompt: vscode.l10n.t('No default password is set (notepdf.pdfPassword). Enter a password for this PDF.'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value ? undefined : vscode.l10n.t('Password cannot be empty')),
  });
}

type RunResult = 'ok' | 'warned' | 'failed' | 'cancelled';

// Processes the files one after another. A single file reports its own result;
// a selection gets one summary at the end, and cancelling stops the rest.
async function runAll(
  context: vscode.ExtensionContext,
  filePaths: string[],
  password: string | undefined,
  mark: Mark | undefined
): Promise<void> {
  const settings = readSettings(vscode.workspace.getConfiguration('notepdf'));
  const batch = filePaths.length > 1;
  const results: RunResult[] = [];
  outputChannel.clear();
  for (const [i, filePath] of filePaths.entries()) {
    const counter = batch ? ` (${i + 1}/${filePaths.length})` : '';
    const result = await run(context, filePath, password, mark, settings, counter, !batch);
    results.push(result);
    if (result === 'cancelled') {
      break;
    }
  }
  if (batch) {
    reportBatch(results, filePaths.length, password !== undefined);
  }
}

function reportBatch(results: RunResult[], total: number, encrypted: boolean): void {
  const done = results.filter((r) => r === 'ok' || r === 'warned').length;
  const failed = results.filter((r) => r === 'failed').length;
  const warned = results.filter((r) => r === 'warned').length;
  const skipped = total - results.length;
  let summary = encrypted
    ? vscode.l10n.t('Note PDFs created for {0} of {1} files (password protected)', done, total)
    : vscode.l10n.t('Note PDFs created for {0} of {1} files', done, total);
  if (failed > 0) summary += vscode.l10n.t(', {0} failed', failed);
  if (skipped > 0) summary += vscode.l10n.t(', {0} skipped after cancel', skipped);
  if (warned > 0) summary += vscode.l10n.t(', {0} with warnings', warned);
  if (failed > 0 || warned > 0) {
    const showLog = vscode.l10n.t('Show Log');
    vscode.window.showWarningMessage(`⚠️ ${summary}`, showLog).then((choice) => {
      if (choice === showLog) outputChannel.show();
    });
  } else {
    vscode.window.showInformationMessage(`✅ ${summary}`);
  }
}

async function run(
  context: vscode.ExtensionContext,
  filePath: string,
  password: string | undefined,
  mark: Mark | undefined,
  settings: Settings,
  counter: string,
  notify: boolean
): Promise<RunResult> {
  const fileName = path.basename(filePath);
  outputChannel.appendLine(`📝 ${vscode.l10n.t('{0} → note PDF', fileName)}${counter}`);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Adding note area to {0}', fileName) + counter, cancellable: true },
    async (progress, token) => {
      let reached = 0;
      const report = (message: string, fraction: number) => {
        const next = Math.round(fraction * 100);
        progress.report({ message, increment: next - reached });
        reached = next;
      };
      try {
        const warnings = await addNotesToFile(context, filePath, password, mark, settings, token, report, notify);
        return warnings > 0 ? 'warned' : 'ok';
      } catch (error) {
        if (token.isCancellationRequested || error instanceof CancelledError) {
          outputChannel.appendLine(`⏹ ${vscode.l10n.t('Cancelled')}`);
          vscode.window.showInformationMessage(vscode.l10n.t('Cancelled: {0}', fileName));
          return 'cancelled';
        }
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ ${vscode.l10n.t('Error: {0}', message)}`);
        if (notify) {
          // Not awaited: the progress notification must close with this callback.
          const showLog = vscode.l10n.t('Show Log');
          vscode.window.showErrorMessage(vscode.l10n.t('Note PDF failed: {0}', message), showLog).then((choice) => {
            if (choice === showLog) outputChannel.show();
          });
        }
        return 'failed';
      }
    }
  );
}

async function addNotesToFile(
  context: vscode.ExtensionContext,
  filePath: string,
  password: string | undefined,
  mark: Mark | undefined,
  settings: Settings,
  token: vscode.CancellationToken,
  report: (message: string, fraction: number) => void,
  notify: boolean
): Promise<number> {
  const sourceDir = path.dirname(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, path.extname(filePath)).normalize('NFC');
  const vars = { file: baseName, name: baseName, date: localDate() };
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    outputChannel.appendLine(`⚠️ ${message}`);
  };

  // 1. Source PDF bytes: the file itself, or ipynb/md rendered in memory (no
  //    temp files).
  let input: Uint8Array;
  if (ext === '.pdf') {
    report(vscode.l10n.t('Reading PDF…'), 0.05);
    input = new Uint8Array(await fs.readFile(filePath));
  } else {
    report(vscode.l10n.t('Converting to PDF…'), 0.02);
    input = await convertToBytes(filePath, token, (message, fraction) => report(message, 0.02 + fraction * 0.48));
  }
  if (token.isCancellationRequested) throw new CancelledError();
  const base = ext === '.pdf' ? 0.05 : 0.5;
  const src = await openSource(input, path.basename(filePath));

  // 2. Assets.
  const banner =
    settings.layoutMode === 'feedback'
      ? settings.feedbackBannerImage
        ? await loadImage(settings.feedbackBannerImage, sourceDir).catch((error) => {
            warn(vscode.l10n.t('Feedback banner not loaded ({0}): {1}', settings.feedbackBannerImage, messageOf(error)));
            return null;
          })
        : (warn(vscode.l10n.t('Feedback mode: no banner configured (notepdf.note.feedbackBannerImage); drawing the divider only')), null)
      : null;
  const markImage = mark
    ? await loadImage(MARK_IMAGES[mark], sourceDir).catch((error) => {
        warn(vscode.l10n.t('Instructor mark not loaded ({0}): {1}', MARK_IMAGES[mark], messageOf(error)));
        return null;
      })
    : null;
  if (mark && markImage) {
    outputChannel.appendLine(`🖼️ ${vscode.l10n.t('Teacher mode: {0} mark on every page', mark === 'ho' ? 'hossam' : 'jussam')}`);
  }
  if (!fontCache) {
    const fontPath = context.asAbsolutePath(path.join('media', 'fonts', 'NanumGothic.ttf'));
    try {
      fontCache = new Uint8Array(await fs.readFile(fontPath));
    } catch {
      throw new Error(vscode.l10n.t('Bundled font missing (media/fonts/NanumGothic.ttf). Reinstall the NotePDF extension.'));
    }
  }

  // 3. Layout.
  report(vscode.l10n.t('Adding note areas…'), base);
  const paper = resolvePaper(settings.paperSize);
  outputChannel.appendLine(
    vscode.l10n.t(
      'Layout: {0}, paper {1}, line gap {2} pt',
      settings.layoutMode,
      paper ? settings.paperSize.toUpperCase() : vscode.l10n.t('original size'),
      settings.lineGap
    )
  );
  const { doc, pages, warnings: layoutWarnings } = await addNoteArea(src, {
    vars: { file: vars.file, date: vars.date },
    header: { text: settings.headerText, align: settings.headerAlign },
    footer: { text: settings.footerText, align: settings.footerAlign },
    fontSize: settings.headerFooterFontSize,
    fontBytes: fontCache,
    paper,
    mode: settings.layoutMode,
    lineGap: settings.lineGap,
    banner,
    mark: markImage,
    markWidth: MARK_WIDTH,
    onProgress: (done, total) => {
      if (token.isCancellationRequested) throw new CancelledError();
      report(vscode.l10n.t('Adding note areas… ({0}/{1})', done, total), base + (done / total) * (0.9 - base));
    },
  });
  layoutWarnings.forEach(warn);

  // 4. Password (same rule as the converter; AES-256). An empty
  //    ownerPassword falls back to the user password.
  if (password) {
    doc.encrypt({
      userPassword: password,
      ownerPassword: settings.ownerPassword || password,
      permissions: permissionFlags(settings.pdfPermissions),
      algorithm: 'AES-256',
    });
  }

  // 5. Save without overwriting: "name (1).pdf", "name (2).pdf", …
  report(vscode.l10n.t('Saving…'), 0.95);
  const bytes = await doc.save();
  const outputDir = settings.outputDirectory ? path.resolve(sourceDir, settings.outputDirectory) : sourceDir;
  const outputName = (expand(settings.outputFileName, vars) || `${baseName}_note`).replace(/\.pdf$/i, '');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = await uniquePdfPath(outputDir, outputName);
  await fs.writeFile(outputPath, bytes);
  report(vscode.l10n.t('Done'), 1);
  outputChannel.appendLine(
    `✅ ${pages === 1 ? vscode.l10n.t('Saved: {0} (1 page)', outputPath) : vscode.l10n.t('Saved: {0} ({1} pages)', outputPath, pages)}`
  );

  if (settings.openAfterConvert) {
    await vscode.env.openExternal(vscode.Uri.file(outputPath));
  }
  if (!notify) {
    return warnings.length;
  }
  const savedName = path.basename(outputPath);
  const summary = `✅ ${password ? vscode.l10n.t('Note PDF (password protected): {0}', savedName) : vscode.l10n.t('Note PDF: {0}', savedName)}`;
  // Not awaited: the progress notification must close when this function returns.
  const showLog = vscode.l10n.t('Show Log');
  if (warnings.length > 0) {
    vscode.window
      .showWarningMessage(
        warnings.length === 1
          ? vscode.l10n.t('{0} — 1 warning', summary)
          : vscode.l10n.t('{0} — {1} warnings', summary, warnings.length),
        showLog
      )
      .then((choice) => {
        if (choice === showLog) outputChannel.show();
      });
  } else {
    vscode.window.showInformationMessage(summary);
  }
  return warnings.length;
}

// Opens the source PDF; a password-protected source asks for its password once.
async function openSource(input: Uint8Array, fileName: string): Promise<PDFDocument> {
  try {
    return await loadSource(input);
  } catch (error) {
    if (!(error instanceof SourceEncryptedError)) {
      throw error;
    }
  }
  const password = await vscode.window.showInputBox({
    title: vscode.l10n.t('Source PDF password'),
    prompt: vscode.l10n.t('"{0}" is password protected. Enter its password to open it.', fileName),
    password: true,
    ignoreFocusOut: true,
  });
  if (password === undefined) {
    throw new CancelledError();
  }
  try {
    return await loadSource(input, password);
  } catch (error) {
    throw error instanceof WrongPasswordError ? new Error(vscode.l10n.t('Wrong password for "{0}"', fileName)) : error;
  }
}

async function loadImage(src: string, baseDir: string): Promise<{ bytes: Uint8Array }> {
  if (/^https?:/i.test(src)) {
    const response = await fetch(src, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  const file = src.startsWith('file:') ? fileURLToPath(src) : path.resolve(baseDir, src);
  return { bytes: new Uint8Array(await fs.readFile(file)) };
}

async function uniquePdfPath(dir: string, name: string): Promise<string> {
  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  let candidate = path.join(dir, `${name}.pdf`);
  for (let n = 1; await exists(candidate); n++) {
    candidate = path.join(dir, `${name} (${n}).pdf`);
  }
  return candidate;
}

function expand(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? vars[key] : whole));
}

function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

