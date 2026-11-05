// 「更多」菜单的测试辅助：选项在根层，视图和排序在「显示」里。Mac 放得下时「显示」在侧面板（#submenu）里，放不下或 iPhone 是切到下一层，内容换进 #menu。
import { visible } from './dom.mjs';

const buttons = node => node.find(child => child.tagName === 'BUTTON');
// 现在看得到的按钮：根面板和（开着的）侧面板。
export const shown = page => [...buttons(page.menu), ...(visible(page.submenu) ? buttons(page.submenu) : [])];
const named = (page, label) => shown(page).find(node => node.textContent === label);
// 点「显示」进到视图和排序（已经在里面就不动），返回现在的按钮。
export function showLayer(page) {
  if (!named(page, '列表')) named(page, '显示').dispatch('click');
  return shown(page);
}
// 点一项：视图和排序项先进「显示」。
export function pick(page, label) {
  const target = ['刷新', '显示隐藏文件', '显示'].includes(label) ? named(page, label) : showLayer(page).find(node => node.textContent === label);
  if (!target) throw new Error(`菜单里没有「${label}」`);
  target.dispatch('click');
}
// 「显示」里打了对勾的项（视图和排序）。
export const checkedIn = page => showLayer(page).filter(node => node.getAttribute('aria-checked') === 'true').map(node => node.textContent);
