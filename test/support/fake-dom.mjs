// @ts-check
/**
 * A minimal DOM for tests (DESIGN §12.7): `createElement`, text nodes, fragments, attributes,
 * `textContent`, `append` and friends, class lists, events that bubble, focus, and a small CSS
 * selector engine (tag, `#id`, `.class`, `[attr]`, `[attr=value]`, descendant and `>` child
 * combinators, and comma lists). The HTML-parsing sinks throw, so a view that reached for one would
 * fail its test as well as the banned-sink scan.
 *
 * This file is a helper: `node --test` loads it, and it only exports functions.
 */

/** @typedef {Record<string, any>} FakeNode */
/** @typedef {Record<string, any>} FakeDocument */

/** Elements that never have children, for `serialise`. */
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'wbr']);

/** @param {string} what */
const banned = (what) => () => {
  throw new Error(`${what} is banned in Unsung's explorer (DESIGN §10.8)`);
};

/**
 * Copy properties with their getters and setters intact (`Object.assign` would call the getters).
 * @param {object} target
 * @param {object} source
 * @returns {any}
 */
function defineAll(target, source) {
  return Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
}

/**
 * @param {string} s
 * @returns {string}
 */
function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * @param {string} s
 * @returns {string}
 */
function camel(s) {
  return s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

/**
 * Create a bubbling event object.
 * @param {string} type
 * @param {Record<string, any>} [init] e.g. `{key: 'j', shiftKey: false}`
 * @returns {Record<string, any>}
 */
export function createEvent(type, init = {}) {
  const ev = {
    type, bubbles: true, cancelable: true, key: undefined, ctrlKey: false, metaKey: false, altKey: false,
    shiftKey: false, target: null, currentTarget: null, defaultPrevented: false, stopped: false,
    ...init,
    preventDefault() {
      ev.defaultPrevented = true;
    },
    stopPropagation() {
      ev.stopped = true;
    },
  };
  return ev;
}

/**
 * A keydown event.
 * @param {string} key
 * @param {Record<string, any>} [init]
 * @returns {Record<string, any>}
 */
export function keydown(key, init = {}) {
  return createEvent('keydown', { key, ...init });
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{tag: string | null, id: string | null, classes: string[],
 *   attrs: {name: string, value: string | null}[]}} Compound
 */

/** Parts of a compound selector: tag, #id, .class, [attr] or [attr=value], and *. */
const COMPOUND_PARTS = [
  String.raw`([a-zA-Z][a-zA-Z0-9-]*)`,
  String.raw`#([\w-]+)`,
  String.raw`\.([\w-]+)`,
  String.raw`\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]`,
  String.raw`(\*)`,
].join('|');

/**
 * @param {string} text
 * @returns {Compound}
 */
function parseCompound(text) {
  /** @type {Compound} */
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = new RegExp(COMPOUND_PARTS, 'gy');
  let m;
  let pos = 0;
  while (pos < text.length && (m = re.exec(text))) {
    if (m[1]) c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] ?? null });
    pos = re.lastIndex;
  }
  if (pos !== text.length) throw new Error(`Unsupported selector: ${text}`);
  return c;
}

/**
 * @param {string} selector
 * @returns {{compound: Compound, combinator: ' ' | '>'}[][]}
 */
function parseSelector(selector) {
  return selector.split(',').map((group) => {
    const tokens = group.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    /** @type {{compound: Compound, combinator: ' ' | '>'}[]} */
    const parts = [];
    let combinator = /** @type {' ' | '>'} */ (' ');
    for (const t of tokens) {
      if (t === '>') {
        combinator = '>';
        continue;
      }
      parts.push({ compound: parseCompound(t), combinator });
      combinator = ' ';
    }
    return parts;
  });
}

/**
 * @param {FakeNode} node
 * @param {Compound} c
 * @returns {boolean}
 */
function matchesCompound(node, c) {
  if (!node || node.nodeType !== 1) return false;
  if (c.tag && node.localName !== c.tag) return false;
  if (c.id && node.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!node.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!node.hasAttribute(a.name)) return false;
    if (a.value !== null && node.getAttribute(a.name) !== a.value) return false;
  }
  return true;
}

