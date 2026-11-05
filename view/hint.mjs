// 页面底部的一条短提示：失败（橙色）停 5 秒，成功（普通）停 2 秒，新的提示替换旧的。树页和文件页共用。
export const HINT_MS = { warn: 5000, ok: 2000 };

export function mountHint(el) {
  let timer = null;
  return {
    // warn：失败的提示。ms 缺省按 warn 取 HINT_MS。
    show(text, { warn = true, ms = warn ? HINT_MS.warn : HINT_MS.ok } = {}) {
      el.textContent = text;
      el.classList.toggle('warn', warn);
      el.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { el.hidden = true; }, ms);
    },
    hide() {
      clearTimeout(timer);
      el.hidden = true;
    },
  };
}
