# 小鲸求职助手 / Xiaojing Job Assistant

**[禁止售卖]** 小鲸官方版本免费下载。禁止第三方转售小鲸、冒充官方或以官方名义收费。源码采用 Commons Clause 1.0 附加销售限制的源码可用许可。第三方使用、修改和分发权利以 [完整许可条款](LICENSE)为准。

**[No resale]** Official Xiaojing downloads are free. Third-party resale, impersonation, and charges presented as official are prohibited. The project uses a source-available license with the Commons Clause 1.0 sales restriction. Third-party use, modification, and distribution are governed by the [complete license terms](LICENSE).

小鲸是桌面端 AI 求职自动化平台，目前支持 BOSS 直聘。它通过内置浏览器或配对的 Chrome／Edge 扩展读取岗位和会话。你可以设置求职条件，让小鲸查找和筛选岗位、起草招呼、处理 HR 消息及站内简历请求，并查看每项操作的状态。

Xiaojing is a desktop AI job-search automation platform for BOSS Zhipin. It reads job listings and conversations through an embedded browser or a paired Chrome or Edge extension. Set your criteria to find and screen roles, draft greetings, handle recruiter messages and résumé requests, and track outcomes.

## Windows 便携版 / Windows portable build

**v1.0.0** 是小鲸的首个正式版。 **v1.0.0** is Xiaojing’s first stable release.

