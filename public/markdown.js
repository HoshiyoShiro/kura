/* Small, safe markdown renderer. Everything is HTML-escaped before any tag is added,
   links are limited to http(s) and mailto, images are shown as links (the CSP blocks remote images).
   Supports: headings, paragraphs with line breaks, bold, italic, strikethrough, inline code, fenced code,
   links and bare URLs, blockquotes, nested bullet / numbered / task lists, tables, horizontal rules, backslash escapes. */
(function (root) {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

  const emph = t => t
    .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?!\s)(.+?)(?<!\s)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/\*(?![\s*])(.+?)(?<![\s*])\*/g, '<i>$1</i>')
    .replace(/(^|[^\w])_(?![\s_])(.+?)(?<![\s_])_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>');

  function inline(src) {
    const store = [];
    const hold = html => '\u0001' + (store.push(html) - 1) + '\u0001';
    let s = String(src).replace(/[\u0000\u0001]/g, '');
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_, c) => hold(esc(c)));
    s = s.replace(/(`+)(.+?)\1(?!`)/g, (_, __, code) => hold('<code>' + esc(code.trim()) + '</code>'));
    s = esc(s);
    s = s.replace(/(!?)\[([^\]]*)\]\(\s*([^)\s\u0001]+)(?:\s+&quot;.*?&quot;)?\s*\)/g, (m, bang, text, url) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return m;
      const label = text || (bang ? 'image' : url);
      return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${emph(label)}</a>`);
    });
    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<\u0001]*[^\s<\u0001.,;:!?)\]])/g, (m, pre, url) => {
      const cut = url.search(/&(?:quot|#39|lt|gt);/);
      const tail = cut >= 0 ? url.slice(cut) : '';
      if (cut === 0) return m;
      if (cut > 0) url = url.slice(0, cut);
      return pre + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + tail;
    });
    s = emph(s);
    for (let n = 0; n < 4 && s.includes('\u0001'); n++) s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => store[i]);
    return s;
  }

  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const isListItem = l => LI.test(l) && !HR.test(l);
  const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  const tableStart = (l, next) => l.includes('|') && next !== undefined && next.includes('-') && TABLE_SEP.test(next) && (next.includes('|') || splitRow(l).length > 1);

  function parseList(lines, i) {
    const stack = [];
    let html = '';
    const closeTo = indent => { while (stack.length && stack[stack.length - 1].indent > indent) html += '</li></' + stack.pop().tag + '>'; };
    while (i < lines.length) {
      const l = lines[i];
      const m = isListItem(l) ? l.match(LI) : null;
      if (m) {
        const indent = m[1].replace(/\t/g, '    ').length;
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        closeTo(indent);
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          stack.push({ indent, tag });
          const start = tag === 'ol' ? parseInt(m[2], 10) : 1;
          html += tag === 'ol' && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        } else {
          html += '</li>';
          if (top.tag !== tag) { html += `</${top.tag}><${tag}>`; top.tag = tag; }
        }
        const task = m[3].match(/^\[([ xX])\]\s+(.*)/);
        html += task
          ? `<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}`
          : `<li>${inline(m[3])}`;
        i++; continue;
      }
      if (l.trim() && /^\s{2,}\S/.test(l) && stack.length) { html += '<br>' + inline(l.trim()); i++; continue; }
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && isListItem(lines[j])) { i = j; continue; }
      }
      break;
    }
    closeTo(-1);
    return [html, i];
  }

  function blocks(lines) {
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if ((m = line.match(FENCE))) {
        const ch = m[1][0], len = m[1].length, lang = m[2].replace(/[^\w+#.-]/g, '');
        const close = new RegExp('^\\s*' + (ch === '`' ? '`' : '~') + '{' + len + ',}\\s*$');
        const body = []; i++;
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        const lv = Math.min(m[1].length + 1, 6); // page title is the h1
        out.push(`<h${lv}>${inline(m[2])}</h${lv}>`); i++; continue;
      }
      if (HR.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        const inner = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        out.push(`<blockquote>${blocks(inner)}</blockquote>`); continue;
      }
      if (tableStart(line, lines[i + 1])) {
        const head = splitRow(line);
        const al = splitRow(lines[i + 1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : '');
        const cell = (tag, c, k) => `<${tag}${al[k] ? ` class="al-${al[k]}"` : ''}>${inline(c)}</${tag}>`;
        let html = '<div class="tbl"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const r = splitRow(lines[i++]);
          html += '<tr>' + head.map((_, k) => cell('td', r[k] || '', k)).join('') + '</tr>';
        }
        out.push(html + '</tbody></table></div>'); continue;
      }
      if (isListItem(line)) { const [h, ni] = parseList(lines, i); out.push(h); i = ni; continue; }

      const para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]) && !HR.test(lines[i])
        && !isListItem(lines[i]) && !tableStart(lines[i], lines[i + 1])) para.push(lines[i++]);
      if (!para.length) { para.push(lines[i++]); }
      out.push('<p>' + para.map(l => inline(l.replace(/\\$/, '').trim())).join('<br>\n') + '</p>');
    }
    return out.join('\n');
  }

  const md = src => blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
  root.md = md; root.mdInline = inline;
  if (typeof module !== 'undefined') module.exports = { md, inline };
})(typeof window !== 'undefined' ? window : globalThis);
