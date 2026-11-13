// Teacher mode: an instructor mark drawn at the top right of every page in
// place of the header text. The teacher commands ask which one to use.
import * as vscode from 'vscode';
import * as path from 'path';

export type Mark = 'hossam' | 'jussam' | 'all';

// Height of the mark: CSS px in the converter, reference pt in the note layout.
export const MARK_HEIGHT = 20;

const MARKS: { mark: Mark; label: string; description: string }[] = [
  { mark: 'all', label: '통합', description: '주영아 · 이광호 강사' },
  { mark: 'hossam', label: '호쌤', description: '이광호 강사' },
  { mark: 'jussam', label: '쭈쌤', description: '주영아 강사' },
];

export function markLabel(mark: Mark): string {
  return MARKS.find((m) => m.mark === mark)?.label ?? mark;
}

export function markPath(context: vscode.ExtensionContext, mark: Mark): string {
  return context.asAbsolutePath(path.join('media', 'marks', `${mark}.png`));
}

// undefined when the prompt is dismissed.
export async function pickMark(): Promise<Mark | undefined> {
  const picked = await vscode.window.showQuickPick(MARKS, {
    title: vscode.l10n.t('Instructor mark'),
    placeHolder: vscode.l10n.t('Select the instructor mark to draw in the header'),
    ignoreFocusOut: true,
  });
  return picked?.mark;
}
