// 页内工具条：没有 coda.toolbar 的平台（iPhone）用。两个页面共用，按钮由页面给。
// 「返回」只在横屏出现（导航栏隐藏时），显示与否由 style.css 的媒体查询决定，这里一律画出来。
export const EXIT = { id: 'exit', label: '返回', kind: 'button' };

export function paintBar(el, items, act) {
  el.hidden = false;
  el.replaceChildren(...items.map(item => {
    const button = document.createElement('button');
    button.textContent = item.label;
    if (item.id === EXIT.id) button.classList.add('exit');
    button.setAttribute('aria-pressed', item.kind === 'toggle' ? String(item.on) : 'false');
    if (item.on) button.classList.add('on');
    button.addEventListener('click', () => act(item.id));
    return button;
  }));
}
