// 菜单：Mac 右键、iPhone 长按的行菜单，Mac 选中文字的右键菜单，iPhone 的 ⋯ 和 Mac 原生「更多」弹出的菜单都用它，树页和文件页各挂一个。
// 菜单开着时点菜单外只关菜单、紧接着的那次点击不交给页面；Escape、窗口失焦关闭；页面里别的滚动区域滚动时由页面调 hide。
import { icon } from './icons.mjs';

// el：页面里的 #menu。open 之后的位置按安全区夹住（横屏时客户端不替页面留）；offsetWidth 在显示后才量得到。
// 高度有上限（style.css 的 .menu）：内容多时在菜单里滚动，不超出安全区。
export function mountMenu(el) {
  let opener = null; // 打开菜单的按钮；用点打开的没有
  let current = null; // 这一次打开的标记：关闭之后留在手里的按钮不再响应

  // anchor：按钮元素或同样有 getBoundingClientRect 的假锚点（菜单贴在它下面、右对齐）或 { clientX, clientY } 的点。
  // items：[{ label, run, checked?, radio? } | { separator: true } | { heading }]，checked 不是 undefined 的带对勾（radio 的是单选，其余是开关）；
  // 分隔线和小标题不是菜单项，不可点。title 写在菜单顶上：iPhone 没有 title 悬停，长文件名在行里被截断，这里看全；detail 是它下面的一行小字。
  function open(anchor, { title, detail, items }) {
    hide();
    const mine = current = {};
    const head = [];
    if (title !== undefined) head.push(Object.assign(document.createElement('p'), { className: 'menu-path secondary', textContent: title }));
    if (detail !== undefined) head.push(Object.assign(document.createElement('p'), { className: 'menu-info secondary caption', textContent: detail }));
    const checkable = items.some(item => item.checked !== undefined); // 有开关项时，每一项都留出对勾的位置，文字才对齐
    el.replaceChildren(...head, ...items.map(({ label, run, checked, radio, separator, heading }) => {
      if (separator) return Object.assign(document.createElement('hr'), { className: 'menu-sep' });
      if (heading !== undefined) return Object.assign(document.createElement('p'), { className: 'menu-head secondary caption', textContent: heading });
      const button = document.createElement('button'), name = document.createElement('span');
      name.textContent = label;
      if (checkable) {
        const mark = document.createElement('span');
        mark.className = 'check';
        if (checked) mark.append(icon('check', 16));
        button.append(mark);
      }
      button.append(name);
      button.setAttribute('role', checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox');
      if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
      button.addEventListener('click', () => {
        if (current !== mine) return; // 菜单已经关了（或换成了别的）：留在手里的按钮不再响应
        hide();
        run();
      });
      return button;
    }));
    el.hidden = false;
    el.scrollTop = 0;
    const box = anchor.getBoundingClientRect?.();
    const x = box ? box.right - el.offsetWidth : anchor.clientX, y = box ? box.bottom + 4 : anchor.clientY;
    el.style.left = `max(var(--safe-left), min(${x}px, calc(100vw - var(--safe-right) - ${el.offsetWidth + 4}px)))`;
    el.style.top = `max(var(--safe-top), min(${y}px, calc(100vh - var(--safe-bottom) - ${el.offsetHeight + 4}px)))`;
    if (box) { opener = anchor; opener.setAttribute?.('aria-expanded', 'true'); }
  }

  function hide() {
    current = null;
    el.hidden = true;
    opener?.setAttribute?.('aria-expanded', 'false');
    opener = null;
  }

  // 菜单开着时点菜单外：只关菜单，紧接着的那次点击不交给页面。
  let dismissed = false;
  document.addEventListener('pointerdown', event => {
    dismissed = !el.hidden && !el.contains(event.target);
    if (!el.contains(event.target)) hide();
  }, true);
  document.addEventListener('click', event => {
    if (dismissed) { dismissed = false; event.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('blur', hide);

  return {
    open, hide,
    get hidden() { return el.hidden; },
    // 谁打开的菜单：同一个按钮再次激活就关闭（键盘激活没有 pointerdown，上面那条规则管不到）。
    get opener() { return opener; },
  };
}
