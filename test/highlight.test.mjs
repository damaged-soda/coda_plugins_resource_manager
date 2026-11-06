// 语法高亮（view/highlight.mjs）：真实的 highlight.js，配假 DOM。输出严格按格式解析，文件内容不经过 HTML 解析。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Element } from './support/dom.mjs';
import { HIGHLIGHT_LIMIT, appendAll, highlight, hljs, parse } from '../view/highlight.mjs';

globalThis.document = { createElement: tag => new Element(tag) };

const textOf = nodes => nodes.map(node => (typeof node === 'string' ? node : node.textContent)).join('');

test('上限是 128 KiB（设计原定 256 KiB，实测后按第 15.4 节的退路降到 128 KiB）', () => assert.equal(HIGHLIGHT_LIMIT, 128 * 1024));

test('解析：嵌套 span、多个类名、内嵌语言的类名、五种转义只解一次', () => {
  const html = 'a <span class="hljs-title function_">f</span>(<span class="language-javascript"><span class="hljs-string">&quot;&#x27;&amp;lt;&lt;&gt;&quot;</span></span>) &amp;amp;';
  const nodes = parse(html, 'a f("\'&lt;<>") &amp;'.length);
  assert.ok(nodes);
  assert.equal(textOf(nodes), 'a f("\'&lt;<>") &amp;');
  assert.equal(nodes[0], 'a ');
  assert.equal(nodes[1].className, 'hljs-title function_');
  const outer = nodes[3];
  assert.equal(outer.className, 'language-javascript');
  assert.equal(outer.children[0].className, 'hljs-string');
  assert.equal(outer.children[0].children.length, 1, '字符串里的转义合成一个文本节点');
});

test('解析：相邻的文本合成一个节点，没有 span 的输出也是合格的', () => {
  assert.deepEqual(parse('a&amp;b&lt;c', 5), ['a&b<c']);
  assert.deepEqual(parse('', 0), []);
});

test('解析：格式之外的内容一律失败', () => {
  const bad = ['<b>x</b>', '<script>x</script>', '&nbsp;', '&amp', '&#39;', '&unknown;', 'a</span>', '<span class="a">x', '<span class="a">x</span></span>',
    '<span class="">x</span>', '<span class="a  b">x</span>', '<span class="a b!">x</span>', '<span class=a>x</span>', '<span class="a" id="b">x</span>', '<span class="a>x</span>', '<', 'x < y'];
  for (const html of bad) assert.equal(parse(html, 1), null, html);
});

test('解析：文字总长和原文不符也算失败', () => {
  assert.ok(parse('<span class="a">xy</span>', 2));
  assert.equal(parse('<span class="a">xy</span>', 3), null);
});

test('三种失败都返回 null：调用抛错（不认识的语言）、库吞掉的内部错误（errorRaised）、输出格式不对', () => {
  assert.equal(highlight('x', 'no-such-language'), null);
  hljs.registerLanguage('boom', () => ({ contains: [{ scope: 'string', begin: /x/, 'on:begin': () => { throw new Error('boom'); } }] }));
  assert.equal(hljs.highlight('axb', { language: 'boom', ignoreIllegals: true }).errorRaised.message, 'boom', '库确实带着 errorRaised 返回了纯文本转义');
  assert.equal(highlight('axb', 'boom'), null);
});

test('库的输出格式不对时失败：highlight 把库的结果交给解析', t => {
  t.mock.method(hljs, 'highlight', () => ({ value: '<b>x</b>' }));
  assert.equal(highlight('x', 'json'), null);
});

test('没有 span 的正常输出不算失败：空文件、只有普通标识符的文件', () => {
  assert.deepEqual(highlight('', 'json'), []);
  assert.deepEqual(highlight('abc', 'python'), ['abc']);
});

// 原文一致：文字拼起来等于原文，CR、NUL、未配对的代理项都不被规范化，字面的 &lt; 和 <script> 是文字。
const SAMPLES = {
  script: '<script>alert(1)</script>\n',
  img: '<img src=x onerror=alert(1)>',
  literal: '&lt;div&gt; &amp;amp; &#x27;',
  crlf: 'a\r\nb\r\n',
  lone: 'a\rb\r',
  nul: 'a\0b\0',
  tab: '\ta\t\tb',
  emoji: 'x = "😀👨‍👩‍👧"',
  surrogate: 'x = "\uD800" + \uDC00',
  empty: '',
  newline: 'x\n',
  noNewline: 'x',
  html: '<!doctype html><script>let s = "<b>&amp;</b>"; // \r\n</script><style>a { color: red }</style><p onclick="x">&lt;</p>',
};

for (const language of ['javascript', 'xml', 'markdown', 'json', 'python', 'css', 'bash', 'diff']) {
  test(`原文一致（${language}）：文字拼起来等于原文，没有多出的元素`, () => {
    for (const [name, text] of Object.entries(SAMPLES)) {
      const nodes = highlight(text, language);
      assert.ok(nodes, `${language}/${name} 没能高亮`);
      assert.equal(textOf(nodes), text, `${language}/${name}`);
      const spans = [];
      const walk = list => list.forEach(node => { if (typeof node !== 'string' && node.tagName) { spans.push(node.tagName); walk(node.children); } });
      walk(nodes);
      assert.ok(spans.every(tag => tag === 'SPAN'), `${language}/${name}：只有 span`);
    }
  });
}

test('真实的高亮：关键字、字符串、内嵌脚本的类名都出来了', () => {
  const nodes = highlight('<script>let s = "a";</script>', 'xml');
  const classes = new Set();
  const walk = list => list.forEach(node => { if (typeof node !== 'string' && node.tagName) { node.className.split(' ').forEach(c => classes.add(c)); walk(node.children); } });
  walk(nodes);
  for (const name of ['hljs-tag', 'hljs-name', 'language-javascript', 'hljs-keyword', 'hljs-string']) assert.ok(classes.has(name), name);
});

test('节点很多也能放进去：分批 append', () => {
  const parent = new Element('pre');
  appendAll(parent, Array.from({ length: 10_001 }, (_, i) => String(i)));
  assert.equal(parent.children.length, 10_001);
  assert.equal(parent.textContent.length, [...Array(10_001).keys()].join('').length);
});
