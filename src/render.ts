import { marked } from 'marked';
import hljs from 'highlight.js';
import {
  Cell,
  CellOutput,
  CodeCell,
  MarkdownCell,
  MimeBundle,
  MultilineString,
  Notebook,
  RawCell,
  joinSource,
} from './notebook';

marked.setOptions({
  gfm: true,
  breaks: false,
});

// Fenced blocks get the same highlight.js markup as notebook code cells, so the
// code theme colours them. An unknown or missing language is only escaped.
marked.use({
  renderer: {
    code(code: string, infostring: string | undefined): string {
      const language = (infostring ?? '').trim().split(/\s+/)[0].toLowerCase();
      return `<pre class="hljs"><code>${highlightCode(code.replace(/\n$/, ''), language)}</code></pre>\n`;
    },
  },
});

// CommonMark refuses a closing ** that follows whitespace, so "**해설: **" stays
// literal. Authors mean bold there, so accept it when the closing ** ends a word
// (followed by whitespace, punctuation or the end). Anything else, such as
// "**a **b**", is left to the standard rules.
const LOOSE_STRONG = /^\*\*(?![\s*])((?:[^*\n]|\*(?!\*))*?[^\s*])[ \t]+\*\*(?![^\s\p{P}])/u;

marked.use({
  extensions: [
    {
      name: 'looseStrong',
      level: 'inline',
      start(src: string): number | undefined {
        const index = src.indexOf('**');
        return index < 0 ? undefined : index;
      },
      tokenizer(src: string) {
        const match = LOOSE_STRONG.exec(src);
        if (!match) {
          return undefined;
        }
        return {
          type: 'looseStrong',
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1]),
        };
      },
      renderer(token) {
        return `<strong>${this.parser.parseInline(token.tokens ?? [])}</strong>`;
      },
    },
  ],
});

// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[([0-9;]*)m/g;

// ansi2html's inline palette, which nb_convert.py uses for coloured outputs.
const ANSI_COLORS = ['#000316', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#E850A8', '#00aaaa', '#F5F1DE'];
const ANSI_BRIGHT = ['#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff'];

const RICH_MIME = ['image/png', 'image/jpeg', 'image/svg+xml', 'text/html', 'text/markdown'];

export interface RenderOptions {
  hideCodeCells?: boolean;
  hideOutputs?: boolean;
  // Cells carrying any of these metadata tags are left out entirely.
  excludeCellTags?: string[];
  // Cells carrying any of these tags start a new page (.jp-PageBreakBefore).
  breakBeforeTags?: string[];
}

export function renderNotebook(nb: Notebook, options: RenderOptions = {}): string {
  const language =
    nb.metadata?.language_info?.name ??
    nb.metadata?.kernelspec?.language ??
    'python';

  const cellsHtml = nb.cells
    .filter((cell) => !hasAnyTag(cell, options.excludeCellTags))
    .map((cell) =>
      renderCell(cell, language, options, hasAnyTag(cell, options.breakBeforeTags) ? ' jp-PageBreakBefore' : '')
    )
    .join('\n');
  return `<div class="jp-Notebook">\n${cellsHtml}\n</div>`;
}

function hasAnyTag(cell: Cell, tags: string[] | undefined): boolean {
  if (!tags || tags.length === 0) {
    return false;
  }
  const cellTags = cell.metadata?.tags;
  return Array.isArray(cellTags) && cellTags.some((tag) => tags.includes(String(tag)));
}

// Renders a standalone Markdown document, reusing the same notebook chrome so it
// flows through the identical capture/theme pipeline as a .ipynb file.
export function renderMarkdown(source: string): string {
  const cell = markdownCellHtml(marked.parse(stripFrontMatter(source)) as string);
  return `<div class="jp-Notebook">\n${cell}\n</div>`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const YAML_KEY = /^[A-Za-z_$][\w$.-]*[ \t]*:(?:[ \t]|$)/;
const YAML_MORE = /^(?:[ \t]+\S|#)/;

// YAML front matter is metadata, not content, so it is dropped instead of
// rendering as a rule plus a paragraph: the block at the top of the file
// (Slidev, Jekyll, ...) and Slidev's per-slide blocks such as
// "---\nlayout: two-cols\n---". A per-slide block must hold only `key: value`
// lines (plus indented or # lines) so ordinary rules around text survive;
// blocks inside fenced code are left alone so syntax examples still print.
function stripFrontMatter(source: string): string {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: string[] = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = '';
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }
    const end = /^---[ \t]*$/.test(line) ? frontMatterEnd(lines, i, i === 0) : -1;
    if (end < 0) {
      out.push(line);
      continue;
    }
    out.push('');
    i = end;
  }
  return out.join('\n');
}

// Index of the closing "---" of a front matter block opened at `start`, or -1.
// The head block may hold anything YAML allows; later blocks are checked.
function frontMatterEnd(lines: string[], start: number, atHead: boolean): number {
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      return atHead || j > start + 1 ? j : -1;
    }
    if (atHead) {
      continue;
    }
    if (j === start + 1 ? !YAML_KEY.test(line) : !(YAML_KEY.test(line) || YAML_MORE.test(line))) {
      return -1;
    }
  }
  return -1;
}

