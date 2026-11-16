# CardHelper 设计文档

更新日期：2026-11-16。Windows Demo 开发中的新增设计收录于决策记录，交付与验证状态见里程碑。

- [已确认设计与决策演变](DECISIONS.md)
- [里程碑与验收](ROADMAP.md)
- [设计树与待决问题](DESIGN-TREE.md)
- [领域术语](../GLOSSARY.md)
- [ADR 0001：桌面与执行引擎](adr/0001-desktop-engine.md)
- [ADR 0002：官方工作流与自定义自由度](adr/0002-presets-and-custom-workflows.md)
- [ADR 0003：工作流与执行计划分离](adr/0003-workflow-and-execution.md)
- [ADR 0004：分流路径由连线保存](adr/0004-directory-routing.md)
- [ADR 0005：工作流 v2 显式连接复制策略](adr/0005-explicit-copy-strategy.md)
- [ADR 0006：工作流 v3 将目录名称保存在节点](adr/0006-directory-names-in-workflows.md)
- [重大变更记录约定](../AGENTS.md)

## 现有代码与资料边界

工作区目前包含 `CardHelper-master.zip` 及解压后的 `CardHelper-master/`，不是已验证同步到远端的 Git checkout。设计文档放在工作区根目录，不修改旧源码快照。

静态检查显示旧代码是 WPF 界面与独立复制、哈希、报告原型：页面按钮未接通完整业务；复制异常部分只打印到控制台；流复制直接写入已有目标；报告入口仍是占位实现。它不实现本文的新任务语义。未完成编译、运行和真实设备测试。

GitHub 调研参考：

| 来源 | 参考用途 | 已知限制 |
| --- | --- | --- |
| [Offloader](https://github.com/owenpkent/offloader) | 通用传输与媒体 profile 分层、报告 | 仅查阅仓库资料；默认校验及按大小跳过策略不能直接沿用 |
| [BitMatch](https://github.com/BitmatchApp/Bitmatch) | 多目标影视拷卡与任务体验 | 未运行或源码审计 |
| [organize](https://github.com/tfeldmann/organize) | 来源、筛选、动作、模拟执行 | 不直接决定我们的执行引擎 |
| [Nodify](https://github.com/miroiu/nodify) | 节点交互参考 | WPF 路线已被替换，不作为已选依赖 |
| [xyflow](https://github.com/xyflow/xyflow) | Windows Demo 已使用的 React 节点画布 | 发布前核对许可证与版本 |
| [ASC MHL](https://github.com/ascmitc/mhl) | 后续清单兼容 | 非 Demo 功能 |

Sony 官方目录示例参考：[FX3](https://helpguide.sony.net/ilc/2210/v1/en/contents/TP1000868300.html)、[A7 IV](https://helpguide.sony.net/ilc/2110/v1/en/print.html)、[ZV-E1](https://helpguide.sony.net/ilc/2310/v1/en/contents/0903B_import_pc.html)。SD 与 CFexpress 的 M4ROOT 位置可能不同；这些示例不是所有固件和录制模式的完整依赖规范。XML、代理配对、分段与特殊录制模式须进一步核验。

最后几轮网络查询失败；Rust、Electron、节点库和哈希库的具体版本、维护状态、许可证、最低系统版本均未完成核验。参考项目的自述能力不等于本项目已验证能力。
