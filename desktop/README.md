# 小鲸求职助手桌面版 / Xiaojing Desktop

**[禁止售卖]** 小鲸官方版本免费下载。禁止第三方转售小鲸、冒充官方或以官方名义收费。源码采用 Commons Clause 1.0 附加销售限制的源码可用许可。第三方使用、修改和分发权利以项目的 [完整许可条款](https://github.com/ilovemiku520/xiaojing-job-assistant/blob/main/LICENSE)为准。

**[No resale]** Official Xiaojing downloads are free. Third-party resale, impersonation, and charges presented as official are prohibited. The project uses a source-available license with the Commons Clause 1.0 sales restriction. Third-party use, modification, and distribution are governed by the project’s [complete license terms](https://github.com/ilovemiku520/xiaojing-job-assistant/blob/main/LICENSE).

小鲸是桌面端 AI 求职自动化平台，目前支持 BOSS 直聘。便携版和 SHA-256 见 [GitHub Releases](https://github.com/ilovemiku520/xiaojing-job-assistant/releases)。Windows 可执行文件当前未附代码签名。

Xiaojing is a desktop AI job-search automation platform for BOSS Zhipin. Find portable builds and their SHA-256 hashes in [GitHub Releases](https://github.com/ilovemiku520/xiaojing-job-assistant/releases). The Windows executable is currently unsigned.

解压 Windows x64 便携包，双击 `Xiaojing.exe`。首次打开会创建空白资料库。程序配置、知识库、简历和运行记录保存在当前 Windows 账户的 `%APPDATA%\Xiaojing Desktop\profile`，和旧版工程分开。桌面版使用 17322 端口，旧版本地服务使用 17321。

Extract the Windows x64 portable package and open `Xiaojing.exe`. The first launch creates an empty profile under `%APPDATA%\Xiaojing Desktop\profile`. The desktop app uses port 17322, and the original local service uses 17321.

升级时可把新版解压到单独的目录。关闭当前桌面版后，打开新版 `Xiaojing.exe`，程序会继续使用同一个本机资料目录。

Extract upgrades to a separate folder. Close the current desktop app, then open the new `Xiaojing.exe` to continue using the same local data directory.

## 首次设置 / First setup

点击左上角或内置浏览器工具栏的齿轮打开设置栏。控制台与内置浏览器都可用 `Ctrl+,` 打开。外部 Chrome／Edge 配置位于「浏览器」。点击设置栏右上角的收起图标，或在设置栏内按 `Esc` 返回。

Open Settings from the upper-left gear or the gear in the embedded browser toolbar. `Ctrl+,` works in the console and the embedded browser. External Chrome and Edge setup is under Browser. Use the upper-right collapse icon or press `Esc` while in Settings.

1. 在「求职资料」填写岗位方向、城市和薪资，并按需修改经验年限、校招范围、资深岗位与排除词。到「人格与资料库」设置口吻和规则，导入 PDF 简历及 TXT、Markdown 或 JSON 知识文件。可打开本机资料目录查看文件。批量导入会分别报告新增、重复和需处理的资料。在 BOSS 配置账号的站内附件，并在求职资料中核对附件名称。
2. 到「模型与联网」保存各厂商 API 密钥。为对话、自主规划、岗位分析与招呼、HR 回复、主动跟进、学习整理指定模型。Windows 用当前账户加密 API 密钥。模型连接测试使用示例输入。
3. 到「内置浏览器」选「打开内置浏览器」。首次在内置页面登录，浏览器状态显示桥接进度。先用审核模式核对会话识别和发送结果，再按需开启两个通道。需要外部浏览器时，从同一页设置专用 Chrome 或已安装的 Edge／Chrome。已有会话的工作区在切换桥接方式或出现登录界面后，须确认原账号并重新核对发送。不同账号使用独立资料目录。
4. 「岗位资料库」可按跟进状态筛选并导出 Excel、CSV 或 JSON。跟进状态按岗位链接及实际记录归档，历史沟通和新发送回执分别显示。岗位详情可打开同一职位的已保存 HR 会话。「打开实时 Excel」打开由桌面版更新的 `exports/岗位实时.xlsx`。如果 Excel 正占用文件，桌面版会保留上一次可用的工作簿，在文件解锁后更新。需要手工编辑时，可使用单独导出的副本。
5. 「会话记忆」可按联系人、公司或职位检索已保存的会话。打开单个会话查看历史、职位和发送凭据，按需加载更早消息。作者标记来自发送回执或本人确认。

「求职资料」会显示已选城市的自动搜索覆盖。当前核对了 25 个城市的 BOSS 公开入口。其余已选城市仍可匹配从收藏或手动搜索页面读取的岗位。内置浏览器的网页缩放单独保存，默认自动适配。岗位表会记住筛选、排序、每页数量和导出格式。

外部浏览器配对在本次桌面运行期间有效，刷新控制台后可继续。退出桌面程序后，下次使用外部浏览器时需要重新配对。内置浏览器独立保存登录状态和缩放设置。

1. Set job filters for role, location, salary, required experience, early-career hiring, and seniority. Then set the persona and import a PDF résumé and TXT, Markdown, or JSON knowledge files. The library can open the local data folder and reports added files, duplicates, and files needing attention after a batch. Set the attachment separately in BOSS and verify its name in the app.
2. Add provider keys under Models & Networking and choose a model for each stage. Windows encrypts keys for the current account. Connection tests use sample data.
3. Open the Embedded Browser and sign in to BOSS. Verify the workflow in review mode before enabling automation. The same screen offers external Chrome or Edge setup. Workspaces with existing chats pause automation after a browser bridge change or a detected sign-in screen. Confirm the original account and verify sending before resuming. Use a separate data directory for a different account.
4. In the jobs library, filter by follow-up status and export to Excel, CSV, or JSON. Status is tied to the job link and actual records. Previous chats and new send receipts are tracked separately. A job detail can open saved HR chats linked to the same posting. Open Live Excel opens the app-managed workbook. While Excel has it locked, Xiaojing keeps the last valid file and updates it after the file is unlocked. Export a separate copy for manual editing.
5. In Conversation Memory, search saved chats by contact, company, or job title. Open a conversation to see its history, job, and send receipts. Load older messages on demand. Author labels come from send receipts or owner confirmations.

The job profile shows automatic search coverage for selected cities. Public BOSS entry points have been checked for 25 cities. Other selected cities can still match jobs collected from favorites or manual searches. The embedded browser saves its own zoom level and defaults to automatic fit. The jobs table remembers filters, sorting, page size, and export format.

External browser pairing survives a console refresh and lasts for the current app session. Pair again after restarting the desktop app to use an external browser. The embedded browser stores its own sign-in state and zoom settings.

## MCP 与联网 / MCP and networking

- 在「MCP 工具」复制本地 MCP 客户端配置。默认只读，可查看状态、岗位候选、分页岗位表和任务摘要。`boss_jobs_table` 支持岗位筛选、跟进状态和排序。勾选允许控制后，可分别切换自主求职和 HR 回复。接入期间保持桌面程序运行。
- 小鲸可添加本地 stdio MCP 工具。自定义工具默认仅对话可用。使用任意已添加的 MCP 工具时，将对应阶段设为 DeepSeek Harness，并在电脑上安装 Harness。
- 可以启用随程序提供的「公开网页读取」工具。对话可读取本轮提供的公开 HTTPS 链接。外部模型的自主规划以分析和计划为主，BOSS 的执行仍交给业务队列和浏览器扩展。

- Copy the local MCP client configuration from MCP Tools. Read-only clients can view status, job candidates, paged job metadata, and task summaries. `boss_jobs_table` supports job filters, follow-up status, and sorting. With control enabled, the client can toggle the two channels independently.
- Add local stdio tools for DeepSeek Harness turns. Custom tools are available in Chat by default. Install Harness separately to use these tools in routed stages.
- Enable the bundled public webpage reader to read a public HTTPS link supplied in the current Chat message. The embedded bridge or external browser extension handles authenticated BOSS pages and checks send receipts.

作者 / Author [ilovemiku520](https://github.com/ilovemiku520)

完整部署与构建说明 / Full deployment and build guide [README](https://github.com/ilovemiku520/xiaojing-job-assistant#readme)

问题反馈与贡献 / Feedback and contributions [Issues](https://github.com/ilovemiku520/xiaojing-job-assistant/issues) · [Pull requests](https://github.com/ilovemiku520/xiaojing-job-assistant/pulls)
