// 小工具：造元素。on 开头的属性是事件监听，值为 null、undefined、false 的属性不设。
export const h = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (value != null && value !== false) node.setAttribute(key, value);
  }
  node.append(...children.flat().filter(child => child != null));
  return node;
};