/**
 * @param {FakeNode} node
 * @param {{compound: Compound, combinator: ' ' | '>'}[]} parts
 * @param {number} i
 * @returns {boolean}
 */
function matchesFrom(node, parts, i) {
  if (!matchesCompound(node, parts[i].compound)) return false;
  if (i === 0) return true;
  const combinator = parts[i].combinator;
  let p = node.parentNode;
  if (combinator === '>') return Boolean(p) && matchesFrom(p, parts, i - 1);
  while (p) {
    if (matchesFrom(p, parts, i - 1)) return true;
    p = p.parentNode;
  }
  return false;
}

/**
 * @param {FakeNode} node
 * @param {string} selector
 * @returns {boolean}
 */
function matchesSelector(node, selector) {
  return parseSelector(selector)
    .some((parts) => parts.length > 0 && matchesFrom(node, parts, parts.length - 1));
}

/**
 * @param {FakeNode} root
 * @param {(n: FakeNode) => boolean} test
 * @param {FakeNode[]} out
 * @returns {FakeNode[]}
 */
function collect(root, test, out = []) {
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 1 && test(child)) out.push(child);
    collect(child, test, out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

/**
 * Methods shared by every node that can hold children.
 * @type {Record<string, any>}
 */
const parentProto = {
  get firstChild() {
    return this.childNodes[0] ?? null;
  },
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  },
  get children() {
    return this.childNodes.filter((/** @type {FakeNode} */ n) => n.nodeType === 1);
  },
  get childElementCount() {
    return this.children.length;
  },
  get textContent() {
    return this.childNodes.map((/** @type {FakeNode} */ n) => (n.nodeType === 8 ? '' : n.textContent))
      .join('');
  },
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = value === null || value === undefined ? '' : String(value);
    if (s) this.appendChild(this.ownerDocument.createTextNode(s));
  },
  /** @param {FakeNode} node */
  appendChild(node) {
    return this.insertBefore(node, null);
  },
  /** @param {...(FakeNode | string)} nodes */
  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
    }
  },
  /** @param {...(FakeNode | string)} nodes */
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) {
      this.insertBefore(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n, first);
    }
  },
  /**
   * @param {FakeNode} node
   * @param {FakeNode | null} ref
   */
  insertBefore(node, ref) {
    if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') {
      throw new TypeError('insertBefore: not a node');
    }
    if (node.nodeType === 11) {
      const kids = node.childNodes.slice();
      for (const k of kids) this.insertBefore(k, ref);
      return node;
    }
    for (let p = this; p; p = p.parentNode) {
      if (p === node) throw new Error('Cannot insert a node into itself');
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error('insertBefore: the reference is not a child');
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  },
  /** @param {FakeNode} node */
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  },
  /** @param {...(FakeNode | string)} nodes */
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  },
  /** @param {FakeNode} node */
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  },
  /** @param {string} selector */
  querySelector(selector) {
    return collect(this, (n) => matchesSelector(n, selector))[0] ?? null;
  },
  /** @param {string} selector */
  querySelectorAll(selector) {
    return collect(this, (n) => matchesSelector(n, selector));
  },
};

/** Event plumbing shared by nodes and the document. @type {Record<string, any>} */
const eventProto = {
  /**
   * @param {string} type
   * @param {Function} fn
   */
  addEventListener(type, fn) {
    if (typeof fn !== 'function') return;
    (this.listeners[type] ??= []).push(fn);
  },
  /**
   * @param {string} type
   * @param {Function} fn
   */
  removeEventListener(type, fn) {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter((/** @type {Function} */ f) => f !== fn);
  },
  /** @param {Record<string, any>} ev */
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    /** @type {FakeNode | null} */
    let node = this;
    while (node) {
      ev.currentTarget = node;
      for (const fn of (node.listeners?.[ev.type] ?? []).slice()) fn.call(node, ev);
      if (ev.stopped || !ev.bubbles) break;
      node = node.parentNode ?? null;
    }
    return !ev.defaultPrevented;
  },
};

/** @returns {any} an object whose prototype carries the event methods */
function withEvents() {
  return Object.create(Object.assign(Object.create(null), eventProto));
}

/**
 * @param {FakeDocument} doc
 * @param {string} tag
 * @returns {FakeNode}
 */
