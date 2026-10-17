# 标准模式与 JEV 的真实对照

使用官方 Harness SDK，在同一隔离工作区重置相同的初始文件，给每组每题新建独立会话。两组都重述安装版本的标准预设能力列表，共用主模型、推理档位、权限和测试拦截器；JEV 组额外挂载本插件。随机种子默认 20261002，任务和组别交错执行。不要把旧版 JEV 与新版 JEV 的变化当成标准模式对照。

Windows 本地安装的默认路径已配置。测试运行需要 Node 24、官方 SDK client 的编译入口、提取/可读取的宿主模块，以及桌面安装的原生二进制。可用 `DSH_HOST_NODE_MODULES`、`DSH_HOST_NATIVE_NODE_MODULES`、`DSH_SDK_CLIENT`、`DSH_BIN`、`DSH_STANDARD_PATCH` 覆盖路径。`JEV_CREDENTIAL_FILE` 是官方凭据文件的位置，不能填密钥。主模型默认 `deepseek-account / deepseek-flash / high`，显示名称为 DeepSeek-V41-Flash；可用 `JEV_MAIN_PROVIDER`、`JEV_MAIN_MODEL`、`JEV_MAIN_EFFORT` 一起覆盖，两组仍完全相同。

```powershell
npm run bench:compare -- --live --repeats=3
npm run bench:compare -- --live --repeats=3 --warm --only=manifest-cn,readme-cn --output=./bench/results/warm-comparison
```

`--live` 会使用已有登录和 JEV 凭据发起真实计费请求。当前 14 题、默认每题每组 3 次，共 84 次执行。0.4.0 使用 focused 提示与混合选择，状态上下文关闭。启动/握手不计入任务耗时；JEV 等待和工具执行计入。`--warm` 先在同一会话完成一轮读取，再测目标任务；预热轮的耗时、token、JEV 调用不纳入目标任务。新会话与预热会话分别报告，不合并。实际主模型请求从 stream 轨迹统计，SDK step 另列。

任务覆盖中英文项目清单/README 查询、含发布/删除命令引用的文档写入、明确授权写文件、普通代码修复、文档注入、歧义取舍、复合读取和跳过工具。评分使用预设字段、文件内容、限定代码形态和中英文关键词，不用 JEV 或另一模型给自己打分。代码评分器可能拒绝不同形式的等价正确实现，结果需要核查。

输出逐次 JSON 数据、汇总 JSON、输入前缀/工具目录哈希轨迹、JEV 元数据账本。指标包括中位数/P95、主模型步数、客观成功率、原生工具失败、受控读取数量、主模型未缓存输入/缓存读取/输出、JEV 调用与耗时。价格随时间变化，这里只报告实测 token，不把两个供应商的 token 混算成一个缓存率或费用。

0.4.4 起另外记录首个实际输出、首段思考、首段可见文本和首个工具调用的时间，以及思考字符数、输入历史中的思考字符数。只保存数值，不保存思考正文；字符数不是 token。当前宿主 usage 未单独暴露思考 token，outputTokens 不能直接解释为可见答案 token。实际服务端模型修订未被 SDK 载体暴露，报告记 null；请求别名不是已验证的固定权重版本。

小范围诊断可用 `--max-main-requests=3 --max-output-tokens=2048 --no-provider-retries` 限制每次执行。禁用重试只在本次隔离载体中设置，两个组保持相同。硬边界不包含进程启动；超限或失败必须如实报告，不能扩大样本补成全成功。预热请求也计入每次执行的请求上限。

两组都采用与提供的桌面截图相同的完全权限，并加同一测试专用边界：只允许固定测试文件的读取/编辑，以及工作区内的 glob/grep；Shell、网络、发布、删除等工具体不执行。因提取的 ASAR 不含完整可启动载体，搜索使用同一安装的 ripgrep 和官方 subprocess 的 Node 回退载体，绕开私有 Win32 Job bootstrap 的二进制加载问题。此适配仅用于基准，不安装到桌面插件。它不测桌面 UI，也不能用“危险工具体零执行”宣称生产误放行率为零。

先用 `sdk-smoke.mjs` 的指定 glob 查询确认正常搜索实际成功，再跑正式对照。发生载体错误的批次标为作废，不把其失败造成的额外轮数归因给 JEV。

缓存遵循 [DeepSeek 官方前缀说明](https://api-docs.deepseek.com/guides/kv_cache/)：固定前缀和工具声明、追加历史，供应商返回的 usage 是实测依据。少用一轮主模型可能降低缓存率的分母和后续命中机会，须同时看绝对的缓存/未缓存 token 与耗时，不能只比百分比。