1. 在 [GitHub Releases](https://github.com/ilovemiku520/xiaojing-job-assistant/releases) 下载 Windows x64 便携 ZIP，把整个压缩包解压到单独目录。
2. 在解压目录双击 `Xiaojing.exe`。保留同目录的 `resources`、运行库和许可证文件。桌面服务使用本机回环地址，默认端口为 `17322`。
3. 首次打开会创建空白资料库，两个自动运行通道保持关闭。升级时，先退出旧程序，再从新解压目录启动。默认资料目录会继续使用原来的本机资料。

1. Download the Windows x64 portable ZIP from [GitHub Releases](https://github.com/ilovemiku520/xiaojing-job-assistant/releases) and extract the entire archive to a separate folder.
2. Open `Xiaojing.exe` in that folder. Keep the `resources`, runtime, and license files alongside it. The desktop service listens on loopback port `17322` by default.
3. A new profile starts empty with both automation channels off. To upgrade, exit the running app and launch the new copy from its own folder. The default profile location is reused.

Windows 便携版当前未附代码签名。可使用 Release 提供的 SHA-256 核对下载文件。The portable executable is currently unsigned. Verify the downloaded ZIP against the SHA-256 published on its release page.

```powershell
Get-FileHash .\Xiaojing-Desktop-*-Windows-x64*.zip -Algorithm SHA256
```

## 首次配置和运行 / First-run setup

设置入口在左上角及内置浏览器工具栏的齿轮。也可以使用 `Ctrl+,`，在设置栏内按 `Esc` 收起。

Open Settings with the upper-left gear or the gear in the embedded browser toolbar. `Ctrl+,` opens Settings, and `Esc` closes it while the drawer has focus.

| 步骤 | 操作 |
| --- | --- |
| 1. 求职资料 | 填写姓名、目标岗位、城市和可引用经历。按需要设置薪资、经验、校招范围、资深岗位和排除词。自动搜索入口的覆盖情况会在该页显示。 |
| 2. 人格与资料库 | 在对应编辑框中填写规则，或选择、拖入 TXT、Markdown、JSON 文本。检查内容后保存。资料库支持 PDF 简历和可检索的知识文件。 |
| 3. 模型与联网 | 选择提供商，保存 API 密钥和模型名称，再运行模型连接测试。可为对话、自主规划、岗位分析与招呼、HR 回复、主动跟进和学习整理分别指定模型。 |
| 4. 内置浏览器 | 进入「内置浏览器」，打开 BOSS 并登录。通过工具栏在岗位、收藏和对话之间切换。浏览器状态会显示是否已连接。 |
| 5. 运行设置 | 初次连接使用审核模式。核对目标会话、草稿和站内回执，再在工作台开启需要的通道。自主求职与 HR 实时回复可分别运行。 |
| 6. 附件简历 | 在 BOSS 账号上传要发送的站内附件，再到小鲸的「求职资料」核对附件名称。小鲸资料库里的 PDF 用于本机资料管理，BOSS 发送使用账号上的站内附件。 |

| Step | Action |
| --- | --- |
| 1. Job Profile | Enter your name, target roles, cities, and experience the assistant can cite. Optionally configure salary, experience, early-career and seniority filters, and exclusions. The page shows which selected cities support automatic search. |
| 2. Persona & Library | Enter rules in the editor, or select or drop a TXT, Markdown, or JSON file. Review the text and save. The library also accepts a PDF résumé and searchable knowledge documents. |
| 3. Models & Networking | Select a provider, save your API key and model name, and test the connection. You can assign separate models to chat, planning, job screening and greetings, recruiter replies, follow-ups, and learning. |
| 4. Embedded Browser | Open BOSS in the embedded browser and sign in. Switch between jobs, favorites, and conversations from the toolbar. Check the connection status before enabling automation. |
| 5. Run Settings | Start in review mode. Check the target conversation, draft, and on-site receipt before enabling the channels you need. Job Search and HR Live Reply can run independently. |
| 6. Résumé attachment | Upload your résumé in your BOSS account and verify the attachment name in Job Profile. The local library stores your PDF, while sending uses the attachment in your BOSS account. |

模型配置支持 DeepSeek API、OpenAI API、Anthropic API、Gemini API、阿里云百炼及 OpenAI 兼容 API。填写服务商提供的模型 ID。选择 DeepSeek Harness 的阶段需要另外安装 Harness，并确保小鲸能找到它。连接测试使用示例输入。

Supported providers include DeepSeek, OpenAI, Anthropic, Gemini, Alibaba Cloud Model Studio, and OpenAI-compatible endpoints. Use the model ID assigned by your provider. Install DeepSeek Harness separately for any stage routed to it. Connection checks use sample input.

### 外部浏览器 / External browser

在设置栏选择「浏览器」，可安装独立的 Chrome for Testing，也可设置已安装的 Chrome 或 Edge。按界面提示加载求职助手扩展、登录 BOSS 并配对，回到小鲸确认已连接。使用同一工作区切换浏览器时，核对 BOSS 账号再恢复运行。桌面程序退出后，外部浏览器下次需要重新配对。

In Settings → Browser, set up an isolated Chrome for Testing installation or use an installed Chrome or Edge. Follow the prompts to load the assistant extension, sign in, and pair. Check the BOSS account when switching browsers in the same workspace. Pair an external browser again after restarting the desktop app.

### 任务与导出 / Tasks and exports

- 在「任务中心」检查草稿、执行状态和回执。「会话记忆」支持按联系人、公司和职位检索历史。
- 「岗位资料库」可按岗位来源、匹配情况或跟进状态筛选，导出当前结果为 Excel、CSV 或 JSON。实时工作簿保存在资料目录的 `exports/岗位实时.xlsx`。关闭占用该文件的 Excel 窗口后，更新会继续写入。
- Use Task Center to inspect drafts, execution status, and receipts. Conversation Memory supports searching by contact, company, or job title.
- Filter job data by source, match, or follow-up status and export the results to Excel, CSV, or JSON. The live workbook is `exports/岗位实时.xlsx` in the profile directory. Updates resume once Excel releases a file lock.

## MCP 接入 / MCP integration

- **外部客户端调用小鲸。** 在「MCP 工具」复制客户端配置，填入 MCP 客户端并保持小鲸运行。默认只能读状态、岗位和任务摘要。启用控制后，客户端可以分别切换自主求职与 HR 回复。
- **小鲸调用本机工具。** 在「MCP 工具」导入或填写 stdio MCP 服务的 JSON 配置。安装 DeepSeek Harness，并将需要使用该工具的阶段设为 Harness。启用的本机工具会以当前账户启动配置中的命令。
- **Connect an external MCP client.** Copy the client configuration from MCP Tools, add it to your client, and keep Xiaojing running. Read-only access is the default. If you enable control, the client can toggle Job Search and HR Live Reply independently.
- **Let Xiaojing call local tools.** Import or enter a stdio MCP server configuration under MCP Tools. Install DeepSeek Harness and select it for the stages that use the tool. Enabled local tools launch their configured commands under the current account.

## 资料目录与备份 / Data and backups

默认桌面资料目录是 `%APPDATA%\Xiaojing Desktop`。其中 `profile` 保存个人资料、知识库、简历、会话、任务和导出，内置浏览器登录状态也保存在此工作区。Windows 上的 API 密钥由当前账户加密。退出程序后可备份资料目录。迁移到不同 Windows 账户时，按新账户重新配置密钥及浏览器登录。

The default desktop workspace is `%APPDATA%\Xiaojing Desktop`. Its `profile` folder stores your profile, knowledge, résumés, conversations, tasks, and exports. The workspace also contains the embedded browser session. Windows encrypts provider keys for the current account. Exit the app before backing up the workspace, and reconfigure keys and browser login when moving to a different Windows account.

可以用 `XIAOJING_DESKTOP_HOME` 指定独立资料目录，用 `XIAOJING_DESKTOP_PORT` 指定回环端口。下面的 PowerShell 命令会在新目录运行。为另一个 BOSS 账号使用独立工作区。

Set `XIAOJING_DESKTOP_HOME` for a separate workspace and `XIAOJING_DESKTOP_PORT` for a different loopback port. The following PowerShell example starts the app with a separate workspace. Use separate workspaces for different BOSS accounts.

```powershell
$env:XIAOJING_DESKTOP_HOME = Join-Path $env:LOCALAPPDATA 'Xiaojing Demo'
$env:XIAOJING_DESKTOP_PORT = '17323'
.\Xiaojing.exe
```

## 从源码构建和部署 / Build and run from source

### 构建 Windows 便携包 / Build the Windows portable ZIP

准备 Windows x64、Git、Node.js 22 或更高版本、Windows 自带的 libarchive `tar.exe`，以及 Windows .NET Framework x64 C# 编译器。构建脚本会检查 `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`。运行已经构建好的便携包时无需单独安装 Node.js。

Build prerequisites are Windows x64, Git, Node.js 22 or newer, the built-in Windows libarchive `tar.exe`, and the Windows .NET Framework x64 C# compiler. The builder looks for `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. The portable build includes its runtime. [Node.js downloads](https://nodejs.org/en/download) · [Electron v45.2.3](https://github.com/electron/electron/releases/tag/v45.2.3)

```powershell
git clone https://github.com/ilovemiku520/xiaojing-job-assistant.git
Set-Location xiaojing-job-assistant
node --version
$runtime = 'electron-v45.2.3-win32-x64.zip'
$archive = Join-Path $PWD $runtime
Invoke-WebRequest "https://github.com/electron/electron/releases/download/v45.2.3/$runtime" -OutFile $archive
node desktop/build.mjs $archive
```

构建脚本在解压前检查官方 Electron ZIP 的 SHA-256 `489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0`。输出目录是 `output/desktop/`。已存在的同名产物需要另行保存，构建脚本会拒绝覆盖。

The builder checks the official Electron ZIP against SHA-256 `489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0` before extraction. Build outputs are written to `output/desktop/`. Move any previous output with the same version to a separate folder before rebuilding.

### 本地网页服务 / Local web service

如果只需要网页控制台，可用 Node.js 启动回环服务，再到浏览器打开 `http://127.0.0.1:17321/`。使用 `BOSS_DATA_DIR` 指定独立资料目录。手动在 Chrome 或 Edge 扩展页加载仓库的 `extension/`，然后按控制台的提示完成配对。此方式使用外部浏览器。

For the web console, start the loopback service and open `http://127.0.0.1:17321/` in a browser. Set `BOSS_DATA_DIR` for a separate data directory. Load `extension/` as an unpacked extension in Chrome or Edge, then follow the console’s pairing instructions. This mode uses an external browser.

```powershell
$env:BOSS_DATA_DIR = Join-Path $env:LOCALAPPDATA 'Xiaojing Web Profile'
$env:BOSS_KNOWLEDGE_DIR = Join-Path $PWD 'desktop/starter'
npm start
```

### 开发验证 / Development checks

核心测试使用 Node.js。桌面和浏览器测试还需要 `tools/node` 的锁定依赖、已构建的便携包和已安装的 Edge。部分测试需要官方 Electron 运行时解压到 `tools/cache/electron/runtime/`。测试资料应使用合成样本。

Core tests use Node.js. Desktop and browser tests also require the locked dependencies under `tools/node`, a built portable package, and an installed copy of Edge. Some fixtures require the official Electron runtime extracted to `tools/cache/electron/runtime/`. Use synthetic profiles for tests.

```powershell
$env:BOSS_KNOWLEDGE_DIR = Join-Path $PWD 'desktop/starter'
New-Item -ItemType Directory -Force .\tools\cache\electron\runtime | Out-Null
tar -xf $archive -C .\tools\cache\electron\runtime
npm ci --prefix tools/node
npm test
npm run test:desktop
```

## 常见问题 / Troubleshooting

| 情况 / Symptom | 处理方法 / What to check |
| --- | --- |
| 无法启动或提示端口占用 / Port in use | 先退出其他实例，或使用 `XIAOJING_DESKTOP_PORT` 指定空闲端口。Close other instances or set a free `XIAOJING_DESKTOP_PORT`. |
| 首次打开显示了以前的资料 / Existing data appears | 应用会沿用当前 Windows 账户的资料目录。用 `XIAOJING_DESKTOP_HOME` 启动新工作区。The app reuses the current account’s workspace. Set `XIAOJING_DESKTOP_HOME` for a new one. |
| 模型测试失败 / Model test fails | 检查服务商、API 密钥、模型 ID 和网络。兼容服务需要正确的 HTTPS 接口地址。Check the provider, API key, model ID, and network. Compatible services require a valid HTTPS endpoint. |
| 未连接 BOSS / BOSS disconnected | 打开内置浏览器确认登录状态。使用外部浏览器时，核对扩展和配对状态。Check the sign-in in the embedded browser, or verify the extension and pairing for an external browser. |
| 草稿已生成但状态待核对 / Send awaiting verification | 在任务中心查看目标和状态，再打开对应 BOSS 对话核对实际回执。Check the target and status in Task Center, then inspect the BOSS conversation for its receipt. |
| 实时 Excel 未更新 / Live Excel not updating | 关闭占用该文件的 Excel 窗口，等待程序更新。Close the workbook in Excel so the app can update it. |

## 反馈和许可证 / Feedback and license

问题反馈请提交 [Issue](https://github.com/ilovemiku520/xiaojing-job-assistant/issues)，贡献代码可提交 [Pull Request](https://github.com/ilovemiku520/xiaojing-job-assistant/pulls)。反馈时提供版本、复现步骤和已遮挡个人信息的截图。作者 [ilovemiku520](https://github.com/ilovemiku520)。

Report issues through [GitHub Issues](https://github.com/ilovemiku520/xiaojing-job-assistant/issues) or submit a [pull request](https://github.com/ilovemiku520/xiaojing-job-assistant/pulls). Include the version, reproduction steps, and screenshots with personal details removed. Author [ilovemiku520](https://github.com/ilovemiku520).

本项目源码在 Apache 2.0 基础条款上附加 Commons Clause 1.0。除转售外，条款也涵盖主要依赖小鲸功能的某些付费产品或服务。完整授权范围见 [LICENSE](LICENSE)。随便携包分发的 Electron 和 Chromium 第三方组件保留各自的许可和声明。

The project uses Apache 2.0 as its base license, subject to Commons Clause 1.0. The restriction also applies to certain paid products or services that derive substantial value from Xiaojing. See the [full terms](LICENSE). Electron and Chromium components distributed with the portable build retain their own license notices.
