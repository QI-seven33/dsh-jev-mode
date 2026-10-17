# 安装 JEV 决策模式

## 桌面版

适配并验证的宿主为 DeepSeek Harness Desktop 0.2.0-rc.2。其他版本需核对模型设置槽位、凭据服务和标准预设组合，不能据此承诺所有版本兼容。

1. 打开 Harness 的「插件」管理页面，选择安装插件。
2. 输入 `github:QI-seven33/dsh-jev-mode#v0.4.3`，安装并启用。
3. 也可下载 [Release 附件 dsh-jev-mode-0.4.3.tgz](https://github.com/QI-seven33/dsh-jev-mode/releases/download/v0.4.3/dsh-jev-mode-0.4.3.tgz)，在相同安装入口填写该文件的绝对路径。不要将源码 zip 或 `.dshpreset` 当作 npm 插件包。
4. 完全退出并重启 Harness。
5. 「设置 → 模型」底部会出现收起的「JEV 决策模型」卡片。点击「编辑」，输入自己的 TypeSafe API 密钥并保存。状态点表示凭据已配置，不表示已验证 API 连通性。
6. 新会话选择「JEV 决策模式」。仅安装插件、只使用标准模式不会激活 JEV 的读取和授权逻辑。

源码仓库已经包含可运行的 `settings.js`、`index.js`、`client.js` 和 `lib/`，没有运行时依赖、安装生命周期或编译步骤。客户端使用宿主内置 React 与 UI 组件，不要求用户单独安装 React。

仅 `git clone` 把源码下载到磁盘不会自动把它启用在 Harness 中。安装器需要记录依赖及 `dsh.profile.bundles`，补丁才会贡献全局设置入口和 JEV 预设。不要复制作者的 `.dsh`、账号配置、凭据或台账。

## 功能边界

- 每个用户需要自己的 DeepSeek 主模型账户或模型配置，以及 TypeSafe 密钥。插件不附带共享密钥。
- 无 TypeSafe 密钥时，明确读取仍可运行；语义读取回退；危险授权判断失败进入审批或拒绝。
- 可以获得相同 UI 与决策流程，但速度、缓存比例和安全判断质量会受模型、网络与任务影响，没有固定性能保证。
- 密钥由宿主凭据服务保存。启动环境提供的值为只读；移除已保存值可能恢复 `.env` 备用来源。
- 更新后开新会话；手动配置旧插件行时，决策插件名称应为 `dsh-jev-mode/mode`。

## 安装验证

`npm test` 包括设置契约与原生回归；发布包经过全新隔离 profile 的宿主 PluginManager 安装、启用、导出解析及浏览器模块发现验证。浏览器交互使用实际宿主 React/Modal 及插件组件。本地安装验证不代替其他版本、其他操作系统及真实 API 的验收。公开下载链路的核验结果在 Release 中补充。

官方打包机制参考：[Package and install a plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
