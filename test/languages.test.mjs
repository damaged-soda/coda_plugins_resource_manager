// 认语言（view/languages.mjs）和它与图标表共用的查找（view/lookup.mjs）；打包的 highlight.js 里每个语言都在。
import assert from 'node:assert/strict';
import test from 'node:test';
import { hljs } from '../view/highlight.mjs';
import { kindOf } from '../view/icons.mjs';
import { LANGUAGE_IDS, languageOf } from '../view/languages.mjs';
import { EntryKind } from '../view/protocol.mjs';

const kind = name => kindOf({ kind: EntryKind.FILE, name }).glyph;

test('扩展名：表里的每种写法，大小写不论', () => {
  const cases = { 'a.js': 'javascript', 'a.MJS': 'javascript', 'a.tsx': 'typescript', 'a.jsonc': 'json', 'a.pyi': 'python', 'a.go': 'go', 'a.rs': 'rust', 'a.swift': 'swift',
    'a.java': 'java', 'a.kts': 'kotlin', 'a.c': 'c', 'a.h': 'cpp', 'a.hpp': 'cpp', 'a.m': 'objectivec', 'a.mm': 'objectivec', 'a.cs': 'csharp', 'a.php': 'php', 'a.rb': 'ruby',
    'a.lua': 'lua', 'a.sql': 'sql', 'a.r': 'r', 'a.pm': 'perl', 'a.dart': 'dart', 'a.scala': 'scala', 'a.vue': 'xml', 'a.plist': 'xml', 'a.scss': 'scss', 'a.less': 'less',
    'a.yml': 'yaml', 'a.toml': 'ini', 'a.cfg': 'ini', 'a.mdx': 'markdown', 'a.zsh': 'bash', 'a.mk': 'makefile', 'a.dockerfile': 'dockerfile', 'a.patch': 'diff', 'a.gql': 'graphql' };
  for (const [name, id] of Object.entries(cases)) assert.equal(languageOf(name), id, name);
});

test('整名优先于扩展名：Gemfile、Rakefile、Makefile、Dockerfile，大小写不论', () => {
  const cases = { Gemfile: 'ruby', rakefile: 'ruby', PODFILE: 'ruby', Makefile: 'makefile', GNUmakefile: 'makefile', Dockerfile: 'dockerfile', Containerfile: 'dockerfile' };
  for (const [name, id] of Object.entries(cases)) assert.equal(languageOf(name), id, name);
  assert.equal(languageOf('Gemfile.lock'), null, '整名不带后缀就不是 Gemfile');
});

test('认不出的是 null：txt、log、.env、sass、fish、erb、没有扩展名、点结尾', () => {
  for (const name of ['a.txt', 'a.log', '.env', '.env.local', 'a.sass', 'a.fish', 'a.erb', 'README', 'a.', 'a.svg', 'a.unknown']) assert.equal(languageOf(name), null, name);
});

test('点开头的名字没有扩展名：.ts 认不出；.config.json 的扩展名是 json；.env.json 是 json', () => {
  assert.equal(languageOf('.ts'), null);
  assert.equal(languageOf('.config.json'), 'json');
  assert.equal(languageOf('.env.json'), 'json');
  assert.equal(languageOf('.gitignore'), null);
});

test('同一套查找：.env.json 图标是 env、语言是 json；.config.json 两边都是 json；.ts 图标是 file、语言 null', () => {
  assert.deepEqual([kind('.env.json'), languageOf('.env.json')], ['env', 'json']);
  assert.deepEqual([kind('.config.json'), languageOf('.config.json')], ['json', 'json']);
  assert.deepEqual([kind('.ts'), languageOf('.ts')], ['doc', null]);
  assert.deepEqual([kind('.env.local'), languageOf('.env.local')], ['env', null]);
  assert.deepEqual([kind('Gemfile'), languageOf('Gemfile')], ['manifest', 'ruby'], '整名在两张表里各查各的：图标是包清单，语言是 Ruby');
  assert.deepEqual([kind('x.erb'), languageOf('x.erb')], ['ruby', null], '图标认 erb，语言不认');
});

test('表里每个语言 id 在打包的构建里都能找到（三个额外语言已登记）；版本是 11.12.0', () => {
  assert.equal(hljs.versionString, '11.12.0');
  assert.equal(LANGUAGE_IDS.length, 33, "设计第 15.3 节的表共 33 个语言 id");
  for (const id of LANGUAGE_IDS) assert.ok(hljs.getLanguage(id), id);
});
