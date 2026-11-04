# 资源管理器：二期设计

状态：待设计评审。标「作者定」的是已拍板的，其余是主会话的方案，评审可以质疑。一期设计见 `phase-1.md`，这里只写变化，消息协议和路径校验不变。

## 1. 目标

让用户在 iPhone 上也能用资源管理器：从会话菜单进入，浏览目录，点开文件读，返回时还在原来的位置。同时补上 Mac 的独立窗口和一期留下的小问题。

衡量标准：

- iPhone 竖屏和横屏下，行和按钮都好点（至少 44 点），内容不被刘海、圆角和底部横条挡住。
- 打开文件后，用系统的返回和侧滑回到目录树，展开状态和滚动位置都在。
- 横屏时导航栏会隐藏，页面自带的返回能回到上一层。
- 不靠长按也能复制正在看的文件的路径。
- Mac 上能把预览开到独立窗口读，窗口里的内容同样在一轮结束后更新。
- 目录刷新失败时，不管是根目录还是子目录，用户都能看到原因并重试。

## 2. 已定事项

- 二期范围：iPhone 适配、独立文件视图、Mac「在窗口打开」、一期留下的小问题。语法高亮、文件内查找、Markdown、`fs.watch`、Git 状态、搜索留到三期（作者定）。
- iPhone 打开文件时推入一层新视图，不在同一页切换（作者定）。
- iPhone 只用复制交接路径，不做写草稿按钮，等 #1810 有回复再说（作者定）。
- 文件页顶部有可见的「复制路径」，树的行支持长按（作者定）。
- iPad、Duo 不单独设计和验证，并入 iPhone（作者定）。
- 很少触发且影响不大的问题不阻断，记入 `docs/backlog.md`（作者定）。
- 仍然只读。零依赖、无构建。

## 3. 依据

**Spike 实测（2026-11-04，作者的 iPhone，页面 420×790）**：

- `coda.open({ view, args })` 推入一层；树视图随即卸载，返回时重新打开。
- 被打开的视图 `context.session` 是 `null`，要把会话 ID 放进 `args`。
- `coda.copy`、`blob:` 图片都可用。

**客户端源码（`iOS/CodaIOS/MobilePluginView.swift`）**：

- `verticalSizeClass` 为 compact 时算横屏：导航栏和状态栏隐藏，页面四边都不留安全区；否则只有底边不留。
- 页面的 WebView 自身不滚动，滚动由页面里的元素负责。

**界面原则（Coda `docs/ui-principles.md`）**：打开文件进入下一层，用左上返回和边缘侧滑；关键操作不能只靠长按才发现。

**没有实测，要在 iPhone 上验证**：

- WKWebView 上长按的指针事件，以及和滚动、系统选择菜单的关系。
- 横屏媒体查询能否和 `verticalSizeClass` 对上。
- 安全区的实际数值。
- 返回后 `getState` 能否恢复。Mac 切标签已验证，iPhone 卸载后还没测。

## 4. 数据链路

| 量 | 入口 | 经过 | 消费方 | 核实 |
|---|---|---|---|---|
| 文件视图的会话和路径 | 树页 `coda.open({ view: 'file', args: { session, path } })` | `view.context.args`；页面 `coda.args` | 模块取会话，页面取路径 | 实测（spike） |
| 文件视图的根目录 | 同树页：`threads/<id>` | `lib/root.mjs` → `session`、`root` | 文件页 | 代码复用 |
| 文件视图的刷新 | `coda.watch('threads')` 一轮结束 | 模块推 `changed` | 文件页 `preview.refresh()` | 代码复用 |
| 平台 | `coda.platform` | `app.mjs` | 决定打开文件的方式、工具条 | 实测 |
| 横屏 | CSS 媒体查询 | `style.css` | 显示页内返回、留安全区 | **未实测** |
| 长按 | 指针事件 | `tree.mjs` | 复制路径的菜单 | **未实测** |
| 树的展开和滚动 | `setState` / `getState` | 卸载后重新打开 | 树页 | Mac 已验证，iPhone **未实测** |

## 5. 结构变化

```text
package.json            加视图 file（无 in，只由 coda.open 打开），版本 0.2.0
main.mjs                会话来源改为「args.session，否则 context.session」；注册 file 视图
view/file.html          文件视图入口
view/file-app.mjs       文件视图：连接模块，打开 args.path
view/connection.mjs     新增：hello 握手、超时、消息分发，树页和文件页共用
view/app.mjs            改用 connection；iPhone 上打开文件走 coda.open
view/tree.mjs           长按；已加载目录的刷新失败行
view/preview.mjs        头部可加额外按钮（Mac「窗口」）
view/style.css          iPhone 尺寸、安全区、横屏返回
```

`connection.mjs` 的理由：握手、超时和按代次分发消息是一套规则，两个页面各写一份就有了第二个事实来源。

## 6. 模块

`serve()` 不再直接读 `view.context.session`，改成从上下文算出会话：

