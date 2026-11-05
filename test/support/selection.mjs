// 假的选区：假 DOM 没有 Range 和 Selection，这里按「文档里的字符偏移」实现 view/selection.mjs 用到的那几个方法。
// 文档的文字是 .code 里所有文本节点按顺序拼起来（行号列在前，正文在后），所以选区能从行号列拖进正文、也能拖出正文。
// 边界点是不透明的 { at }：setStart(container, offset) 取 container.at + offset。
export function fakeSelection(t, root) {
  const texts = node => (typeof node.data === 'string' ? [node] : node.children.flatMap(texts));
  const flat = texts(root), text = flat.map(node => node.data).join('');
  const extent = el => {
    const inside = new Set(texts(el)), first = flat.findIndex(node => inside.has(node));
    const from = flat.slice(0, first).reduce((sum, node) => sum + node.data.length, 0);
    return { from, to: from + [...inside].reduce((sum, node) => sum + node.data.length, 0) };
  };
  const sign = n => Math.sign(n);

  class FakeRange {
    constructor(a = 0, b = 0) { this.a = a; this.b = b; }
    get startContainer() { return { at: this.a }; }
    get endContainer() { return { at: this.b }; }
    startOffset = 0;
    endOffset = 0;
    intersectsNode(el) { const { from, to } = extent(el); return this.a <= to && this.b >= from; } // 擦边也算相交：由裁剪后为空接住
    selectNodeContents(el) { const { from, to } = extent(el); this.a = from; this.b = to; }
    cloneRange() { return new FakeRange(this.a, this.b); }
    setStart(container, offset) { this.a = container.at + offset; }
    setEnd(container, offset) { this.b = container.at + offset; }
    compareBoundaryPoints(how, other) { return sign(how === 0 ? this.a - other.a : this.b - other.b); }
    toString() { return text.slice(Math.max(0, this.a), Math.max(0, this.b)); }
  }
  let range = null;
  const selection = {
    get rangeCount() { return range ? 1 : 0; },
    get isCollapsed() { return !range || range.a === range.b; },
    getRangeAt: () => range,
  };
  // document 是 loadApp 装上的假 document，它的清理会整个撤掉；这里只管自己装的两样。
  const saved = globalThis.getSelection;
  globalThis.document.createRange = () => new FakeRange();
  globalThis.getSelection = () => selection;
  t.after(() => { if (saved) globalThis.getSelection = saved; else delete globalThis.getSelection; });

  return {
    // 选中 el（正文 .text）的文字里 [from, to)，偏移从 el 的文字开头数起；负数落在行号列里，超过末尾落在 el 之后。
    select(el, from, to) { const base = extent(el).from; range = new FakeRange(base + from, base + to); },
    clear() { range = null; },
  };
}
