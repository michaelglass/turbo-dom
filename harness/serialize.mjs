// Serialize a turbo-dom parse tree into the html5lib-tests tree-construction
// dump format, so output can be string-compared against the fixtures' #document.
//
// Format reference (html5lib-tests tree-construction/README.md):
//   line = "| " + "  " * depth + <node repr>
//   element:  <tag>                | <svg svg> (foreign: "<ns local>")
//   attr:     name="value"         (one per line, depth+1, sorted by name)
//   text:     "value"
//   comment:  <!-- value -->
//   doctype:  <!DOCTYPE name>      or  <!DOCTYPE name "public" "system">
//   template: a synthetic `content` node holding the template contents

const ELEMENT = 1;
const TEXT = 3;
const PROCESSING_INSTRUCTION = 7;
const COMMENT = 8;
const DOCUMENT = 9;
const DOCTYPE = 10;
const DOCUMENT_FRAGMENT = 11;

const indent = (depth) => '| ' + '  '.repeat(depth);

// Display name for an attribute: namespaced attrs render "prefix local".
const attrDisplayName = (a) => (a.prefix ? `${a.prefix} ${a.name}` : a.name);

function doctypeRepr(node) {
  const publicId = node.publicId ?? '';
  const systemId = node.systemId ?? '';
  const hasIds = publicId !== '' || systemId !== '';
  if (!hasIds) return `<!DOCTYPE ${node.name}>`;
  return `<!DOCTYPE ${node.name} "${publicId}" "${systemId}">`;
}

function serializeNode(node, depth, out) {
  switch (node.nodeType) {
    case ELEMENT: {
      const ns = node.namespace ? `${node.namespace} ` : '';
      out.push(`${indent(depth)}<${ns}${node.name}>`);
      // attributes: own lines, depth+1, sorted by display name
      const attrs = [...node.attrs].sort((a, b) =>
        attrDisplayName(a) < attrDisplayName(b) ? -1 : attrDisplayName(a) > attrDisplayName(b) ? 1 : 0
      );
      for (const a of attrs) {
        out.push(`${indent(depth + 1)}${attrDisplayName(a)}="${a.value}"`);
      }
      for (const c of node.children) serializeNode(c, depth + 1, out);
      break;
    }
    case TEXT:
      out.push(`${indent(depth)}"${node.value}"`);
      break;
    case COMMENT:
      out.push(`${indent(depth)}<!-- ${node.value} -->`);
      break;
    case DOCTYPE:
      out.push(`${indent(depth)}${doctypeRepr(node)}`);
      break;
    case PROCESSING_INSTRUCTION:
      out.push(`${indent(depth)}<?${node.name}${node.value ? ' ' + node.value : ''}>`);
      break;
    case DOCUMENT_FRAGMENT:
      // template `content` fragment: prints the literal word, children nested under it
      out.push(`${indent(depth)}${node.name === 'content' ? 'content' : node.name}`);
      for (const c of node.children) serializeNode(c, depth + 1, out);
      break;
    default:
      throw new Error(`unhandled nodeType ${node.nodeType} (${node.name})`);
  }
}

// Serialize the children of a document / fragment root. The root itself is not printed.
export function serializeTree(root) {
  const out = [];
  for (const c of root.children) serializeNode(c, 0, out);
  return out.join('\n');
}

// Exposed for unit testing.
export const _internal = { indent, attrDisplayName, doctypeRepr, serializeNode };
