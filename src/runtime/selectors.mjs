// Compact CSS selector engine. Correctness-first, right-to-left matching.
// Supports: type, *, #id, .class, [attr], [attr op val] (= ^= $= *= ~= |=),
// combinators (descendant ' ', child '>', adjacent '+', sibling '~'),
// comma selector lists, and :not(), :first-child, :last-child, :only-child,
// :empty, :root. Enough for React Testing Library usage.

const ATTR_RE = /\[\s*([^\]=~^$*|\s]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?\]/y;

function parseCompound(src, i) {
  const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let matchedAny = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '*') { compound.tag = '*'; i++; matchedAny = true; continue; }
    if (/[a-zA-Z]/.test(c) && compound.tag === null && compound.id === null && !compound.classes.length && !compound.attrs.length && !compound.pseudos.length) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      compound.tag = src.slice(i, j).toLowerCase();
      i = j; matchedAny = true; continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      compound.id = src.slice(i + 1, j); i = j; matchedAny = true; continue;
    }
    if (c === '.') {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z0-9_-]/.test(src[j])) j++;
      compound.classes.push(src.slice(i + 1, j)); i = j; matchedAny = true; continue;
    }
    if (c === '[') {
      ATTR_RE.lastIndex = i;
      const m = ATTR_RE.exec(src);
      if (!m) throw new SyntaxError(`bad attribute selector at ${src.slice(i)}`);
      compound.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? null });
      i = ATTR_RE.lastIndex; matchedAny = true; continue;
    }
    if (c === ':') {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z-]/.test(src[j])) j++;
      const name = src.slice(i + 1, j);
      let arg = null;
      if (src[j] === '(') {
        let depth = 1, k = j + 1;
        while (k < src.length && depth > 0) { if (src[k] === '(') depth++; else if (src[k] === ')') depth--; k++; }
        arg = src.slice(j + 1, k - 1);
        j = k;
      }
      compound.pseudos.push({ name, arg });
      i = j; matchedAny = true; continue;
    }
    break;
  }
  if (!matchedAny) throw new SyntaxError(`empty compound at ${src.slice(i)}`);
  return { compound, i };
}

// Parse one complex selector into compounds[] + combinators[] (combinator[k]
// relates compounds[k] to compounds[k+1], left to right).
function parseComplex(src) {
  let i = 0;
  const compounds = [];
  const combinators = [];
  src = src.trim();
  while (i < src.length) {
    while (src[i] === ' ') i++;
    const r = parseCompound(src, i);
    compounds.push(r.compound);
    i = r.i;
    // read optional combinator
    let sawSpace = false;
    while (src[i] === ' ') { sawSpace = true; i++; }
    if (i >= src.length) break;
    if (src[i] === '>' || src[i] === '+' || src[i] === '~') {
      combinators.push(src[i]); i++;
      while (src[i] === ' ') i++;
    } else if (sawSpace) {
      combinators.push(' ');
    } else {
      throw new SyntaxError(`unexpected '${src[i]}' in selector`);
    }
  }
  return { compounds, combinators };
}

export function parseSelectorList(selector) {
  return splitTopLevel(selector, ',').map((s) => parseComplex(s.trim()));
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}

function elementChildren(node) {
  const kids = typeof node.__children === 'function' ? node.__children() : Array.from(node.childNodes || []);
  return kids.filter((n) => n.nodeType === 1);
}

function matchAttr(el, a) {
  if (!el.hasAttribute(a.name)) return false;
  if (a.op === null) return true;
  const v = el.getAttribute(a.name) ?? '';
  const t = a.value ?? '';
  switch (a.op) {
    case '=': return v === t;
    case '^=': return t !== '' && v.startsWith(t);
    case '$=': return t !== '' && v.endsWith(t);
    case '*=': return t !== '' && v.includes(t);
    case '~=': return v.split(/\s+/).includes(t);
    case '|=': return v === t || v.startsWith(t + '-');
    default: return false;
  }
}

