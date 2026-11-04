# 资源管理器

Coda 插件：会话旁的文件浏览器。浏览这个会话的工作目录，读文本和图片，把路径交给对话。只读。

- **Mac**：在会话侧栏里，和对话并排。
- **iPhone**：在会话右上角菜单里打开，点文件推入一层。iPad 和 iPhone Duo 用同一套界面，没有单独适配。

## 功能

- 按需展开目录，超大目录分页显示。
- 文本预览（带行号，可跨行选中复制，最多读 1 MiB）和图片预览（PNG、JPEG、GIF、WebP、SVG，最多 8 MiB）。
- Agent 一轮结束后，已展开的目录和正在看的文件自动更新。
- 切换会话时换成新会话的内容，切回来恢复展开状态和滚动位置。
- Mac：右键复制相对或绝对路径，或把文件拖到输入框；预览可以开到独立窗口；工具栏只有一个「更多」按钮，按下弹出菜单（刷新、显示隐藏文件），侧栏预览头部最左边的「返回」回到目录树。
- iPhone：长按复制路径；目录树页右上角「⋯」里有刷新和显示隐藏文件；文件页底部工具条有刷新和「复制路径」。
- 默认隐藏 `.git`、`.DS_Store`，Mac 在工具栏的「更多」菜单里、iPhone 在目录树页右上角的「⋯」里可切换显示全部。

只能读这个会话的工作目录。指向工作目录之外的符号链接只显示，不能打开。

## 安装

在 Coda 的「设置 › 插件 › 商店」里找到「资源管理器」安装；也可以用「从 npm 添加…」填 `@coda-console/resource-manager`。

也可以在「设置 › 插件 › 从仓库添加…」里填 `sealiu1997/coda_plugins_resource_manager`，版本留空即跟随默认分支。

装好后，在会话侧栏的标签里打开「资源管理器」。

## 开发

不需要安装依赖，也没有构建步骤。Node 由 Coda 提供（`$CODA_NODE`）。

```sh
# 测试，也可以用 npm test。Node 24 上不能写成 node --test test/
"$CODA_NODE" --test test/*.test.mjs

# 不进 Coda，用假的 window.coda 在浏览器里看真实页面
"$CODA_NODE" test/harness/server.mjs <会话A的目录> [会话B的目录] [端口]

# 真实布局的断言和截图：无头 Chrome 打开 Mac 侧栏、iPhone 竖屏和横屏的目录树与文件页（浅色、深色），
# 量行高、工具条、菜单的位置和尺寸。自己起服务和临时目录，用完删掉；截图在系统临时目录里，路径在最后打印。
# 失败时退出码非 0。Chrome 不在默认位置时把路径作参数传入
"$CODA_NODE" test/harness/layout.mjs [Chrome 的路径]

# 契约检查，<提交> 用 coda-console/coda-plugins 的提交号
npx --yes github:coda-console/coda-plugins#<提交> . --manifest
```

在这台机器上试改时，「从仓库添加…」填本机仓库的绝对路径，版本填分支名。Coda 只读取已提交的内容，未提交的改动看不到。

`test/harness/` 用的是普通浏览器，不是 Coda 客户端里的 WebKit，改完还要在客户端里看一遍。

## 文档

- [一期设计](docs/design/phase-1.md)：消息协议、路径校验和页面规则。
- [二期设计](docs/design/phase-2.md)：iPhone 适配和独立文件视图。
- [可选需求清单](docs/backlog.md)：之后可能做的需求。
- [评审准则](.coda/review.md)。

## 发布

1. 改 `package.json` 的 `version`，合并到 `main`。
2. 运行 `gh workflow run publish.yml --ref main`。工作流先看这个版本是不是已在 npm 上，已有就跳过。

工作流用 npm 可信发布，不需要令牌。只有手动运行才会发布，合并到 `main` 不会自动发布。

首次发布要先有包，可信发布才能配置：在本机 `npm login` 后手动运行 `npm publish --access public`，再到 npm 上 `@coda-console/resource-manager` 的设置里配置可信发布，仓库填 `sealiu1997/coda_plugins_resource_manager`，流程文件填 `publish.yml`，并勾选允许 `npm publish`（Allow npm publish）。新配置默认只允许 `npm stage publish`，不勾选的话工作流的发布步骤会被拒绝。之后就按上面的步骤走。

## 许可

MIT
