// view/selection.mjs 的行号：选中 text[start, end) 覆盖哪几行。DOM 裁剪的部分在 add-to-chat.test.mjs 里经真实的预览测。
import assert from 'node:assert/strict';
import test from 'node:test';
import { linesOf } from '../view/selection.mjs';

const TEXT = 'one\ntwo\nthree\nfour\n'; // 偏移：one 0-3，two 4-7，three 8-13，four 14-18（\n 各占一个）
const lines = (from, to, text = TEXT) => Object.values(linesOf(text, from, to));

test('单行：选中一行里的几个字，起止行相同', () => {
  assert.deepEqual(lines(4, 7), [2, 2]); // two
  assert.deepEqual(lines(5, 6), [2, 2]); // w
  assert.deepEqual(lines(0, 3), [1, 1]);
});

test('多行：起止行不同；选中跨行的一段', () => {
  assert.deepEqual(lines(4, 13), [2, 3]); // two\nthree
  assert.deepEqual(lines(1, 16), [1, 4]);
  assert.deepEqual(lines(0, 19), [1, 4], '全选：最后的换行不算第五行');
});

test('三击选行：选区带着那一行的换行、结尾正好在下一行行首，不算下一行', () => {
  assert.deepEqual(lines(4, 8), [2, 2]); // two\n
  assert.deepEqual(lines(0, 4), [1, 1]);
  assert.deepEqual(lines(14, 19), [4, 4], '最后一行带换行');
  assert.deepEqual(lines(4, 14), [2, 3], '拖选两行，结尾在第四行行首：只到第三行');
});

test('三击选最后一行（文件不以换行结尾）：结尾就是文本末尾', () => {
  assert.deepEqual(lines(8, 13, 'one\ntwo\nthree'), [3, 3]);
  assert.deepEqual(lines(0, 13, 'one\ntwo\nthree'), [1, 3]);
});

test('空行、只选了换行、从行尾开始选', () => {
  assert.deepEqual(lines(2, 3, 'a\n\nb'), [2, 2], '只选中间那个空行的换行');
  assert.deepEqual(lines(5, 11, 'hello\nworld'), [1, 2], '从第一行的行尾（换行）开始选到第二行');
  assert.deepEqual(lines(2, 6, 'hello\nworld'), [1, 1], 'llo\\n：结尾在行首，不算第二行');
  assert.deepEqual(lines(0, 1, '\n'), [1, 1]);
});

test('Windows 换行：按 \\n 数，\\r 不算换行', () => {
  const text = 'one\r\ntwo\r\nthree';
  assert.deepEqual(lines(5, 8, text), [2, 2]);
  assert.deepEqual(lines(0, 13, text), [1, 3]);
});
