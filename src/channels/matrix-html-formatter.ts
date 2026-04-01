/**
 * Matrix HTML Formatter
 *
 * Converts Markdown to Matrix-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links,
 * headers (h1-h6), blockquotes, horizontal rules, unordered and ordered
 * lists, and basic pipe tables.
 */

export function markdownToHtml(text: string): string {
  // --- Phase 1: Extract fenced code blocks to protect from further processing ---
  const codeBlocks: string[] = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langAttr = lang ? ` class="language-${lang}"` : '';
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return placeholder;
  });

  // --- Phase 2: Process block-level elements line by line ---
  const lines = html.split('\n');
  const result: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let inTable = false;
  let tableRows: string[] = [];

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const headerRow = tableRows[0];
    const dataRows = tableRows.slice(1).filter(r => !r.match(/^\s*\|[\s:|-]+\|\s*$/));
    let tableHtml = '<table><thead><tr>';
    const headerCells = headerRow.split('|').map(c => c.trim()).filter(c => c);
    for (const cell of headerCells) tableHtml += `<th>${cell}</th>`;
    tableHtml += '</tr></thead>';
    if (dataRows.length > 0) {
      tableHtml += '<tbody>';
      for (const row of dataRows) {
        const cells = row.split('|').map(c => c.trim()).filter(c => c);
        tableHtml += '<tr>';
        for (const cell of cells) tableHtml += `<td>${cell}</td>`;
        tableHtml += '</tr>';
      }
      tableHtml += '</tbody>';
    }
    tableHtml += '</table>';
    result.push(tableHtml);
    tableRows = [];
    inTable = false;
  };

  const flushList = () => {
    if (inList) {
      result.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };

  const flushBlockquote = () => {
    if (inBlockquote) {
      result.push('</blockquote>');
      inBlockquote = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block placeholder — pass through as-is
    if (line.match(/\x00CODEBLOCK\d+\x00/)) {
      flushList();
      flushBlockquote();
      flushTable();
      result.push(line);
      continue;
    }

    // Table rows (starts and ends with |)
    if (line.match(/^\s*\|.*\|\s*$/)) {
      flushList();
      flushBlockquote();
      inTable = true;
      tableRows.push(line);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Horizontal rule
    if (line.match(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/)) {
      flushList();
      flushBlockquote();
      result.push('<hr>');
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      flushList();
      flushBlockquote();
      const level = headerMatch[1].length;
      result.push(`<h${level}>${headerMatch[2]}</h${level}>`);
      continue;
    }

    // Blockquotes
    if (line.match(/^>\s?/)) {
      flushList();
      if (!inBlockquote) {
        result.push('<blockquote>');
        inBlockquote = true;
      }
      result.push(line.replace(/^>\s?/, '') + '<br>');
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Unordered list items
    if (line.match(/^\s*[-*+]\s+/)) {
      flushBlockquote();
      if (inList !== 'ul') {
        flushList();
        result.push('<ul>');
        inList = 'ul';
      }
      result.push(`<li>${line.replace(/^\s*[-*+]\s+/, '')}</li>`);
      continue;
    }

    // Ordered list items
    const olMatch = line.match(/^\s*(\d+)[.)]\s+/);
    if (olMatch) {
      flushBlockquote();
      if (inList !== 'ol') {
        flushList();
        result.push('<ol>');
        inList = 'ol';
      }
      result.push(`<li>${line.replace(/^\s*\d+[.)]\s+/, '')}</li>`);
      continue;
    }

    // Blank line inside a list — peek ahead to see if the list continues
    if (inList && line.trim() === '') {
      const next = lines.slice(i + 1).find(l => l.trim() !== '');
      const listContinues = next !== undefined && (
        (inList === 'ol' && /^\s*\d+[.)]\s+/.test(next)) ||
        (inList === 'ul' && /^\s*[-*+]\s+/.test(next))
      );
      if (listContinues) continue; // skip blank line, keep list open
      flushList();
      result.push('<br>');
      continue;
    }
    flushList();

    // Empty line
    if (line.trim() === '') {
      result.push('<br>');
      continue;
    }

    result.push(line + '<br>');
  }

  flushList();
  flushBlockquote();
  flushTable();

  html = result.join('\n');

  // --- Phase 3: Inline formatting ---
  // Inline code (before bold/italic to avoid conflicts)
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Bold (** or __)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // __ bold only at word boundaries — avoid matching snake_case__names
  html = html.replace(/(?<=^|[\s(>])__(?=\S)([\s\S]+?\S)__(?=$|[\s)<.,;:!?])/gm, '<strong>$1</strong>');

  // Italic (* or _)
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  // _ italic only at word boundaries — avoid matching snake_case_names, file_paths, etc.
  html = html.replace(/(?<=^|[\s(>])_(?=\S)([^_]+?\S)_(?=$|[\s)<.,;:!?])/gm, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // --- Phase 4: Restore code blocks ---
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return html;
}
