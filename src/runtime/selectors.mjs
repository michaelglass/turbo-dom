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

// parsed-selector cache: querySelector(All)/matches re-run the same selector
// strings constantly; parsing once and reusing is a large win on query-heavy
// suites. Bounded so a pathological generator can't grow it without limit.
const __selectorCache = new Map();
export function parseSelectorList(selector) {
  const hit = __selectorCache.get(selector);
  if (hit !== undefined) return hit;
  const parsed = splitTopLevel(selector, ',').map((s) => parseComplex(s.trim()));
  if (__selectorCache.size > 10000) __selectorCache.clear();
  __selectorCache.set(selector, parsed);
  return parsed;
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
  const raw = el.getAttribute(a.name);   // single lookup (null = absent)
  if (raw === null) return false;
  if (a.op === null) return true;
  const v = raw;
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
    // positional pseudo-classes (1-based, support An+B / odd / even)
    case 'nth-child':
      return nthMatch(p.arg, siblingIndex(el) + 1);
    case 'nth-last-child':
      return nthMatch(p.arg, siblingCount(el) - siblingIndex(el));
    case 'nth-of-type':
      return nthMatch(p.arg, typeIndex(el) + 1);
    case 'nth-last-of-type':
      return nthMatch(p.arg, typeCount(el) - typeIndex(el));
    case 'first-of-type':
      return typeIndex(el) === 0;
    case 'last-of-type':
      return typeIndex(el) === typeCount(el) - 1;
    case 'only-of-type':
      return typeCount(el) === 1;
    default:
      return false; // unknown pseudo: never matches (honest, not a silent true)
  }
}

function elementSiblings(el) {
  const p = el.parentNode;
  if (!p) return [el];
  const kids = typeof p.__children === 'function' ? p.__children() : Array.from(p.childNodes || []);
  return kids.filter((n) => n.nodeType === 1);
}
function siblingIndex(el) { return elementSiblings(el).indexOf(el); }
function siblingCount(el) { return elementSiblings(el).length; }
function typeIndex(el) { return elementSiblings(el).filter((n) => n.localName === el.localName).indexOf(el); }
function typeCount(el) { return elementSiblings(el).filter((n) => n.localName === el.localName).length; }

// match An+B / odd / even / integer against a 1-based index
function nthMatch(arg, index) {
  const a0 = String(arg || '').trim().toLowerCase();
  if (a0 === 'odd') return index % 2 === 1;
  if (a0 === 'even') return index % 2 === 0;
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(a0.replace(/\s+/g, ''));
  if (m) {
    let a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2].replace(/\s/g, ''), 10) : 0;
    if (a === 0) return index === b;
    return (index - b) % a === 0 && (index - b) / a >= 0;
  }
  const n = parseInt(a0, 10);
  return !Number.isNaN(n) && index === n;
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

// allocation-free "does the class attribute contain this whole-word class"
function hasClass(cn, cls) {
  if (cn === cls) return true;
  const L = cls.length;
  let idx = cn.indexOf(cls);
  while (idx !== -1) {
    const before = idx === 0 || cn.charCodeAt(idx - 1) <= 32;
    const after = idx + L === cn.length || cn.charCodeAt(idx + L) <= 32;
    if (before && after) return true;
    idx = cn.indexOf(cls, idx + 1);
  }
  return false;
}

function matchCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  // cheapest checks first; tag/local is a plain property
  if (compound.tag && compound.tag !== '*' && el.localName !== compound.tag) return false;
  if (compound.id !== null && el.getAttribute('id') !== compound.id) return false;
  // classes: read the class attribute ONCE and test membership without
  // allocating (no ClassList, no split, no padded copy) — dominated matching.
  if (compound.classes.length) {
    const cn = el.getAttribute('class');
    if (!cn) return false;
    for (const cls of compound.classes) if (!hasClass(cn, cls)) return false;
  }
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

// Fast paths for the overwhelmingly common simple selectors, skipping the
// parse + per-element matchComplex machinery.
const SIMPLE = /^\s*(#[\w-]+|\.[\w-]+|[a-zA-Z][\w-]*)\s*$/;
function simpleMatcher(selector) {
  const m = SIMPLE.exec(selector);
  if (!m) return null;
  const s = m[1];
  if (s[0] === '#') { const id = s.slice(1); return (el) => el.getAttribute('id') === id; }
  if (s[0] === '.') { const cls = s.slice(1); return (el) => { const cn = el.getAttribute('class'); return cn ? hasClass(cn, cls) : false; }; }
  const tag = s.toLowerCase(); return (el) => el.localName === tag;
}

// child node array without allocating a filtered copy per call
function rawChildren(node) {
  return typeof node.__children === 'function' ? node.__children() : Array.from(node.childNodes || []);
}

export function querySelectorAll(root, selector) {
  const simple = simpleMatcher(selector);
  const out = [];
  if (simple) {
    const visit = (node) => {
      const kids = rawChildren(node);
      for (let i = 0; i < kids.length; i++) { const c = kids[i]; if (c.nodeType !== 1) continue; if (simple(c)) out.push(c); visit(c); }
    };
    visit(root);
    return out;
  }
  const list = parseSelectorList(selector);
  const single = list.length === 1 ? list[0] : null;
  const visit = (node) => {
    const kids = rawChildren(node);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType !== 1) continue;
      if (single ? matchComplex(c, single) : list.some((cx) => matchComplex(c, cx))) out.push(c);
      visit(c);
    }
  };
  visit(root);
  return out;
}

export function querySelector(root, selector) {
  const simple = simpleMatcher(selector);
  if (simple) {
    const visit = (node) => {
      const kids = rawChildren(node);
      for (let i = 0; i < kids.length; i++) { const c = kids[i]; if (c.nodeType !== 1) continue; if (simple(c)) return c; const r = visit(c); if (r) return r; }
      return null;
    };
    return visit(root);
  }
  const list = parseSelectorList(selector);
  const single = list.length === 1 ? list[0] : null;
  const visit = (node) => {
    const kids = rawChildren(node);
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType !== 1) continue;
      if (single ? matchComplex(c, single) : list.some((cx) => matchComplex(c, cx))) return c;
      const r = visit(c);
      if (r) return r;
    }
    return null;
  };
  return visit(root);
}

export const _internal = { parseComplex, parseSelectorList, matchCompound, matchComplex };
