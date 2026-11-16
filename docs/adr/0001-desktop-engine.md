---
status: accepted
---
# React/Electron 桌面与 Rust 独立引擎

产品需要复杂节点交互、Windows Demo 和后续 Apple Silicon Mac，且用户不要求保留 C# 核心。选择 React/TypeScript + Electron 承担桌面交互，Rust 独立进程承担计划检查和文件执行，避免让界面生命周期决定任务真实性；接受双语言与进程协议维护成本。

考虑过继续 WPF、Avalonia/.NET、Electron/.NET 和 Tauri。选择不是基于 Rust 必然更快的假设；真实设备与故障测试才决定性能及可靠性。第三方库及具体协议待验证，首版不开放 Web 服务。
