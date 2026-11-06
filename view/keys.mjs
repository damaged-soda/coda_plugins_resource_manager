// Mac 的键盘：只认一组最小的键，不匹配的（含其他修饰键组合）返回 null，页面不拦。设计见 docs/design/phase-3.md 第 15.10 节。
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const bare = event => !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
const command = event => event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

// 浏览区：↑ ↓ ← → 移动，⌘↓ 打开（同双击），⌘↑ 回上一层。输入法组字中的按键不管。
export function browseAction(event) {
  if (event.isComposing) return null;
  if (bare(event)) return ARROWS[event.key] ?? null;
  if (command(event)) return event.key === 'ArrowDown' ? 'open' : event.key === 'ArrowUp' ? 'parent' : null;
  return null;
}

// 侧栏预览：只有 ⌘↑（返回）。
export const previewAction = event => (!event.isComposing && command(event) && event.key === 'ArrowUp' ? 'back' : null);
