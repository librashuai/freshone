# freshone

自用的 [Fresh Editor](https://getfresh.dev/) 插件集合。

## Find in Buffer

Fresh 0.5.1 的插件 API 不能向原生 `Ctrl+F` prompt 添加按钮，因此插件提供了新的 **`Find in Buffer`** 命令。它会在共享的 **Utility Dock** 中打开搜索栏，与 Search/Replace、Diagnostics、Quickfix 等工具复用同一个底部区域：

- 输入内容时实时搜索当前 Buffer，并高亮全部匹配；
- 搜索栏显示“当前序号/总数量”；
- 可点击 `↑`、`↓` 切换匹配，点击 `×` 退出；
- 搜索栏只占一行，不再显示上一个、下一个和关闭操作的第二行提示文字；
- 点击 **All Results** 后，Utility Dock 展开为当前文件的完整结果列表；
- 每行显示行号和源代码（不显示列号），匹配文本会高亮；
- 单击结果行会在上方原始 Buffer 跳转，结果列表保持打开；
- 原始 Buffer 修改后，结果会自动刷新；
- 只有结果 tab 的 `×`、搜索栏的 `×`，或搜索区域聚焦时的 `Esc` / `Ctrl+Q` 会关闭整个搜索区域。

如果开始搜索前选中了单行文本，该文本会自动作为初始搜索内容。搜索按字面量、不区分大小写。

如需让它替代原生 `Ctrl+F`，在 Fresh 的 `config.json` 顶层加入以下绑定（自定义绑定会覆盖内置绑定）：

```json
{
  "keybindings": [
    {
      "key": "f",
      "modifiers": ["ctrl"],
      "action": "freshone_buffer_search_start",
      "when": "normal"
    }
  ]
}
```

也可以通过 **Show Keyboard Shortcuts** 为 `freshone_buffer_search_start` 配置其他按键。

## Find in Files

命令面板中执行 **`Find in Files`**，会在共享的 Utility Dock 中搜索整个项目的文件内容：

- 使用系统安装的 [`fd`](https://github.com/sharkdp/fd) 枚举项目文件，并遵守 `fd` 默认的 `.gitignore`/隐藏文件规则；
- 未安装 `fd` 时会显示安装提示和项目地址；
- 顶部固定显示搜索输入框、紧凑的扫描进度/匹配数量、**Search** 按钮和关闭按钮；
- Matches 和 Context 区域会撑满剩余面板空间，并且可以独立滚动；
- Matches 使用两级树：一级为文件名及匹配数量，二级只显示该文件中的匹配行内容（不显示行列号）；点击文件名前的箭头或文件名整行可展开/折叠；
- Context 上边界显示所选文件的项目相对路径，空间不足时路径中间以 `...` 省略；
- 单击 Matches 结果只会选择并刷新 Context，不会移动上方代码 pane；
- 双击 Context 中的任意代码行会在上方代码 pane 打开文件并定位；
- `Esc`、`Ctrl+Q`、关闭按钮或结果 tab 的 `×` 会退出搜索。

搜索按字面量、不区分大小写；单个文件最大扫描 10 MiB，结果最多保留 10000 条。

## LSP Find References Dock

命令面板中执行 **`LSP Find References Dock`**：

1. 直接向当前语言的 LSP 发送 `textDocument/references` 请求；
2. 在共享的 **Utility Dock** 中打开插件自己的 References/Context 双栏面板；
3. 左侧 References 使用两级树：一级为文件名及引用数量，二级为引用行内容；文件节点可展开/折叠，选择引用后右侧显示目标行附近的源码并高亮引用范围，Context 上边界同时显示文件的项目相对路径，空间不足时路径中间以 `...` 省略；
4. 双击右侧源码或选中左侧引用后按 `Enter`，会在原代码 pane 中打开目标；
5. `Esc`、`Ctrl+Q`、关闭按钮或结果 tab 的 `×` 会关闭面板。

自定义命令不触发 Fresh 的 `lsp_references` 结果事件，也不会卸载或修改内置的 `find_references` 插件。因此原有的 LSP Find References 菜单和快捷键仍使用 Fresh 自带的结果界面，只有 **`LSP Find References Dock`** 使用本插件的 Utility Dock Panel。

## 安装（Windows / winget 版 Fresh）

在 PowerShell 中进入本仓库：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

脚本会：

- 从 `PATH` 查找 winget 安装的 `fresh.exe`；
- 检查 Fresh 版本和插件 TypeScript；
- 通过 `fresh --cmd config paths` 获取真实配置目录；
- 原子部署到 `plugins/packages/freshone`。

Fresh 已运行时需要重启。也可以让脚本自动重启：

```powershell
.\install.ps1 -RestartFresh
```

卸载：

```powershell
.\install.ps1 -Uninstall
# 卸载并重启
.\install.ps1 -Uninstall -RestartFresh
```

## 要求

- Fresh Editor 0.5.1 或更高版本
- Find in Buffer 可用于普通文本 Buffer
- Find in Files 需要系统 `PATH` 中可用的 `fd`
- LSP Find References 需要为当前语言配置并启动 LSP
- 引用文件位于 Fresh 的当前 workspace 中（项目相对路径以 `editor.getCwd()` 为根）
