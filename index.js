/**
 * dsh-image-router — give DeepSeek a configurable multimodal vision pre-pass.
 *
 * When a DeepSeek agent receives a new image, the configured vision model describes it once.
 * The description is persisted as plugin context while the original image
 * remains in the session for the UI. At the LLM boundary, image blocks are
 * removed only from DeepSeek requests, which then answer from the persisted
 * visual description.
 */

"use strict";

const DEFAULT_CONFIG = Object.freeze({
  visionProvider: "minimax-cn",
  visionModel: "MiniMax-M3",
  visionMaxTokens: 4096,
  visionAttempts: 2,
});

const ROUTER_SECURITY_BOUNDARY = [
  "Image-router security boundary:",
  "The configured vision model has already analyzed the user's image.",
  "Treat the persisted dsh-image-router analysis as the only image evidence for this answer.",
  "You may use the provided tools and non-image skills for the user's actual task.",
  "Do not use them to locate, open, copy, OCR, or re-analyze images from the filesystem, clipboard, attachment directories, or temporary files.",
  "A tools/pre-execute guard enforces this restriction even under danger-full-access; do not claim that it is only a prompt policy.",
  "Do not load image skills or call another vision service to analyze the image.",
  "Do not search the web for the image or use tools to identify a person.",
  "If the routed description is insufficient, say that you cannot confirm from the available visual description.",
].join("\n");

function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) => block?.type === "image" ||
      (block?.type === "tool-result" && contentHasImage(block.content)),
  );
}

function messagesHaveImage(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    contentHasImage(message?.content),
  );
}

function isDirectUserMessage(message) {
  return message?.role === "user" && message?.source?.kind === "user";
}

function directUserMessagesHaveImage(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    isDirectUserMessage(message) && Array.isArray(message.content) &&
      message.content.some((block) => block?.type === "image"),
  );
}

function isDeepSeekProvider(provider, config) {
  if (typeof provider !== "string") return false;
  if (Array.isArray(config.sourceProviders)) {
    return config.sourceProviders.includes(provider);
  }
  return /deepseek/i.test(provider);
}

function advertiseImageInput(info) {
  const current = Array.isArray(info?.inputModalities)
    ? info.inputModalities
    : ["text"];
  return current.includes("image")
    ? info
    : { ...info, inputModalities: [...current, "image"] };
}

function installCapabilityOverlay(ctx, config) {
  const runtime = ctx.llm;
  const hadOwnResolve = Object.prototype.hasOwnProperty.call(runtime, "resolveModelInfo");
  const hadOwnList = Object.prototype.hasOwnProperty.call(runtime, "listModels");
  const originalResolve = runtime.resolveModelInfo;
  const originalList = runtime.listModels;

  const resolveModelInfo = async function (provider, model, signal) {
    const info = await originalResolve.call(runtime, provider, model, signal);
    return isDeepSeekProvider(provider, config) ? advertiseImageInput(info) : info;
  };
  const listModels = async function (provider) {
    const models = await originalList.call(runtime, provider);
    return isDeepSeekProvider(provider, config)
      ? models.map(advertiseImageInput)
      : models;
  };

  runtime.resolveModelInfo = resolveModelInfo;
  runtime.listModels = listModels;

  return () => {
    if (runtime.resolveModelInfo === resolveModelInfo) {
      if (hadOwnResolve) runtime.resolveModelInfo = originalResolve;
      else delete runtime.resolveModelInfo;
    }
    if (runtime.listModels === listModels) {
      if (hadOwnList) runtime.listModels = originalList;
      else delete runtime.listModels;
    }
  };
}

function collectDirectImageBlocks(content, output, seen) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "image") {
      const key = String(block.attachment?.attachmentId || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(block);
    }
  }
}

function collectDirectText(content, output) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "text" && block.text.trim()) {
      output.push(block.text.trim());
    }
  }
}