```text
会话 = context.args?.session（字符串）?? context.session ?? null
```

- 树视图的 `args` 是 `null`，行为不变。
- 文件视图的会话只来自 `args`。`onContext` 收到不同的 `args.session` 时照常换会话、加代次。
- 根目录查询、轮询、`watch`、路径校验都不变。页面只能读这个会话工作目录里的内容。

## 7. 文件视图

- 启动：连接模块，`root` 为 `ready` 时打开 `coda.args.path`。
- `changed`、工具条刷新：`preview.refresh()`。
- `root` 变化：路径变了用 `preview.reload()`；不是 `ready` 时显示和树页相同的说明，回到 `ready` 再打开。
- `coda.on('context')`：换成新的路径。Mac 上不同 `args` 会换新窗口，通常用不到；iPhone 每次推新的一层，也通常用不到。保留是因为契约写了「`coda.args` 只是启动值」。
- 滚动位置用 `setState` 保存。`setState` 按视图和 `args` 隔离，每个文件自然分开。
- 文件名可能很长，页面顶部截断显示。视图标题固定是「文件」，因为页面改不了导航栏标题。

## 8. Mac

- 侧栏内预览不变。预览头部加「窗口」按钮，调用 `coda.open({ view: 'file', args: { session, path } })`。
- Mac 上同一个视图只有一个窗口；打开别的文件时，客户端会在原位置换成新窗口。这符合「读一个文件」的用法，不做多窗口。
- 拖动、右键菜单不变。

## 9. iPhone

**打开文件**：`coda.platform === 'ios'` 时，点文件调 `coda.open`，树页不进入预览模式。`selected` 只用来高亮刚打开的文件。`coda.open` 失败时在原地提示。

**尺寸**（`.coda-ios` 下）：

- 行高 44 点，缩进和左右留白加大。字号沿用 `--coda-font-size`（17）。
- 工具条按钮至少 44 点。
- 悬停样式放进 `@media (hover: hover)`，否则触摸后会一直留着。

**安全区和横屏**：

- 左右和顶部按 `env(safe-area-inset-*)` 留白，底部一期已有。
- 横屏判断用 `@media (orientation: landscape) and (max-height: 500px)`，近似客户端的 `verticalSizeClass` 判断。
- 横屏时工具条多一个「返回」，调用 `coda.close()`。竖屏不显示，用系统返回。
- 这个判断有偏差时（比如显示了多余的返回），只是多一个按钮，不会走不了。

**长按**：

- 触摸按住 500 毫秒没有明显移动，就打开菜单；移动超过 10 点、抬起或取消都作废。触发后吞掉紧接着的点击。
- 只作用于树的行。行上关闭系统的长按菜单（`-webkit-touch-callout: none`）；文件正文不关，要能选中复制。
- 菜单里写完整的相对路径（iPhone 没有 `title` 悬停，这是看全长文件名的地方），按钮至少 44 点。
- iPhone 上行不设 `draggable`。
- 目录的路径只能长按复制。这不算关键操作，所以不再加可见按钮。

**工具条**：一期已有页内退化版，这里改好尺寸。文件页也用同一种工具条，放刷新和横屏返回；「复制路径」在预览头部。

## 10. 一期留下的小问题

- **目录刷新失败**：已加载的目录刷新失败时，`visibleRows` 在它的子项最上方加一行「更新失败：原因」，可点重试，旧条目保留。根目录和子目录是同一条规则。这也解决了 iPhone 上看不到 `title`、不知道 `!` 是什么的问题。
- **启动超时**：超时的结束条件从收到 `session` 改成收到首个 `root`。
- **重试按钮焦点**：说明区重画后，焦点不能丢到页面外。

## 11. 不做

- iPad、Duo 的专门布局。宽屏下页面照常铺开，不做分栏。
- 写草稿、文件操作、三期的各项功能。

## 12. 验收

- `$CODA_NODE --test test/*.test.mjs`，新增覆盖：
  - 模块：`file` 视图从 `args` 取会话；没有 `args` 时行为不变；`args.session` 变化时换会话。
  - 页面：`platform` 为 `ios` 时打开文件走 `coda.open`，不进预览模式；Mac 上「窗口」按钮的 `args`。
  - 文件页：启动打开文件、`changed` 刷新、`root` 各种状态、切换后的迟到块。
  - 长按：按住触发、移动作废、触发后不再触发点击。
  - 目录刷新失败行：根目录和子目录都有，重试后消失。
  - 启动超时：收到 `session` 但没收到 `root` 时也提示。
- 通过 `@coda-console/plugin-check` 契约检查。
- harness 支持 `ios` 平台和 420×790、844×390 两种尺寸，无头 Chrome 截图看布局。这替代不了真机。
- 作者在 iPhone 上实测第 1 节各条和第 3 节未实测的项；在 Mac 上试「窗口」按钮。没有验证的部分如实写明。
