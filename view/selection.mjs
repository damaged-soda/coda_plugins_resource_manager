// 预览里选中的文字：裁到正文元素里面，算出覆盖的行。DOM 的部分只用 Range 的标准方法，行号是纯函数。
const START_TO_START = 0, END_TO_END = 2; // Range.START_TO_START、Range.END_TO_END

// el 是正文（一个 pre 加一个文本节点）。选区为空或和 el 不相交返回 null；
// 否则把选区裁到 el 里，返回 { text, start }：裁剪后的文字和它在 el 文字里的起点（UTF-16 偏移）。裁剪后为空也返回 null。
// 选区的起点或终点落在 el 外面（跨出正文、从行号列开始拖）时，裁掉外面的部分。
export function clippedSelection(el, selection = globalThis.getSelection?.()) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(el)) return null;
  const whole = document.createRange();
  whole.selectNodeContents(el);
  const clipped = range.cloneRange();
  if (range.compareBoundaryPoints(START_TO_START, whole) < 0) clipped.setStart(whole.startContainer, whole.startOffset);
  if (range.compareBoundaryPoints(END_TO_END, whole) > 0) clipped.setEnd(whole.endContainer, whole.endOffset);
  const text = clipped.toString();
  if (text === '') return null;
  const before = whole.cloneRange();
  before.setEnd(clipped.startContainer, clipped.startOffset);
  return { text, start: before.toString().length };
}

const lineAt = (text, offset) => {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line++;
  return line;
};

// 选中 text[start, end) 覆盖的行（从 1 数）。选区的结尾正好在行首时（如三击选行，选区包含那一行的换行）不算下一行。
export function linesOf(text, start, end) {
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  return { startLine: lineAt(text, start), endLine: lineAt(text, Math.max(start, last)) };
}