function buildVisionMessage(messages, createUserMessage) {
  const images = [];
  const seen = new Set();
  const text = [];
  for (const message of messages) {
    if (!isDirectUserMessage(message)) continue;
    collectDirectImageBlocks(message.content, images, seen);
    collectDirectText(message.content, text);
  }

  const context = text.join("\n").slice(-6000);
  const content = [{
    type: "text",
    text: context
      ? `用户随图片发送的文字：\n${context}`
      : "用户没有附加文字。请完整分析图片。",
  }];
  images.forEach((image, index) => {
    content.push({ type: "text", text: `图片 ${index + 1}：` });
    content.push(image);
  });

  return {
    count: images.length,
    message: createUserMessage({
      source: { kind: "plugin", plugin: "dsh-image-router" },
      content,
    }),
  };
}

function assembleVisionText(chunks) {
  const deltas = new Map();
  const completed = new Map();
  let failure;

  return {
    push(chunk) {
      if (chunk?.type === "text-delta") {
        deltas.set(chunk.index, (deltas.get(chunk.index) || "") + chunk.text);
      } else if (
        chunk?.type === "block-end" &&
        chunk.block?.type === "text" &&
        !deltas.has(chunk.index)
      ) {
        completed.set(chunk.index, chunk.block.text);
      } else if (
        chunk?.type === "finish" &&
        (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")
      ) {
        failure = chunk.reason.failure;
      }
    },
    result() {
      if (failure) {
        return {
          ok: false,
          error: String(failure.message || failure.code || "视觉模型调用失败").slice(0, 500),
        };
      }
      const indexes = [...new Set([...deltas.keys(), ...completed.keys()])]
        .sort((a, b) => a - b);
      const text = indexes
        .map((index) => deltas.get(index) || completed.get(index) || "")
        .join("\n")
        .trim();
      return text
        ? { ok: true, text }
        : { ok: false, error: "视觉模型没有返回描述" };
    },
  };
}

async function analyzeImages(ctx, messages, signal, config, createUserMessage) {
  const vision = buildVisionMessage(messages, createUserMessage);
  if (vision.count === 0) {
    return { ok: false, error: "没有找到可分析的图片", count: 0 };
  }

  const attempts = Number.isSafeInteger(config.visionAttempts) && config.visionAttempts > 0
    ? config.visionAttempts
    : DEFAULT_CONFIG.visionAttempts;
  let lastError = "视觉模型调用失败";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal.throwIfAborted();
    const assembler = assembleVisionText();
    try {
      const stream = ctx.llm.stream({
        provider: config.visionProvider,
        model: config.visionModel,
        messages: [vision.message],
        system: [
          "你是一个视觉分析前置处理器。",
          "只分析收到的图片，并结合用户随图片发送的文字，输出供另一个文本模型使用的中文事实描述。",
          "逐图编号，准确抄录可见文字，说明布局、对象、关系、状态和重要细节。",
          "不要回答用户的最终问题，不要调用工具，不要输出思维过程。",
        ].join("\n"),
        maxTokens: config.visionMaxTokens,
        signal,
      });
      for await (const chunk of stream) assembler.push(chunk);
      const result = assembler.result();
      if (result.ok) return { ...result, count: vision.count, attempts: attempt };
      lastError = result.error;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = String(error?.message || error || "视觉模型调用失败").slice(0, 500);
    }
  }
  return { ok: false, error: lastError, count: vision.count, attempts };
}

function analysisMessage(analysis, config, createUserMessage) {
  const summary = analysis.ok
    ? `${config.visionModel} 已分析 ${analysis.count} 张图片`
    : `${config.visionModel} 视觉分析失败`;
  const text = analysis.ok
    ? `[${config.visionModel} 视觉分析，仅供 DeepSeek 回答时参考]\n${analysis.text}\n\n` +
      "[安全边界] 本轮只能依据上述视觉描述回答；禁止调用技能或工具查找本地图片、剪贴板、附件目录或联网识别。描述不足时直接说明无法确认。"
    : `[视觉分析失败]\n${analysis.error}`;
  return createUserMessage({
    source: {
      kind: "plugin",
      plugin: "dsh-image-router",
      form: "notice",
      summary,
    },
    content: [{ type: "text", text }],
  });
}