function makeElement(doc, tag) {
  const localName = String(tag).toLowerCase();
  /** @type {Map<string, string>} */
  const attrs = new Map();
  /** @type {Map<string, string>} */
  const styleProps = new Map();
  const el = withEvents();
  defineAll(el, parentProto);
  /** @param {string} name @param {boolean} on */
  const flag = (name, on) => (on ? attrs.set(name, '') : attrs.delete(name));
  defineAll(el, {
    nodeType: 1, localName, tagName: localName.toUpperCase(), nodeName: localName.toUpperCase(),
    ownerDocument: doc, parentNode: null, childNodes: [], listeners: {}, value: '', checked: false,
    selected: false,
    style: {
      /** @param {string} k @param {string} v */
      setProperty: (k, v) => styleProps.set(k, String(v)),
      /** @param {string} k */
      removeProperty: (k) => styleProps.delete(k),
      /** @param {string} k */
      getPropertyValue: (k) => styleProps.get(k) ?? '',
      props: styleProps,
    },
    /** @param {string} name @param {unknown} value */
    setAttribute(name, value) {
      const n = String(name).toLowerCase();
      if (!/^[a-z_:][a-z0-9_.:-]*$/.test(n)) throw new Error(`Invalid attribute name: ${name}`);
      attrs.set(n, String(value));
    },
    /** @param {string} name */
    getAttribute(name) {
      const v = attrs.get(String(name).toLowerCase());
      return v === undefined ? null : v;
    },
    /** @param {string} name */
    hasAttribute(name) {
      return attrs.has(String(name).toLowerCase());
    },
    /** @param {string} name */
    removeAttribute(name) {
      attrs.delete(String(name).toLowerCase());
    },
    /** @param {string} name @param {boolean} [force] */
    toggleAttribute(name, force) {
      const on = force ?? !attrs.has(name);
      flag(name, on);
      return on;
    },
    get attributes() {
      return [...attrs].map(([name, value]) => ({ name, value }));
    },
    get id() {
      return attrs.get('id') ?? '';
    },
    set id(v) {
      attrs.set('id', String(v));
    },
    get className() {
      return attrs.get('class') ?? '';
    },
    set className(v) {
      if (v) attrs.set('class', String(v));
      else attrs.delete('class');
    },
    get classList() {
      const list = () => (attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
      /** @param {string[]} l */
      const save = (l) => (l.length ? attrs.set('class', l.join(' ')) : attrs.delete('class'));
      return {
        /** @param {...string} c */
        add: (...c) => save([...new Set([...list(), ...c])]),
        /** @param {...string} c */
        remove: (...c) => save(list().filter((x) => !c.includes(x))),
        /** @param {string} c */
        contains: (c) => list().includes(c),
        /** @param {string} c @param {boolean} [force] */
        toggle: (c, force) => {
          const on = force ?? !list().includes(c);
          save(on ? [...new Set([...list(), c])] : list().filter((x) => x !== c));
          return on;
        },
        get value() {
          return list().join(' ');
        },
      };
    },
    get dataset() {
      return new Proxy({}, {
        get: (_t, k) => attrs.get(`data-${kebab(String(k))}`),
        set: (_t, k, v) => {
          attrs.set(`data-${kebab(String(k))}`, String(v));
          return true;
        },
        has: (_t, k) => attrs.has(`data-${kebab(String(k))}`),
        ownKeys: () => [...attrs.keys()].filter((k) => k.startsWith('data-')).map((k) => camel(k.slice(5))),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      });
    },
    get hidden() {
      return attrs.has('hidden');
    },
    set hidden(v) {
      flag('hidden', Boolean(v));
    },
    get disabled() {
      return attrs.has('disabled');
    },
    set disabled(v) {
      flag('disabled', Boolean(v));
    },
    get href() {
      return attrs.get('href') ?? '';
    },
    get title() {
      return attrs.get('title') ?? '';
    },
    set title(v) {
      attrs.set('title', String(v));
    },
    get isContentEditable() {
      const v = attrs.get('contenteditable');
      return v === 'true' || v === '';
    },
    focus() {
      doc.activeElement = el;
    },
    blur() {
      if (doc.activeElement === el) doc.activeElement = doc.body;
    },
    click() {
      el.dispatchEvent(createEvent('click'));
    },
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    /** @param {string} selector */
    matches: (selector) => matchesSelector(el, selector),
    /** @param {string} selector */
    closest(selector) {
      for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, selector)) return n;
      return null;
    },
  });
  Object.defineProperty(el, 'innerHTML', { get: banned('innerHTML'), set: banned('innerHTML') });
  Object.defineProperty(el, 'outerHTML', { get: banned('outerHTML'), set: banned('outerHTML') });
  el.insertAdjacentHTML = banned('insertAdjacentHTML');
  return el;
}