function markdownCellHtml(html: string, cls = ''): string {
  return `<div class="jp-Cell jp-MarkdownCell${cls}"><div class="jp-Cell-inputWrapper"><div class="markdown-body">${html}</div></div></div>`;
}

function renderCell(cell: Cell, language: string, options: RenderOptions, cls: string): string {
  switch (cell.cell_type) {
    case 'markdown':
      return renderMarkdownCell(cell, cls);
    case 'code':
      return renderCodeCell(cell, language, options, cls);
    case 'raw':
      return renderRawCell(cell, cls);
    default:
      return '';
  }
}

function renderMarkdownCell(cell: MarkdownCell, cls: string): string {
  let html = marked.parse(joinSource(cell.source)) as string;
  if (cell.attachments) {
    html = resolveAttachments(html, cell.attachments);
  }
  return markdownCellHtml(html, cls);
}

// ![x](attachment:name) refers to an image stored base64-encoded in the cell.
function resolveAttachments(html: string, attachments: Record<string, MimeBundle>): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])attachment:([^"']+)\2/gi,
    (whole, prefix: string, quote: string, name: string) => {
      let key = name;
      try {
        key = decodeURIComponent(name);
      } catch {
        // keep the raw name
      }
      const bundle = attachments[key] ?? attachments[name];
      const mime = bundle && Object.keys(bundle).find((k) => k.startsWith('image/'));
      if (!mime) {
        return whole;
      }
      const data = joinSource(bundle[mime] as MultilineString).trim();
      return `${prefix}${quote}data:${mime};base64,${data}${quote}`;
    }
  );
}

function renderRawCell(cell: RawCell, cls: string): string {
  return `<div class="jp-Cell jp-RawCell${cls}"><pre class="jp-RenderedText">${escapeHtml(joinSource(cell.source))}</pre></div>`;
}

function renderCodeCell(cell: CodeCell, language: string, options: RenderOptions, cls: string): string {
  const source = joinSource(cell.source).replace(/\n$/, '');
  const highlighted = highlightCode(source, language);
  const lineCount = source.split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  const inputBlock = options.hideCodeCells
    ? ''
    : `<div class="jp-Cell-inputWrapper">
    <div class="jp-InputArea-editor">
      <pre class="jp-LineNumbers">${lineNumbers}</pre>
      <pre class="hljs"><code>${highlighted}</code></pre>
    </div>
  </div>`;
  const outputs = options.hideOutputs ? '' : renderOutputs(cell.outputs ?? []);
  const outputsBlock = outputs
    ? `<div class="jp-Cell-outputWrapper">${outputs}</div>`
    : '';
  if (!inputBlock && !outputsBlock) {
    return '';
  }

  return `<div class="jp-Cell jp-CodeCell${cls}">
  ${inputBlock}
  ${outputsBlock}
</div>`;
}

