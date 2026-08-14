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
});

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

function collectImageBlocks(content, output, seen) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "image") {
      const key = String(block.attachment?.attachmentId || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      output.push(block);
      continue;
    }
    if (block?.type === "tool-result") {
      collectImageBlocks(block.content, output, seen);
    }
  }
}

function collectText(content, output) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "text" && block.text.trim()) {
      output.push(block.text.trim());
    } else if (block?.type === "tool-result") {
      collectText(block.content, output);
    }
  }
}

function buildVisionMessage(messages, createUserMessage) {
  const images = [];
  const seen = new Set();
  const text = [];
  for (const message of messages) {
    collectImageBlocks(message?.content, images, seen);
    collectText(message?.content, text);
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

  const assembler = assembleVisionText();
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
  return { ...assembler.result(), count: vision.count };
}

function analysisMessage(analysis, config, createUserMessage) {
  const summary = analysis.ok
    ? `${config.visionModel} 已分析 ${analysis.count} 张图片`
    : `${config.visionModel} 视觉分析失败`;
  const text = analysis.ok
    ? `[${config.visionModel} 视觉分析，仅供 DeepSeek 回答时参考]\n${analysis.text}`
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

function applyWithFactory(ctx, rawConfig = {}, createUserMessage) {
  const config = { ...DEFAULT_CONFIG, ...rawConfig };
  ctx.effect(
    () => installCapabilityOverlay(ctx, config),
    "dsh-image-router: advertise DeepSeek image routing",
  );

  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    if (!isDeepSeekProvider(agent?.options?.provider, config) || !messagesHaveImage(messages)) {
      return next();
    }
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const analysis = await analyzeImages(ctx, messages, signal, config, createUserMessage);
    signal.throwIfAborted();
    return {
      kind: "enter",
      messages: [...decision.messages, analysisMessage(analysis, config, createUserMessage)],
    };
  });

  ctx.on("llm/stream", (options, next) => {
    if (!isDeepSeekProvider(options.provider, config) || !messagesHaveImage(options.messages)) {
      return next();
    }
    return ctx.llm.stream({
      ...options,
      messages: stripImagesFromMessages(options.messages, config),
    });
  });
}

module.exports = {
  name: "dsh-image-router",
  inject: ["llm"],
  async apply(ctx, rawConfig = {}) {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    applyWithFactory(ctx, rawConfig, createUserMessage);
  },
  _test: { applyWithFactory },
};
