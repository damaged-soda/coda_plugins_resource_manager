// 种类表：图标和属性页的种类文字查同一张。文件名优先于扩展名，都小写；目录、链接、其他按种类。
import assert from 'node:assert/strict';
import test from 'node:test';
import { iconFor, kindOf } from '../view/icons.mjs';

const label = name => kindOf({ kind: 'file', name }).label;

test('kindOf：每一项都是 { glyph, tone, label }，目录、链接、其他按 kind，不看名字', () => {
  for (const entry of [{ kind: 'dir', name: 'a.png' }, { kind: 'link', name: 'a.js' }, { kind: 'other', name: 'a.js' }, { kind: 'file', name: 'a.js' }]) {
    const kind = kindOf(entry);
    assert.deepEqual(Object.keys(kind).sort(), ['glyph', 'label', 'tone']);
    assert.ok(Object.values(kind).every(value => typeof value === 'string' && value !== ''));
  }
  assert.equal(kindOf({ kind: 'dir', name: 'src' }).label, '文件夹');
  assert.equal(kindOf({ kind: 'link', name: 'x' }).label, '链接');
  assert.equal(kindOf({ kind: 'other', name: 'x' }).label, '特殊文件');
});

test('文件名优先于扩展名：package.json 是包清单不是 JSON，锁文件、许可证、点开头的配置各有种类', () => {
  assert.equal(label('package.json'), '包清单');
  assert.equal(label('tsconfig.json'), 'JSON');
  assert.equal(label('package-lock.json'), '锁文件');
  assert.equal(label('pnpm-lock.yaml'), '锁文件');
  assert.equal(label('config.yaml'), 'YAML / TOML');
  assert.equal(label('LICENSE'), '许可证');
  assert.equal(label('LICENSE.md'), '许可证');
  assert.equal(label('README.md'), 'Markdown 文档');
  assert.equal(label('.gitignore'), 'Git 配置');
  assert.equal(label('.env'), '环境变量');
  assert.equal(label('.env.local'), '环境变量');
  assert.equal(label('Cargo.toml'), '包清单');
  assert.equal(label('Cargo.lock'), '锁文件');
});

test('大小写不影响：文件名和扩展名都按小写查', () => {
  assert.equal(label('PACKAGE.JSON'), '包清单');
  assert.equal(label('Main.TS'), 'TypeScript');
  assert.equal(label('LOGO.PNG'), '图片');
  assert.equal(label('Photo.JPEG'), '图片');
});

test('没有扩展名、点开头、以点结尾、多重扩展名', () => {
  assert.equal(label('Makefile'), '其他文件');
  assert.equal(label('.hidden'), '其他文件', '点开头的整个是名字，没有扩展名：.ts 不是 TypeScript');
  assert.equal(label('.ts'), '其他文件');
  assert.equal(label('trailing.'), '其他文件');
  assert.equal(label('archive.tar.gz'), '压缩包', '只看最后一段');
  assert.equal(label('notes'), '其他文件');
  assert.equal(label('.zshrc'), '其他文件');
});

test('约 30 种：语言、数据、媒体、文档、配置各有自己的种类', () => {
  const expected = {
    'a.md': 'Markdown 文档', 'a.txt': '文本', 'a.ts': 'TypeScript', 'a.tsx': 'TypeScript', 'a.js': 'JavaScript', 'a.mjs': 'JavaScript', 'a.py': 'Python', 'a.go': 'Go',
    'a.rs': 'Rust', 'a.swift': 'Swift', 'a.c': 'C / C++', 'a.hpp': 'C / C++', 'a.java': 'Java / Kotlin', 'a.kt': 'Java / Kotlin', 'a.rb': 'Ruby', 'a.json': 'JSON',
    'a.html': 'HTML / XML', 'a.xml': 'HTML / XML', 'a.css': 'CSS', 'a.toml': 'YAML / TOML', 'a.sh': 'Shell 脚本', 'a.png': '图片', 'a.svg': '图片', 'a.mp4': '视频',
    'a.mp3': '音频', 'a.pdf': 'PDF 文档', 'a.zip': '压缩包', 'a.csv': '表格', 'a.sqlite': '数据库', 'a.woff2': '字体', 'a.sql': '源代码', 'a.vue': '源代码',
  };
  for (const [name, text] of Object.entries(expected)) assert.equal(label(name), text, name);
  assert.ok(new Set(Object.values(expected)).size >= 24);
});

test('iconFor 就是种类表里的 glyph：和 kindOf 同一份，不会两边不一致', () => {
  for (const name of ['a.ts', 'a.png', 'a.md', 'package.json', '.gitignore', 'Makefile', 'LICENSE', 'a.zip']) {
    assert.equal(iconFor({ kind: 'file', name }), kindOf({ kind: 'file', name }).glyph, name);
  }
  assert.equal(iconFor({ kind: 'file', name: 'a.ts' }), 'code');
  assert.equal(iconFor({ kind: 'file', name: 'a.png' }), 'image');
  assert.equal(iconFor({ kind: 'dir', name: 'a' }), 'folder');
});
