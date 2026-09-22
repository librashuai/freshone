# freshone

自用的 [Fresh Editor](https://getfresh.dev/) 插件集合。

## Find in Buffer Bottom Bar

Fresh 0.5.1 的插件 API 不能向原生 `Ctrl+F` prompt 添加按钮，因此插件提供了新的 **`Find in Buffer (Bottom Bar)`** 命令。它会在共享的 **Utility Dock** 中打开搜索栏，与 Search/Replace、Diagnostics、Quickfix 等工具复用同一个底部区域：

- 输入内容时实时搜索当前 Buffer，并高亮全部匹配；
- 搜索栏显示“当前序号/总数量”；
- 可点击 `↑`、`↓` 切换匹配，点击 `×` 退出；
- 搜索栏只占一行，不再显示上一个、下一个和关闭操作的第二行提示文字；
- 点击 **All Results** 后，Utility Dock 展开为当前文件的完整结果列表；
- 每行显示行列号和源代码，匹配文本会高亮；
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

## LSP Find References Pinned

命令面板中执行 **`LSP Find References Pinned`**：

1. 调用 Fresh 原生的 `lsp_references` 动作；
2. 在当前代码窗口下方建立常驻结果 Buffer；
3. 左侧按“文件名:行号”列出引用，右侧直接显示所选引用的代码上下文；
4. 结果区底部显示当前文件相对于项目根目录的完整路径；
5. 右侧上下文行数会随结果窗口高度自动调整，并保留目标行居中；
6. 打开引用文件时复用原来的上方代码 pane，结果窗口不会关闭；
7. 只有结果 tab 的 `×` 和结果窗口内的 `q` 会关闭整个结果窗口。

插件会停用 Fresh 自带的 prompt 式 `find_references` 展示插件，但不会停用 Fresh 核心的 LSP 查找引用动作。因此原有“查找引用”菜单/快捷键也会显示为常驻结果 Buffer。

### 操作

| 操作 | 效果 |
|---|---|
| 鼠标单击左侧 / `↑`、`↓` | 选择引用并刷新右侧上下文 |
| `Ctrl+鼠标左键` | 在上方代码 pane 打开所选文件并定位到引用行 |
| `Shift+鼠标左键` | Fresh 0.5.1 的可靠兼容操作，效果同上 |
| 鼠标单击右侧代码 | Fresh 0.5.1 下打开所选引用（见下面说明） |
| `q` / tab 上的 `×` | 关闭整个常驻结果窗口 |

> **Fresh 0.5.1 限制：** 该版本的 `mouse_click.modifiers` 实际只向插件报告 Shift，Ctrl 会被丢弃。因此插件同时提供 `Shift+Click`，并让右侧代码区的单击直接打开引用；用户按住 Ctrl 点击右侧代码仍能得到要求的行为。代码已经识别 `ctrl`/`control`，Fresh 后续版本一旦正确上报 Ctrl，无需修改插件即可使用精确的 Ctrl+Click。

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
- LSP Find References 需要为当前语言配置并启动 LSP
- 引用文件位于 Fresh 的当前 workspace 中（项目相对路径以 `editor.getCwd()` 为根）