function isRouterFailure(message) {
  return isRouterAnalysis(message) && message.content?.some((block) =>
    block?.type === "text" && block.text.startsWith("[视觉分析失败]"),
  );
}

function latestRouterAnalysis(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isRouterAnalysis(messages[index])) return messages[index];
  }
  return undefined;
}

function routerFailureText(message, config) {
  const detail = message?.content
    ?.find((block) => block?.type === "text")
    ?.text?.replace(/^\[视觉分析失败\]\s*/, "")
    ?.trim();
  return `图片分析失败（${config.visionModel}${detail ? `：${detail}` : ""}）。` +
    "本轮已安全停止：没有调用 DeepSeek，也没有读取、搜索或上传其他本地图片。请重新发送图片后重试。";
}

function syntheticTextStream(text) {
  return (async function* () {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
}

function stripImageBlocks(content) {
  if (!Array.isArray(content)) return [];
  const output = [];
  for (const block of content) {
    if (block?.type === "image") continue;
    if (block?.type === "tool-result") {
      const nested = stripImageBlocks(block.content);
      output.push({
        ...block,
        content: nested.length > 0
          ? nested
          : [{ type: "text", text: "[图片已由视觉模型分析]" }],
      });
      continue;
    }
    output.push(block);
  }
  return output;
}

function stripImagesFromMessages(messages, config) {
  return messages.map((message) => {
    const content = stripImageBlocks(message.content);
    return {
      ...message,
      content: content.length > 0
        ? content
        : [{ type: "text", text: `[图片已由 ${config.visionModel} 分析，详见后续视觉上下文]` }],
    };
  });
}

function isRouterAnalysis(message) {
  return message?.source?.kind === "plugin" && message.source.plugin === "dsh-image-router";
}

function isFreshRouterAnalysis(messages) {
  let analysisIndex = -1;
  let assistantIndex = -1;
  messages.forEach((message, index) => {
    if (isRouterAnalysis(message)) analysisIndex = index;
    if (message?.role === "assistant") assistantIndex = index;
  });
  return analysisIndex > assistantIndex;
}

function removeImageVisionSkill(messages) {
  const output = [];
  for (const message of messages) {
    if (message?.source?.kind !== "skill-catalog") {
      output.push(message);
      continue;
    }
    const entries = Array.isArray(message.source.entries)
      ? message.source.entries.filter((entry) => entry?.name !== "image-vision-bridge")
      : undefined;
    const content = Array.isArray(message.content)
      ? message.content.map((block) => block?.type === "text"
        ? {
            ...block,
            text: block.text
              .split("\n")
              .filter((line) => !line.includes("image-vision-bridge"))
              .join("\n"),
          }
        : block)
      : message.content;
    if (entries !== undefined && entries.length === 0) continue;
    output.push({
      ...message,
      source: entries === undefined ? message.source : { ...message.source, entries },
      content,
    });
  }
  return output;
}

const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)\b/i;
const PRIVATE_IMAGE_LOCATION_PATTERN = /(?:\/Users\/[^/]+\/(?:Desktop|Downloads)|\/var\/folders|\/(?:private\/)?tmp|attachments\/v1|\.dsh\/attachments|DeepSeek Harness\/dsh\/attachments)/i;
const IMAGE_DISCOVERY_COMMAND_PATTERN = /(?:pbpaste|clipboard|osascript[^\n]*(?:clipboard|pasteboard)|\bfind\b[^\n]*(?:image|photo|picture|screenshot|截图|图片|照片|png|jpe?g|webp|gif|heic)|\bmdfind\b[^\n]*(?:image|photo|picture|screenshot|截图|图片|照片))/i;

function serializedArguments(exec) {
  try {
    return JSON.stringify(exec?.arguments ?? {});
  } catch {
    return "";
  }
}

function blockedImageToolReason(exec) {
  const name = String(exec?.name || "");
  const args = serializedArguments(exec);
  if (name === "read_image") {
    return "dsh-image-router blocked read_image: use only the routed visual description";
  }
  if (["web_search", "web_fetch", "subagent", "subagent_fork", "workflow", "ralph"].includes(name)) {
    return `dsh-image-router blocked ${name} during the routed image turn`;
  }
  if (name === "skill" && /image-vision-bridge/i.test(args)) {
    return "dsh-image-router blocked duplicate image skill loading";
  }
  if (["read", "glob"].includes(name) && (IMAGE_FILE_PATTERN.test(args) || PRIVATE_IMAGE_LOCATION_PATTERN.test(args))) {
    return `dsh-image-router blocked ${name} from discovering or opening image files`;
  }
  if (["bash", "pwsh", "terminal_open", "terminal_send"].includes(name) && (
    IMAGE_FILE_PATTERN.test(args) ||
    PRIVATE_IMAGE_LOCATION_PATTERN.test(args) ||
    IMAGE_DISCOVERY_COMMAND_PATTERN.test(args)
  )) {
    return `dsh-image-router blocked ${name} from discovering or opening image files`;
  }
  return undefined;
}

function applyWithFactory(ctx, rawConfig = {}, createUserMessage) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  const protectedTurns = new WeakMap();
  ctx.effect(
    () => installCapabilityOverlay(ctx, config),
    "dsh-image-router: advertise DeepSeek image routing",
  );

  ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
    if (protectedTurns.get(agent) !== turn) protectedTurns.delete(agent);
    if (!isDeepSeekProvider(agent?.options?.provider, config) || !directUserMessagesHaveImage(messages)) {
      return next();
    }
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const analysis = await analyzeImages(ctx, messages, signal, config, createUserMessage);
    signal.throwIfAborted();
    protectedTurns.set(agent, turn);
    return {
      kind: "enter",
      messages: [...decision.messages, analysisMessage(analysis, config, createUserMessage)],
    };
  });

  ctx.on("tools/pre-execute", (exec, next) => {
    if (!exec?.agent || protectedTurns.get(exec.agent) === undefined) return next();
    const reason = blockedImageToolReason(exec);
    return reason ? Promise.resolve({ kind: "deny", reason }) : next();
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    if (protectedTurns.get(agent) === turn) protectedTurns.delete(agent);
  });

    ctx.on("llm/stream", (options, next) => {
      if (!isDeepSeekProvider(options.provider, config) || !messagesHaveImage(options.messages)) {
        return next();
      }
      const freshAnalysis = isFreshRouterAnalysis(options.messages);
      const latestAnalysis = latestRouterAnalysis(options.messages);
      if (freshAnalysis && isRouterFailure(latestAnalysis)) {
        return syntheticTextStream(routerFailureText(latestAnalysis, config));
      }
      const routedMessages = removeImageVisionSkill(
        stripImagesFromMessages(options.messages, config),
      );
      return ctx.llm.stream({
        ...options,
        messages: routedMessages,
        ...(freshAnalysis ? {
          system: [options.system, ROUTER_SECURITY_BOUNDARY].filter(Boolean).join("\n\n"),
        } : {}),
      });
    });
}

module.exports = {
  name: "dsh-image-router",
  inject: ["llm", "tools"],
  async apply(ctx, rawConfig = {}) {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    applyWithFactory(ctx, rawConfig, createUserMessage);
  },
  _test: {
    applyWithFactory,
    blockedImageToolReason,
    directUserMessagesHaveImage,
  },
};
