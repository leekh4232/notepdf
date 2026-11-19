// An .html document usually brings its own margins (body padding, a centred
// card). The page margin setting would be added on top of them, so every
// command that converts an .html file asks which of the two to use.
import * as vscode from 'vscode';

export type HtmlMargin = 'none' | 'settings';

export function isHtmlFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.html');
}

// undefined when the prompt is dismissed.
export async function pickHtmlMargin(): Promise<HtmlMargin | undefined> {
  const configured = vscode.workspace.getConfiguration('notepdf').get<number>('pdfPageMargin', 48);
  const items: (vscode.QuickPickItem & { value: HtmlMargin })[] = [
    {
      value: 'none',
      label: vscode.l10n.t('No margin (0 px)'),
      description: vscode.l10n.t('Only the margins the document itself has'),
    },
    {
      value: 'settings',
      label: vscode.l10n.t('Margin from settings ({0} px)', configured),
      description: 'notepdf.pdfPageMargin',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('HTML page margin'),
    placeHolder: vscode.l10n.t('Select the page margin for .html files'),
    ignoreFocusOut: true,
  });
  return picked?.value;
}

// The settings to convert this file with: an .html file gets no page margin
// when that was picked; every other file keeps the configured one.
export function applyHtmlMargin<T extends { pdfPageMargin: number }>(
  settings: T,
  filePath: string,
  choice: HtmlMargin | undefined
): T {
  return choice === 'none' && isHtmlFile(filePath) ? { ...settings, pdfPageMargin: 0 } : settings;
}
