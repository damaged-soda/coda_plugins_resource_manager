# 资源管理器

Coda 插件：会话旁的文件浏览器。在 Mac 会话侧栏里浏览这个会话的工作目录，读文本和图片，把路径交给对话，不用离开对话。

一期只读，先做 Mac。iPhone 上能打开，但界面还没有适配。

## 功能

- 按需展开目录，超大目录分页显示。
- 文本预览（带行号，可跨行选中复制，最多读 1 MiB）和图片预览（PNG、JPEG、GIF、WebP、SVG，最多 8 MiB）。
- Agent 一轮结束后，已展开的目录和正在看的文件自动更新。
- 切换会话时换成新会话的内容，切回来恢复展开状态和滚动位置。
- 右键复制相对或绝对路径，或把文件拖到输入框。
- 默认隐藏 `.git`、`.DS_Store`，工具栏可切换显示全部。

只能读这个会话的工作目录。指向工作目录之外的符号链接只显示，不能打开。

## 安装

在 Coda 的「设置 › 插件 › 从仓库添加…」里填 `sealiu1997/coda_plugins_resource_manager`，版本留空即跟随默认分支。

装好后，在会话侧栏的标签里打开「资源管理器」。

## 开发

不需要安装依赖，也没有构建步骤。Node 由 Coda 提供（`$CODA_NODE`）。

```sh
# 测试。Node 24 上不能写成 node --test test/
"$CODA_NODE" --test test/*.test.mjs

# 不进 Coda，用假的 window.coda 在浏览器里看真实页面
"$CODA_NODE" test/harness/server.mjs <会话A的目录> [会话B的目录] [端口]

# 契约检查，<提交> 用 coda-console/coda-plugins 的提交号
npx --yes github:coda-console/coda-plugins#<提交> . --manifest
```

在这台机器上试改时，「从仓库添加…」填本机仓库的绝对路径，版本填分支名。Coda 只读取已提交的内容，未提交的改动看不到。

`test/harness/` 用的是普通浏览器，不是 Coda 客户端里的 WebKit，改完还要在客户端里看一遍。

## 文档

- [一期设计](docs/design/phase-1.md)：消息协议、路径校验和页面规则。
- [可选需求清单](docs/backlog.md)：之后可能做的需求。
- [评审准则](.coda/review.md)。

## 许可

MIT
