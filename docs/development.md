# 开发与打包

需要 macOS、Node.js 24 或更新版本和 npm。

```sh
npm ci
npm run check
npm run release
npm test
```

测试在隔离的临时用户目录中模拟安装、升级和卸载，并验证会话切换与弹层避让。发布包生成在 `dist/`。也可以通过 `node scripts/build-release.cjs /目标目录` 指定输出位置。脚本构建本地分词器，并将安装入口、运行文件、启动助手和许可文件打包为 ZIP。

`src/macos/startup/bridge` 是来自 Codex Usage Card 0.9.5 macOS 发布包的通用二进制，包含 Apple Silicon 与 Intel 架构。其随原安装包分发的 JavaScript 启动控制器位于同一目录。原始 MIT 许可保存在 `licenses/`。

运行数据保存在当前用户的 Library 目录。活动速率使用窗口中的本地事件；模型正文测速摘要读取 Codex Token Bar 的本地记录。
