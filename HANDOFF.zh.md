# dsh-jev-mode 开发交接

核对日期：2026-11-20（Asia/Shanghai）。本文件是后续 AI 的入口；先核对实时 Git 与桌面版本，再决定操作。

## 当前目录与 Git

- **主仓库：`E:\SOME_SEVEN_PROJECT-57\dsh-jev-mode`**。源码、完整 `.git`、本地分支、标签、远端和一个实验 stash 已复制并校验；不是浅克隆或只拷贝发布包。
- 远端：`https://github.com/QI-seven33/dsh-jev-mode.git`。迁移起点/公开 0.4.6 提交为 `6b45308`。
- 当前分支 main，本地新增一个 0.4.7 / rc.5 兼容与交接提交，尚未推送、没有创建 v0.4.7 标签或 Release。完整提交号见 `git log` 和 `.local/final-state.json`。GitHub main 于核对时仍是 `6b45308`。
- 公开 [v0.4.6](https://github.com/QI-seven33/dsh-jev-mode/releases/tag/v0.4.6) 已发布，支持 Desktop 0.2.2-rc.3。[社区 PR #16291](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16291) 已合并；不要重复提交。
- 原仓库 `E:\Codex\Workspace\dsh-jev-mode-release`、原桌面安装目录 `E:\SOME_SEVEN_PROJECT-57\dph_workspace\dsh-jev-mode` 都保留。新工作在主仓库进行，原路径不作为后续开发入口。

## 本次新版兼容结论

本机实际程序为 `E:\Deepseek-Harness\dsh-desktop\DeepSeek Harness.exe`。实际 ASAR 内的 Desktop/runtime 均为 **0.2.2-rc.5**，Electron 44.7.0、Node 24.21.0。

0.4.6 的 `engines.dsh` 精确固定 rc.3，无法直接作为 rc.5 的受支持安装。基线测试确认标准预设和原生导出检查通过，失败点是版本声明。rc.3 与 rc.5 的原生标准预设字节相同。

本地 **0.4.7 候选**精确声明 rc.5，更新版本常量与补丁注释。没有更改决策实现、模型、阈值、权限、主模型协议或网络策略。另补充了可重用的 `tools/` 检查工具及私有资料忽略规则。

| 检查 | 结果和边界 |
| --- | --- |
| 完整 npm test | 40 项 node:test 全通过、零跳过；原生持久化、读取、取消、权限、DeepSeek 合成适配器等套件通过 |
| 真实 Electron/ASAR | 新 rc.5、外置目录联接、默认 host-anchor 加载器通过；没有用假的 loadProxy 替代 |
| 原生能力 | 标准 40 个工具 schema 完整相同；JEV 合计 43 个；原生 read 成功读取主项目 package.json |
| 本地代理控制流 | 两个本地合成 HTTP 请求；原生 jev_status 返回 0.4.7，jev_decide authorize 返回假端点预设的 deny |
| 有界真实检查 | 单个真实 authorize 请求，零重试，jev-1.13.0 返回有效 Noul 0.04、559ms，符合合成的禁止发布指令 |
| 代理与凭据 | 真实检查前后规则模式、TUN 关闭；无代理环境覆盖，使用默认加载器和宿主只读凭据服务；未复制或修改密钥 |
| 交互式桌面 | 没有强制重启用户桌面；更新后完整重启、新会话与 UI 验收仍需用户完成 |

这里的真实检查只证明当前链路的一次有效返回，不是五通道重新评估、长期稳定性或误判率评测。先前 0.4.6 的五通道真实检查与两条公开安装路径已通过，详见 VALIDATION；那些结果不能冒充本次 rc.5 的完整交互验收。

初轮测试因编码检查误扫描 `.local` 中的第三方宿主库而失败；已让两项源码扫描一致忽略 Git 已忽略的私有资料，之后全套通过。没有放宽产品源文件检查。早期失败日志保留。

## 桌面安装与立即下一步

宿主 profile：`C:\Users\sevan\.dsh\profiles\desktop`。本轮通过**新版原生 PluginManager**安装 `link:E:/SOME_SEVEN_PROJECT-57/dsh-jev-mode`，同时更新依赖、lockfile 和目录联接；没有只改一个易被重装覆盖的 junction。其他 manifest 字段与插件启用列表保持不变，没有改凭据或 Clash。

用户保存当前任务后，完全退出 Harness，重新打开并新建 JEV 会话。先只调用 jev_status 确认 0.4.7，再做一次普通项目读取；按需做合成决策诊断，不执行真实危险动作作为测试。旧进程缓存不代表磁盘上的当前代码。

旧 manifest/lockfile 备份在 `.local/profile-link-backup-2026-11-20/`，安装核对在 `.local/desktop-link.json`。如需退回原安装位置，优先使用宿主原生安装器重装原 link，并选用支持对应宿主的插件版本；不要直接覆盖整个个人 profile 或恢复旧凭据。

## 项目真实定位与固定边界

目标已从探索转为维护。多轮实验没有证明 JEV 在普通 Agent 任务中稳定提速。有效的窄场景收益主要来自代码确定性读取/执行，不是 JEV 判断。不要为追求收益恢复普通对话、技能选择、通用预读或新 JEV 模式研究。

- 保持标准能力、主模型配置、历史推理与缓存前缀；禁止动态改动工具目录或把辅助模型替代原生权限。
- 固定 `jev-1.13.0`，授权 Noul 0.85/0.55，`gateAtRisk: 2`；语义读取保留现有 0.9 门槛，不凭个别概率调参。
- 后端不可用时语义选择回退；授权升级审批或拒绝。原生拒绝不能由 JEV 放行。
- 分类器存在 `npm --prefix subproject publish`、`git -C subproject push` 等漏检。真实误放行/误拦率未评测；不宣称提升安全准确性。
- Windows 手动 HTTP(S) 系统代理支持规则模式，不要求全局或 TUN。PAC/WPAD、仅 SOCKS 系统代理不支持。不在代理失败后改成直连。
- `/jev-json-set` 事务实验没有启用或打包。Git stash 与历史归档只保留，不自动恢复。

关键旧教训：0.4.5 曾从外置插件目录裸导入宿主代理库而失败。0.4.6 起使用**宿主注入的 profileContext.installAnchor**解析公开导出。普通复制 profile、只验证版本号或注入替代加载器，均不能证明桌面部署成功。

## 文件与证据地图

- `index.js`：版本、工具注册、运行时注入、闸门绑定。
- `cordis.patch.yml`：标准能力组合加一行 JEV；新版宿主须逐项比较原生 standard。
- `lib/host-proxy.js`、`lib/http-network.js`：公开宿主模块解析、局部 dispatcher、系统代理和取消；不猜测产品 ASAR 路径。
- `lib/native-tools.js`、`lib/session-cwd.js`：批量工具契约和宿主记录的当前目录；不在不确定执行后换路径重试。
- `lib/gate.js`、`lib/engine.js`、`lib/ledger.js`：硬规则/授权、传输与降级、元数据台账。
- `.local/migration.json`：仓库 354 文件初始逐字节核验、Git/stash 保留。
- `.local/history/legacy-evidence.zip` 与 `manifest.json`：4,668 个历史代码/报告/实验资料归档。排除依赖缓存、宿主提取、隔离 profile、凭据文档、环境文件和运行数据库；原始目录仍保留。
- `.local/compat-2026-11-20/host.json`：当前真实宿主版本、构建及 ASAR 校验。
- `.local/check-20261120-200936/`：通过的真实宿主检查和完整 tests.log；更早 check 目录记录测试装配失败。
- `.local/compat-2026-11-20/live-result.json`：本次单次真实请求的无密钥结果。
- `.local/remote-status-2026-11-20.json`：远端 main、公开 Release、社区 PR 实时核对。

`.local/` 为本机私有材料，不纳入 Git 或发布包，不自动读取其中原始实验会话。保留代码与历史不等于研究重新获授权。台账不保存命令、理由或凭据正文；不能从历史对话提取密钥。

## 复核命令

以下在主仓库执行；机器路径变化时替换可执行文件参数。检查工具不会自动调用真实模型或操作当前桌面。

```powershell
Set-Location E:\SOME_SEVEN_PROJECT-57\dsh-jev-mode
git status --short --branch
git log -3 --oneline
git stash list

& E:\Python\python.exe tools\check-desktop.py `
  --desktop 'E:\Deepseek-Harness\dsh-desktop\DeepSeek Harness.exe' `
  --host-node-modules '.local\compat-2026-11-20\host\dsh\node_modules' `
  --node E:\Vue\nodejs\node.exe --full
```

宿主再次更新时，先用下列工具提取**当前**程序，并使用它输出的 hostNodeModules 参数，不能沿用旧提取目录。新宿主有版本不匹配应先审查，不使用兼容性豁免强行运行。

```powershell
& E:\Python\python.exe tools\extract-host.py `
  --desktop 'E:\Deepseek-Harness\dsh-desktop\DeepSeek Harness.exe'
```

原生套件需要 Node 24。检查脚本先核对 Electron RunAsNode fuse，避免误开 UI；只使用隔离 profile、本地假代理和合成密钥。输出落在忽略的 `.local/check-*/`。`tools/` 是开发工具，不是运行时依赖。

## 后续提交和发布

本轮只迁移、适配、验收、做本地提交并交接，**没有公开发布 0.4.7**。先按用户新要求决定是否继续修改、推送或发布。届时阅读 RELEASING：审阅文件生成干净快照、扫描、对准确产物测试，再提交/打标、上传、验两条公开安装路径。不得覆盖已发布资产、混入 `.local`、推送 stash 或直接重跑带旧提交号的历史发布脚本。新版本社区目录更新先查现有 PR 状态。
