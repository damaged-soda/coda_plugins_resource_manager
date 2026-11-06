// 按文件名查表：图标表和语言表各用一份数据、同一套查找。
// 整个文件名（小写）优先，再是 special（各表自己的规则，如图标的 .env.*），最后是扩展名（小写）；扩展名取最后一个点之后，点在开头的名字没有扩展名。
export const invert = table => new Map(Object.entries(table).flatMap(([id, keys]) => keys.map(key => [key, id])));

export function lookupByName(name, byName, byExtension, special = () => undefined) {
  const lower = String(name).toLowerCase(), dot = lower.lastIndexOf('.');
  return byName.get(lower) ?? special(lower) ?? (dot > 0 ? byExtension.get(lower.slice(dot + 1)) : undefined);
}
