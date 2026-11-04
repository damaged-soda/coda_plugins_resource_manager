// 最小的假 DOM，只够加载真实的 view/app.mjs：元素树、事件冒泡、classList、textContent，没有布局和选择器引擎。
class Text {
  parent = null;
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}

class Emitter {
  #listeners = new Map();
  addEventListener(type, fn) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]); }
  emit(event) { for (const fn of this.#listeners.get(event.type) ?? []) fn(event); }
}

export class Element extends Emitter {
  parent = null;
  children = [];
  attributes = new Map();
  style = {};
  dataset = {};
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 0;
  offsetWidth = 100;
  offsetHeight = 100;
  inert = false;

  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => ((force ?? !classes.has(name)) ? classes.add(name) : classes.delete(name), classes.has(name)),
      values: () => [...classes],
    };
    this.className = '';
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: value => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
    });
  }

  get hidden() { return this.attributes.has('hidden'); }
  set hidden(on) { if (on) this.attributes.set('hidden', ''); else this.attributes.delete('hidden'); }
  get title() { return this.attributes.get('title') ?? ''; }
  set title(value) { this.attributes.set('title', String(value)); }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(...(value === '' ? [] : [String(value)])); }

  setAttribute(name, value) { if (name === 'class') this.className = value; else this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new Text(node) : node;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  // 只支持 .class。
  closest(selector) {
    for (let at = this; at instanceof Element; at = at.parent) if (at.classList.contains(selector.slice(1))) return at;
    return null;
  }
  getBoundingClientRect() { return { height: 24, width: 100 }; }
  dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, ...init };
    for (let at = this; at instanceof Element; at = at.parent) at.emit(event);
    return event;
  }
  find(predicate) {
    const found = [];
    const walk = node => { if (node instanceof Element) { if (predicate(node)) found.push(node); node.children.forEach(walk); } };
    walk(this);
    return found;
  }
}

// 不在文档里的元素（hidden 或 off）不算可见。
export function visible(node) {
  for (let at = node; at instanceof Element; at = at.parent) if (at.hidden || at.classList.contains('off')) return false;
  return true;
}

// 装上 window、document 等全局并加载真实的页面入口（默认 view/app.mjs），每次得到全新的模块实例。
let instance = 0;
export async function loadApp(t, coda, { entry = 'app.mjs', ids = ['bar', 'tree', 'preview', 'notice', 'menu'] } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, new Element('div')]));
  elements.bar.hidden = true;
  if (elements.menu) elements.menu.hidden = true;
  const windowEmitter = new Emitter(), documentEmitter = new Emitter();
  const dom = {
    window: Object.assign(windowEmitter, { coda }),
    document: Object.assign(documentEmitter, { getElementById: id => elements[id], createElement: tag => new Element(tag) }),
    innerWidth: 320,
    innerHeight: 600,
    ResizeObserver: class { observe() {} },
  };
  const saved = Object.fromEntries(Object.keys(dom).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, dom);
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  await import(`../../view/${entry}?instance=${++instance}`);
  return {
    ...elements,
    // 模块发给页面的消息。
    post: data => windowEmitter.emit({ type: 'message', data }),
  };
}

export const loadFileApp = (t, coda) => loadApp(t, coda, { entry: 'file-app.mjs', ids: ['bar', 'preview', 'notice'] });
