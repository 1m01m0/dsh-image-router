# dsh-image-router

给 DeepSeek Harness 的纯文本模型增加图片理解能力：有图时先调用可配置的多模态模型生成视觉描述，再由原来的 DeepSeek 模型完成最终回答。

## 行为

- 仅拦截 `sourceProviders` 中的模型路由，默认是 `deepseek-official`。
- 图片消息先交给 `visionProvider / visionModel`，默认是 `minimax-cn / MiniMax-M3`。
- 视觉描述作为插件上下文写入会话，后续轮次不会重复识图。
- 原图保留在聊天记录中，但在进入 DeepSeek 适配器前被移除。
- 其他模型和无图片消息不受影响。
- 插件会向 Harness 的图片准入层声明 DeepSeek 已具备路由后的图片能力。
- 首次图片回答采用强隔离：移除图片技能入口并禁用全部工具，防止模型扫描本地文件、剪贴板或联网二次识别。
- 图片回答完成后的普通轮次恢复工具能力，不会永久锁死会话。

## 安装

```bash
git clone https://github.com/1m01m0/dsh-image-router.git
cd dsh-image-router
node scripts/install.mjs
```

安装器会优先检测 macOS 桌面版数据目录，也可以显式指定：

```bash
node scripts/install.mjs --home "$HOME/Library/Application Support/DeepSeek Harness/dsh"
```

安装后完全退出并重新打开 DeepSeek Harness。

## 自定义识图模型

重新运行安装器即可更新配置：

```bash
node scripts/install.mjs \
  --vision-provider minimax-cn \
  --vision-model MiniMax-M3 \
  --vision-max-tokens 4096 \
  --source-provider deepseek-official
```

`--source-provider` 可以重复提供。对应配置会写入 `profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: image-router
      name: dsh-image-router
      config:
        visionProvider: minimax-cn
        visionModel: MiniMax-M3
        visionMaxTokens: 4096
        sourceProviders: [deepseek-official]
```

识图模型必须在 Harness 中已经配置凭据，并声明支持 `image` 输入。

## 隐私

图片会发送给配置的识图模型；DeepSeek 只收到视觉模型生成的文字描述。插件不读取或上传凭据、历史会话目录与其他本地文件。

视觉描述注入后的第一次 DeepSeek 调用不提供任何工具，并附加系统级安全边界。如果描述不足，DeepSeek 应直接说明无法确认，而不是在本机或网络上继续寻找图片。

## 卸载

```bash
node scripts/uninstall.mjs
```

## 验证

```bash
npm test
node --check index.js
```

MIT License
