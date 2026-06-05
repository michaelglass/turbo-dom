// Parse html5lib-tests *.dat fixture files into structured test cases.
//
// File format: a sequence of cases, each a set of `#`-prefixed sections:
//   #data                 the HTML input (may span multiple lines)
//   #errors / #new-errors  expected parse errors (we don't assert these)
//   #document-fragment     optional: fragment context element ("td", "svg path")
//   #script-on / #script-off  optional scripting-flag marker
//   #document              the expected tree dump (html5lib format)
// Cases are separated by a single blank line before the next `#data`.

const HEADERS = new Set([
  '#data',
  '#errors',
  '#new-errors',
  '#document',
  '#document-fragment',
  '#script-on',
  '#script-off',
]);

// Drop trailing empty lines — the blank case-separator lands in the #document buffer.
function trimTrailingBlank(lines) {
  const copy = [...lines];
  while (copy.length && copy[copy.length - 1] === '') copy.pop();
  return copy;
}

function normalize(raw) {
  const data = (raw['#data'] ?? []).join('\n');
  const document = trimTrailingBlank(raw['#document'] ?? []).join('\n');

  let fragmentContext = null;
  if (raw['#document-fragment']) {
    fragmentContext = trimTrailingBlank(raw['#document-fragment']).join('\n').trim() || null;
  }

  let scriptMode = null;
  if ('#script-on' in raw) scriptMode = 'on';
  else if ('#script-off' in raw) scriptMode = 'off';

  return { data, document, fragmentContext, scriptMode };
}

export function parseDatFile(text) {
  const lines = text.split('\n');
  const tests = [];
  let cur = null;
  let section = null;
  let buf = [];

  const flush = () => {
    if (section != null && cur != null) cur[section] = buf;
  };

  for (const line of lines) {
    if (HEADERS.has(line)) {
      if (line === '#data') {
        flush();
        if (cur != null) tests.push(cur);
        cur = {};
      } else {
        flush();
      }
      section = line;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  if (cur != null) tests.push(cur);

  return tests.map(normalize);
}

export const _internal = { trimTrailingBlank, normalize, HEADERS };
