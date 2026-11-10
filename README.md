# Codex Usage Badge

在 macOS 的 Codex 侧栏查看剩余额度、当前会话上下文、实时活动速率和缓存命中率。

## 安装

1. 从 [GitHub Releases](https://github.com/hyskr/codex-usage-card/releases/latest) 下载最新的 macOS ZIP，完整解压。
2. 双击解压目录中的 **安装.command**，按终端提示完成安装。
3. 完全退出 Codex，然后从原来的应用图标重新打开。首次加载可能需要几秒钟。

安装包包含运行脚本和分词器，不需要先安装原版插件或执行 npm。需要已登录的 Codex 桌面应用，以及 Node.js 24 或更新版本。安装器会优先查找 Codex 自带的 Node.js。遇到未验证的客户端版本时，安装器会显示检测结果并询问是否继续。

详细步骤、升级、卸载与排障见 [macOS 使用说明](docs/macos.md)。

## 徽标

- **额度**显示账号提供的剩余使用额度。根据账号提供的数据，显示每周额度或同时显示 5 小时和每周额度。
- **上下文**显示当前会话最近一次请求的 token 总量相对于模型上下文窗口的比例。
- **tok/s**显示各会话实时活动速率的估算。圆环以 150 tok/s 为满刻度，中心显示实际读数。
- **缓存**显示当前会话最近一次请求的缓存输入 token 占输入 token 的比例。

将鼠标停在徽标上可查看详细数值。当前会话的上下文和缓存需要收到该会话的用量通知后才能显示。空间不足时，部分圆环会收起，详情仍在悬浮面板中。

模型正文 TPS 展示 Codex Token Bar 本地记录中各模型最近一次合格读数及近 15、30 分钟均速，需要该应用生成记录。实时活动速率借鉴 Codex Token Bar 的平滑方式，数据源及结果可能不同。

## 源码与构建

`src/` 包含运行脚本与 macOS 启动组件，`packaging/` 包含安装入口，`scripts/` 包含打包脚本。构建方法见 [开发说明](docs/development.md)。

## 许可与来源

本定制版采用 [AGPL-3.0](LICENSE)。它基于 MIT 许可的 [Codex Usage Card](https://github.com/Lorie7813/codex-usage-card)，活动速率算法参考 [Codex Token Bar](https://github.com/hututuo/codex-token-bar)。第三方组件及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

这是独立的非官方项目，与 OpenAI 无官方关联。
