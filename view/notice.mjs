// 说明区：大号图标加一段文字，或「没连上 + 原因 + 重试」。树页和文件页共用。
// 重画会换掉正在聚焦的按钮：焦点留在说明区里（有重试按钮就落在它上面），不丢到页面外。
import { icon } from './icons.mjs';

const text = content => Object.assign(document.createElement('p'), { textContent: content });

export function showNotice(el, { text: message, failure, retry, glyph = 'folder' }) {
  const focused = el.contains(document.activeElement);
  let target = el;
  const mark = document.createElement('span');
  mark.className = 'notice-icon';
  if (failure === undefined) {
    mark.append(icon(glyph, 44));
    el.replaceChildren(mark, text(message));
  } else {
    const button = document.createElement('button'), reason = text(failure);
    mark.append(icon('warning', 44));
    reason.className = 'secondary';
    button.className = 'link';
    button.textContent = '重试';
    button.addEventListener('click', retry);
    el.replaceChildren(mark, text('没有连上资源管理器的后台'), reason, button);
    target = button;
  }
  if (focused) { el.tabIndex = -1; target.focus(); }
}
