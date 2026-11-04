// 说明区：一段文字，或「没连上 + 原因 + 重试」。树页和文件页共用。
// 重画会换掉正在聚焦的按钮：焦点留在说明区里（有重试按钮就落在它上面），不丢到页面外。
export function showNotice(el, { text, failure, retry }) {
  const focused = el.contains(document.activeElement);
  let target = el;
  if (failure === undefined) el.textContent = text;
  else {
    const button = document.createElement('button'), title = document.createElement('p'), reason = document.createElement('p');
    title.textContent = '没有连上资源管理器的后台';
    reason.className = 'secondary';
    reason.textContent = failure;
    button.className = 'link';
    button.textContent = '重试';
    button.addEventListener('click', retry);
    el.replaceChildren(title, reason, button);
    target = button;
  }
  if (focused) { el.tabIndex = -1; target.focus(); }
}
