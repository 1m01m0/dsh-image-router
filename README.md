# dsh-image-router

给 DeepSeek Harness 的纯文本模型增加图片理解能力：有图时先调用可配置的多模态模型生成视觉描述，再由原来的 DeepSeek 模型完成最终回答。

## 定位与适用场景

这是一个 **DeepSeek Harness 插件**，工作在消息与模型调用链路中。它解决的是“当前选择了 DeepSeek，但聊天消息包含图片”这一自动路由问题，而不是一组通用的图片处理脚本。

| 需求 | 应使用 |
| --- | --- |
| 在 Harness 中选择 DeepSeek，并直接从聊天框发送图片 | **`dsh-image-router`** |
| 让 MiniMax-M3 等视觉模型先看图，再由 DeepSeek 组织最终回答 | **`dsh-image-router`** |
| 对一个已知本地文件做 OCR、二维码解码、颜色或元数据提取 | [`image-vision-bridge`](https://github.com/1m01m0/image-vision-bridge) |
| GUI 无法附图，需要显式读取剪贴板或本地路径 | `image-vision-bridge`（手动备用入口） |
| 当前模型本身已经支持图片输入 | 通常两者都不需要 |

### 与 image-vision-bridge 的关系

- `dsh-image-router` 是**自动编排层**：接收聊天附件，调用配置的视觉模型一次，再把文字视觉描述交给 DeepSeek。
- `image-vision-bridge` 是**显式工具层**：适合在用户给出明确文件路径和明确任务后，运行本地 OCR、扫码或图片信息脚本。
- 两者可以同时安装，但同一张聊天附件应由本插件单独处理。首次图片回答会移除 `image-vision-bridge` 入口并注入安全边界；项目读取、编辑等正常工具仍然可用，但不得用于重新寻找或识别图片。
- 如需对本地文件使用 `image-vision-bridge`，建议在没有聊天图片附件的新会话中明确提供文件路径与任务。

本插件不用于：批量整理本地图片、主动搜索附件文件、识别人脸身份、联网反查人物或替代专业 OCR/图像编辑工具。

## 行为

- 仅拦截 `sourceProviders` 中的模型路由，默认是 `deepseek-official`。
- 图片消息先交给 `visionProvider / visionModel`，默认是 `minimax-cn / MiniMax-M3`。
- 视觉描述作为插件上下文写入会话，后续轮次不会重复识图。
- 原图保留在聊天记录中，但在进入 DeepSeek 适配器前被移除。
- 其他模型和无图片消息不受影响。
- 插件会向 Harness 的图片准入层声明 DeepSeek 已具备路由后的图片能力。
- 首次图片回答会移除图片技能入口并注入安全边界，防止模型扫描本地文件、剪贴板或联网二次识别。
- 非图片技能与正常项目工具保持可用，发送参考图不会阻断编码、读取项目或其他任务，也不会造成工具协议文本泄漏。

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

视觉描述注入后的第一次 DeepSeek 调用会附加系统级安全边界，并移除图片 Skill；其他项目工具仍可用于完成用户任务。如果描述不足，DeepSeek 应直接说明无法确认，而不是用这些工具在本机或网络上继续寻找图片。

安装并启用本插件，意味着当 `sourceProviders` 中的模型收到聊天图片时，图片会自动发送到你配置的 `visionProvider / visionModel`。请只配置你信任的视觉服务。该自动发送范围仅限用户在聊天中附加的图片，不包含本地目录中的其他文件。

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
