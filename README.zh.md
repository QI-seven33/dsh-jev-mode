# DeepSeek Harness JEV 决策模式

[English](README.md) · [发布版本](https://github.com/QI-seven33/dsh-jev-mode/releases) · [验证与限制](VALIDATION.md) · [问题反馈](https://github.com/QI-seven33/dsh-jev-mode/issues)

由 QI-seven33 独立维护的**非官方、可选桌面预设**。基于 DeepSeek Harness Desktop **0.2.0-rc.2** 的标准能力组合，增加有限的项目文件读取和 JEV 授权检查。主模型沿用你的配置，原有标准预设不变。

**尚未证明通用提速或安全准确性提升。** 多轮实验未发现日常 Agent 任务的稳定收益；分类器存在漏检，真实授权误放行率、误拦率尚未测量。

## 安装

在 Harness 桌面版的「插件」页面安装并启用：

```text
github:QI-seven33/dsh-jev-mode#v0.4.4
```

也可在同一入口填写 [固定版本 .tgz 链接](https://github.com/QI-seven33/dsh-jev-mode/releases/download/v0.4.4/dsh-jev-mode-0.4.4.tgz)，或下载后填写绝对本地路径。源码 ZIP 不是插件安装包。

完全退出并重启 Harness，在新会话选择「JEV 决策模式」。打开「设置 → 模型 → JEV 决策模型 → 编辑」，保存自己的 TypeSafe API 密钥。DeepSeek 主模型设置保持原样；状态点只表示已配置，不表示 API 连通。

无需运行时依赖或安装编译步骤。已验证环境为 **Desktop 0.2.0-rc.2、Windows**，其他宿主版本和系统需另行验证。详见 [安装说明](INSTALL.zh.md) 和 [验收步骤](ACCEPTANCE.zh.md)。

## 实际提供的能力

| 请求或操作 | 行为 |
| --- | --- |
| 明确询问根目录 `package.json` 或 `README.md` | 代码选择文件，经原生 read 和权限管线读取；不调用 JEV 选择。 |
| 在上述两个文件之间作取舍的合格短请求 | 有限 JEV 选择；置信度、所选概率均须达到 0.9，否则回退普通规划。 |
| 被分类为风险 2 及以上的操作 | 先执行硬规则，再由 JEV 检查用户授权；原生权限拒绝始终有效。 |
| 普通代码、文档任务 | 标准规划与工具，不自动选技能、不做通用预读，也没有 grounded/sufficient 自动验证闭环。 |

`jev_status` 显示版本和计数。`jev_decide`、`jev_gate` 保留为用户明确要求时使用的诊断工具；诊断结果不是执行许可。

默认固定 **`jev-1.13.0`**。授权使用 **Noul**，阈值保持 **0.85 / 0.55**，`gateAtRisk: 2`。保留主模型历史、推理和工具定义；缓存命中不保证固定比例。

没有 TypeSafe 密钥时：明确读取仍可用，语义读取回退，授权服务不可用时进入审批或拒绝。停止使用时选择标准预设；需要移除插件贡献时，在「插件」页面禁用。

## 0.4.4 的改动

这是**可靠性修复版**：重试等待遵守决策期限，正确处理 `Retry-After`，同一后端实例共享服务端冷却，限制凭据查询等待，并修复辅助请求的取消信号冻结。用户取消不计为服务故障。保留 0.4.3 的紧凑设置卡片和原生编辑弹窗；维护者已反馈该 UI 工作正常。

实验性 `/jev-json-set` 事务插件**不在发布包内**，其窄场景提速不能代表本版收益。具体改动见 [CHANGELOG.md](CHANGELOG.md)，测试、跳过项和测量边界见 [VALIDATION.md](VALIDATION.md)。

## 安全与数据流向

- 闸门补充原生权限，不能替代沙箱或增加权限。`npm --prefix subproject publish`、`git -C subproject push` 等变体可能不触发 JEV；低风险标签不代表安全或已授权。
- 语义检查会向 TypeSafe 发送有界上下文，例如相关请求、用户授权历史和拟执行动作。脱敏并非绝对保证，请勿在提示或命令参数中放入密钥；调用可能另行计费。
- 密钥通过宿主 credentials 服务解析，保存的值不回显给浏览器或模型对话；不附带共享密钥。启动环境提供的密钥为只读，移除已保存密钥后可能恢复原有环境备用来源。
- 本地台账保存元数据和哈希，不保存命令正文、判断理由正文或凭据。

## 设置与界面

默认配置包括 `controlledFlow: true`、`semanticReads: true`、`autoGate: true`、`onGateFailure: escalate`、`statusContext: false`。如不希望歧义读取调用 JEV，可在模式配置中设置 `semanticReads: false`。修改预设配置后重启并新建会话。

<details>
<summary>查看设置界面预览</summary>

下图使用实际宿主 React/Modal 和凭据测试桩，不是已登录桌面会话截图。

<p><img src="assets/settings-card.png" alt="紧凑的 JEV 模型设置卡片" width="360"></p>
<p><img src="assets/settings-dialog.png" alt="JEV 密钥编辑弹窗" width="360"></p>

</details>

## 开发与反馈

```sh
npm install --no-save --no-package-lock yaml@2
npm test
```

CI 执行 Node 20/22/24 离线检查。原生测试需要 Node 24，并通过 `DSH_HOST_NODE_MODULES` / `DSH_HOST_NATIVE_NODE_MODULES` 指定宿主路径；缺少宿主时跳过不代表桌面兼容。真实 API 检查需主动启用。

反馈问题时请提供插件与宿主版本、系统、新旧会话情况及最小复现步骤，删除日志中的凭据和敏感内容。新功能研究已收口，不再计划让 JEV 介入更多普通任务。

[来源与致谢](PROVENANCE.md) · [发布流程](RELEASING.md) · [MIT 许可证](LICENSE)