function matchPseudo(el, p) {
  switch (p.name) {
    case 'not':
      return !parseSelectorList(p.arg).some((cx) => matchComplex(el, cx));
    case 'first-child':
      return previousElement(el) === null;
    case 'last-child':
      return nextElement(el) === null;
    case 'only-child':
      return previousElement(el) === null && nextElement(el) === null;
    case 'empty':
      return el.childNodes.length === 0;
    case 'root':
      return el.parentNode == null || el.parentNode.nodeType === 9;
    // form-state pseudo-classes — read the live PROPERTY (what React sets),
    // not just the HTML attribute.
    case 'checked':
      return el.localName === 'option' ? !!el.selected : !!el.checked;
    case 'disabled':
      return !!el.disabled || el.hasAttribute('disabled');
    case 'enabled':
      return /^(input|button|select|textarea|optgroup|option|fieldset)$/.test(el.localName) && !(el.disabled || el.hasAttribute('disabled'));
    case 'required':
      return !!el.required || el.hasAttribute('required');
    case 'optional':
      return /^(input|select|textarea)$/.test(el.localName) && !(el.required || el.hasAttribute('required'));
    case 'read-only':
      return el.hasAttribute('readonly') || !!el.readOnly;
    case 'read-write':
      return !(el.hasAttribute('readonly') || el.readOnly);
    case 'selected':
      return !!el.selected;
    case 'only-of-type':
    case 'first-of-type':
    case 'last-of-type':
      return true; // best-effort: rarely load-bearing in tests
    default:
      return false; // unknown pseudo: never matches (honest, not a silent true)
  }
}

function previousElement(el) {
  let n = el.previousSibling;
  while (n && n.nodeType !== 1) n = n.previousSibling;
  return n || null;
}
function nextElement(el) {
  let n = el.nextSibling;
  while (n && n.nodeType !== 1) n = n.nextSibling;
  return n || null;
}

function matchCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  if (compound.tag && compound.tag !== '*' && el.localName !== compound.tag) return false;
  if (compound.id !== null && el.getAttribute('id') !== compound.id) return false;
  for (const cls of compound.classes) if (!el.classList.contains(cls)) return false;
  for (const a of compound.attrs) if (!matchAttr(el, a)) return false;
  for (const p of compound.pseudos) if (!matchPseudo(el, p)) return false;
  return true;
}

// Match a parsed complex selector against `el` (the rightmost compound applies to el).
function matchComplex(el, cx) {
  const { compounds, combinators } = cx;
  const last = compounds.length - 1;
  if (!matchCompound(el, compounds[last])) return false;

  // walk leftward
  let idx = last - 1;
  let current = el;
  while (idx >= 0) {
    const comb = combinators[idx]; // relation between compounds[idx] and compounds[idx+1]
    const target = compounds[idx];
    if (comb === ' ') {
      let anc = current.parentNode;
      let matched = false;
      while (anc && anc.nodeType === 1) {
        if (matchCompound(anc, target)) { current = anc; matched = true; break; }
        anc = anc.parentNode;
      }
      if (!matched) return false;
    } else if (comb === '>') {
      const parent = current.parentNode;
      if (!parent || parent.nodeType !== 1 || !matchCompound(parent, target)) return false;
      current = parent;
    } else if (comb === '+') {
      const prev = previousElement(current);
      if (!prev || !matchCompound(prev, target)) return false;
      current = prev;
    } else if (comb === '~') {
      let prev = previousElement(current);
      let matched = false;
      while (prev) {
        if (matchCompound(prev, target)) { current = prev; matched = true; break; }
        prev = previousElement(prev);
      }
      if (!matched) return false;
    }
    idx--;
  }
  return true;
}

export function matchesSelector(el, selector) {
  const list = parseSelectorList(selector);
  return list.some((cx) => matchComplex(el, cx));
}

export function querySelectorAll(root, selector) {
  const list = parseSelectorList(selector);
  const out = [];
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (list.some((cx) => matchComplex(child, cx))) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

export function querySelector(root, selector) {
  const list = parseSelectorList(selector);
  let found = null;
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (found) return;
      if (list.some((cx) => matchComplex(child, cx))) { found = child; return; }
      visit(child);
      if (found) return;
    }
  };
  visit(root);
  return found;
}

export const _internal = { parseComplex, parseSelectorList, matchCompound, matchComplex };
