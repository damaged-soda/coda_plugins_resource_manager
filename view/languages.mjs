// 认语言：文件名到 highlight.js 的语言 id，只按文件名和扩展名，不猜内容；不在表里的是 null，显示纯文本。
import { invert, lookupByName } from './lookup.mjs';

const NAMES = {
  ruby: ['gemfile', 'rakefile', 'podfile'],
  makefile: ['makefile', 'gnumakefile'],
  dockerfile: ['dockerfile', 'containerfile'],
};
const EXTENSIONS = {
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  json: ['json', 'jsonc', 'json5'],
  python: ['py', 'pyw', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  swift: ['swift'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  c: ['c'],
  cpp: ['h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'], // .h 一律按 C++
  objectivec: ['m', 'mm'], // .m 一律按 Objective-C
  csharp: ['cs'],
  php: ['php'],
  ruby: ['rb'],
  lua: ['lua'],
  sql: ['sql'],
  r: ['r'],
  perl: ['pl', 'pm'],
  dart: ['dart'],
  scala: ['scala'],
  xml: ['html', 'htm', 'xml', 'xhtml', 'plist', 'vue'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  yaml: ['yml', 'yaml'],
  ini: ['toml', 'ini', 'cfg'],
  markdown: ['md', 'markdown', 'mdx'],
  bash: ['sh', 'bash', 'zsh'],
  makefile: ['mk'],
  dockerfile: ['dockerfile'],
  diff: ['diff', 'patch'],
  graphql: ['graphql', 'gql'],
};
const BY_NAME = invert(NAMES), BY_EXTENSION = invert(EXTENSIONS);

export const languageOf = name => lookupByName(name, BY_NAME, BY_EXTENSION) ?? null;

// 给测试：表里出现的所有语言 id。
export const LANGUAGE_IDS = [...new Set([...Object.keys(NAMES), ...Object.keys(EXTENSIONS)])];