/**
 * @param {FakeDocument} doc
 * @param {unknown} data
 * @returns {FakeNode}
 */
function makeText(doc, data) {
  const node = withEvents();
  let text = data === null || data === undefined ? '' : String(data);
  const accessor = { get: () => text, set: (/** @type {unknown} */ v) => { text = String(v ?? ''); } };
  Object.defineProperties(node, { textContent: accessor, data: accessor, nodeValue: accessor });
  Object.assign(node, {
    nodeType: 3, nodeName: '#text', ownerDocument: doc, parentNode: null, listeners: {},
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
  });
  return node;
}

/**
 * @param {FakeDocument} doc
 * @returns {FakeNode}
 */
function makeFragment(doc) {
  const frag = withEvents();
  defineAll(frag, parentProto);
  Object.assign(frag, { nodeType: 11, nodeName: '#document-fragment', ownerDocument: doc, parentNode: null,
    childNodes: [], listeners: {} });
  return frag;
}

/**
 * A fresh document with `<html>`, `<head>` and `<body>`.
 * @returns {FakeDocument}
 */
export function createFakeDocument() {
  /** @type {FakeDocument} */
  const doc = withEvents();
  Object.assign(doc, {
    nodeType: 9, nodeName: '#document', listeners: {}, parentNode: null, activeElement: null,
    /** @param {string} tag */
    createElement: (tag) => makeElement(doc, tag),
    /** @param {string} _ns @param {string} tag */
    createElementNS: (_ns, tag) => makeElement(doc, tag),
    /** @param {unknown} text */
    createTextNode: (text) => makeText(doc, text),
    createDocumentFragment: () => makeFragment(doc),
    /** @param {string} id */
    getElementById: (id) => collect(doc.documentElement, (n) => n.getAttribute('id') === id)[0] ?? null,
    /** @param {string} s */
    querySelector: (s) => doc.documentElement.querySelector(s) ?? null,
    /** @param {string} s */
    querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
    write: banned('document.write'),
    writeln: banned('document.writeln'),
  });
  doc.documentElement = makeElement(doc, 'html');
  doc.documentElement.parentNode = doc;
  doc.head = makeElement(doc, 'head');
  doc.body = makeElement(doc, 'body');
  doc.documentElement.append(doc.head, doc.body);
  doc.activeElement = doc.body;
  return doc;
}

/**
 * Put a fake document on `globalThis.document` for code that looks it up at call time.
 * @returns {{doc: FakeDocument, restore: () => void}}
 */
export function installFakeDom() {
  const g = /** @type {Record<string, any>} */ (globalThis);
  const had = Object.hasOwn(g, 'document');
  const before = g.document;
  const doc = createFakeDocument();
  g.document = doc;
  return {
    doc,
    restore() {
      if (had) g.document = before;
      else delete g.document;
    },
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialise a node to markup, with text escaped — so hostile text shows up as `&lt;script&gt;`,
 * never as an element. For assertions only.
 * @param {FakeNode} node
 * @returns {string}
 */
export function serialise(node) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeText(node.textContent);
  if (node.nodeType === 11 || node.nodeType === 9) return node.childNodes.map(serialise).join('');
  const attrs = node.attributes.map((/** @type {{name: string, value: string}} */ a) => ` ${a.name}="${
    escapeText(a.value).replace(/"/g, '&quot;')}"`).join('');
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialise).join('')}</${node.localName}>`;
}

/**
 * Every element under `root` (itself included), depth first.
 * @param {FakeNode} root
 * @returns {FakeNode[]}
 */
export function allElements(root) {
  return [...(root.nodeType === 1 ? [root] : []), ...collect(root, () => true)];
}
