// 页内工具条：没有 coda.toolbar 的平台（iPhone）用，两个页面共用，按钮由页面给。
// 「返回」只在横屏出现（导航栏隐藏时），显示与否由 style.css 的媒体查询决定，这里一律画出来。
// 项：{ id, label, kind: 'button' | 'toggle' | 'title', glyph?, iconOnly?, text?, on?, menu? }；menu 的按钮打开菜单。title 不是按钮，只显示 label。
// 有 glyph 画图标；iconOnly 的只留图标，label 当可访问名称；否则图标后面跟文字（没有 glyph 就只有文字）。
// 给了 text 的，图标后面跟的是 text，label 当可访问名称（排序按钮：看到的是「日期」，读屏是「排序：日期，降序」）。
import { icon } from './icons.mjs';

export const EXIT = { id: 'exit', label: '返回', kind: 'button', glyph: 'back' };

// act(id, button)：button 是被点的元素，菜单要用它定位。
export function paintBar(el, items, act) {
  el.hidden = false;
  el.replaceChildren(...items.map(item => {
    if (item.kind === 'title') return Object.assign(document.createElement('span'), { className: 'bar-title grow truncate', textContent: item.label });
    const button = document.createElement('button');
    if (item.glyph) button.append(icon(item.glyph, 20));
    if (item.iconOnly || item.text !== undefined) button.setAttribute('aria-label', item.label);
    if (!item.iconOnly) button.append(Object.assign(document.createElement('span'), { textContent: item.text ?? item.label }));
    if (item.id === EXIT.id) button.classList.add('exit');
    if (item.iconOnly) button.classList.add('icon');
    if (item.kind === 'toggle') button.setAttribute('aria-pressed', String(item.on));
    if (item.menu) { button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); }
    if (item.on) button.classList.add('on');
    button.addEventListener('click', () => act(item.id, button));
    return button;
  }));
}