// nb_convert.py goes through `nbconvert --to markdown`, where every text output
// (stream, text/plain result, error traceback) becomes an indented block and
// consecutive blocks fuse into one <pre> with a blank line between them. Mirror
// that grouping so a cell gets one box per run of text outputs.
function renderOutputs(outputs: CellOutput[]): string {
  const blocks: string[] = [];
  let run: { text: string; cls: string }[] = [];
  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const text = run.map((o) => o.text).join('\n\n').replace(/\n+$/, '');
    const cls = run.find((o) => o.cls === 'jp-OutputArea-error')?.cls ?? run.find((o) => o.cls)?.cls ?? '';
    blocks.push(
      `<div class="jp-OutputArea${cls ? ` ${cls}` : ''}"><pre class="jp-RenderedText">${ansiToHtml(text)}</pre></div>`
    );
    run = [];
  };
  for (const output of outputs) {
    const text = textOutput(output);
    if (text) {
      run.push(text);
      continue;
    }
    flush();
    blocks.push(renderRich(output));
  }
  flush();
  return blocks.filter(Boolean).join('\n');
}

// Plain text of an output that has no richer representation, else undefined.
function textOutput(output: CellOutput): { text: string; cls: string } | undefined {
  switch (output.output_type) {
    case 'stream':
      return { text: joinSource(output.text), cls: output.name === 'stderr' ? 'jp-OutputArea-stderr' : '' };
    case 'error':
      return { text: (output.traceback ?? []).join('\n'), cls: 'jp-OutputArea-error' };
    case 'display_data':
    case 'execute_result': {
      const data = output.data;
      if (RICH_MIME.some((mime) => data[mime]) || !data['text/plain']) {
        return undefined;
      }
      return { text: joinSource(data['text/plain'] as string | string[]), cls: '' };
    }
    default:
      return undefined;
  }
}

function renderRich(output: CellOutput): string {
  if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') {
    return '';
  }
  return renderMime(output.data);
}

function renderMime(data: MimeBundle): string {
  // Priority order — pick the richest representation Jupyter would show.
  if (data['image/png']) {
    const src = `data:image/png;base64,${(data['image/png'] as string).trim()}`;
    return `<div class="jp-OutputArea jp-OutputArea-image"><img class="jp-OutputImage" src="${src}" /></div>`;
  }
  if (data['image/jpeg']) {
    const src = `data:image/jpeg;base64,${(data['image/jpeg'] as string).trim()}`;
    return `<div class="jp-OutputArea jp-OutputArea-image"><img class="jp-OutputImage" src="${src}" /></div>`;
  }
  if (data['image/svg+xml']) {
    const svg = joinSource(data['image/svg+xml'] as string | string[]);
    return `<div class="jp-OutputArea jp-OutputArea-image"><div class="jp-OutputImage">${svg}</div></div>`;
  }
  if (data['text/html']) {
    const html = joinSource(data['text/html'] as string | string[]);
    return `<div class="jp-OutputArea jp-OutputArea-html"><div class="jp-RenderedHTML">${html}</div></div>`;
  }
  if (data['text/markdown']) {
    const html = marked.parse(joinSource(data['text/markdown'] as string | string[])) as string;
    return `<div class="jp-OutputArea jp-OutputArea-html"><div class="markdown-body">${html}</div></div>`;
  }
  return '';
}

function highlightCode(source: string, language: string): string {
  if (hljs.getLanguage(language)) {
    try {
      return hljs.highlight(source, { language, ignoreIllegals: true }).value;
    } catch {
      // fall through to escape-only
    }
  }
  return escapeHtml(source);
}

// ANSI SGR escapes → inline-styled spans (bold and the 16 foreground colours),
// the subset Jupyter outputs use. Unknown codes are dropped.
function ansiToHtml(text: string): string {
  let html = '';
  let last = 0;
  let open = false;
  let bold = false;
  let color: string | undefined;
  for (const match of text.matchAll(ANSI_SGR)) {
    html += escapeHtml(text.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        bold = false;
        color = undefined;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        color = undefined;
      } else if (code >= 30 && code <= 37) {
        color = ANSI_COLORS[code - 30];
      } else if (code >= 90 && code <= 97) {
        color = ANSI_BRIGHT[code - 90];
      }
    }
    if (open) {
      html += '</span>';
      open = false;
    }
    const style = [bold ? 'font-weight: bold' : '', color ? `color: ${color}` : ''].filter(Boolean).join('; ');
    if (style) {
      html += `<span style="${style}">`;
      open = true;
    }
  }
  html += escapeHtml(text.slice(last));
  return open ? `${html}</span>` : html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
