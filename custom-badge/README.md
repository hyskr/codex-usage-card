# Codex Usage Badge 定制版

在 Codex 侧栏显示剩余额度、当前会话上下文占用、实时活动速率与当前会话最近请求的缓存命中率。悬浮详情显示额度重置时间、缓存输入和各模型最近的正文速度。

- 活动速率参考 Codex Token Bar 的活动分配与平滑方式，按本地窗口收到的事件汇总。圆环以 150 tok/s 为满刻度。
- 上下文占用为最近一次请求的 token 总量占模型上下文窗口的比例。
- 缓存命中率为当前会话最近一次请求的缓存输入 token 占输入 token 的比例。徽标运行后收到该会话的用量数据时开始显示。
- 模型正文速度读取本机 Codex Token Bar 的已完成正文记录，展示最近一次读数及 15、30 分钟均速。

## 安装

需要 macOS、Node.js 24 或更高版本，以及已安装的 [Codex Usage Badge 0.9.5](https://github.com/Lorie7813/codex-usage-card/releases/tag/v0.9.5-beta.1)。

在本目录运行：

```sh
./install.sh
```

脚本安装依赖、构建本地分词器，替换已安装的徽标脚本并重启后台服务。用量资料在本地处理。模型速度依赖 Codex Token Bar 的本地记录。

## 许可

本目录的定制脚本采用 [AGPL-3.0](LICENSE-AGPL-3.0)，其中包含来自 [Codex Token Bar](https://github.com/hututuo/codex-token-bar) 的活动速率算法。原始 Codex Usage Badge 代码的 [MIT 许可](LICENSE-UPSTREAM-MIT)继续适用。分词器使用 MIT 许可的 [js-tiktoken](https://github.com/dqbd/tiktoken)。
