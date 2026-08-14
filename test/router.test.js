const test = require("node:test");
const assert = require("node:assert/strict");
const plugin = require("..");

function createUserMessage(input) {
  const message = {
    id: "test-" + Math.random().toString(16).slice(2),
    role: "user",
    ...input,
  };
  return Object.freeze(message);
}

function chunks(items) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test("advertises image admission and routes DeepSeek images through the configured vision model", async () => {
  const listeners = new Map();
  const calls = [];
  let cleanup;
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, inputModalities: ["text"] };
    },
    async listModels(provider) {
      return [{ provider, id: "model", name: "model", inputModalities: ["text"] }];
    },
    stream(options) {
      calls.push(options);
      if (options.provider === "vision-provider") {
        return chunks([
          { type: "text-delta", index: 0, text: "测试图片描述" },
          { type: "finish", reason: { kind: "stop" } },
        ]);
      }
      return chunks([{ type: "finish", reason: { kind: "stop" } }]);
    },
  };
  const ctx = {
    llm,
    effect(install) { cleanup = install(); },
    on(name, callback) {
      const list = listeners.get(name) || [];
      list.push(callback);
      listeners.set(name, list);
    },
  };
  plugin._test.applyWithFactory(ctx, {
    visionProvider: "vision-provider",
    visionModel: "vision-model",
    sourceProviders: ["deepseek-official"],
  }, createUserMessage);

  assert.deepEqual(
    (await llm.resolveModelInfo("deepseek-official", "deepseek-model")).inputModalities,
    ["text", "image"],
  );
  assert.deepEqual(
    (await llm.resolveModelInfo("other", "other-model")).inputModalities,
    ["text"],
  );

  const image = {
    id: "u1",
    role: "user",
    source: { kind: "user" },
    content: [{
      type: "image",
      attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
    }],
  };
  const skillCatalog = {
    id: "skills",
    role: "user",
    source: {
      kind: "skill-catalog",
      entries: [
        { name: "image-vision-bridge", description: "find and analyze images" },
        { name: "project-structure-viewer", description: "map projects" },
      ],
    },
    content: [{
      type: "text",
      text: "- `image-vision-bridge`: find images\n- `project-structure-viewer`: map projects",
    }],
  };
  const signal = new AbortController().signal;
  const agent = { options: { provider: "deepseek-official" } };
  const decision = await listeners.get("agent/pre-step")[0](
    { agent, messages: [image], turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [image, skillCatalog] }),
  );
  assert.equal(calls[0].provider, "vision-provider");
  const analysis = decision.messages.find((message) => message.source?.plugin === "dsh-image-router");
  assert.ok(analysis);
  assert.match(analysis.content[0].text, /测试图片描述/);

  const routed = listeners.get("llm/stream")[0](
    {
      provider: "deepseek-official",
      model: "deepseek-model",
      messages: decision.messages,
      system: "base system",
      tools: [{ name: "run_code", description: "execute tool program", parameters: {} }],
    },
    () => { throw new Error("image request was not intercepted"); },
  );
  assert.equal(typeof routed[Symbol.asyncIterator], "function");
  assert.equal(typeof routed.then, "undefined");
  await Array.fromAsync(routed);
  assert.equal(JSON.stringify(calls.at(-1).messages).includes('"type":"image"'), false);
  assert.match(JSON.stringify(calls.at(-1).messages), /vision-model/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /\$\{config\.visionModel\}/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /image-vision-bridge/);
  assert.match(JSON.stringify(calls.at(-1).messages), /project-structure-viewer/);
  assert.deepEqual(calls.at(-1).tools, [
    { name: "run_code", description: "execute tool program", parameters: {} },
  ]);
  assert.match(calls.at(-1).system, /use the provided tools and non-image skills/);
  assert.match(calls.at(-1).system, /tools\/pre-execute guard enforces this restriction/);
  assert.match(calls.at(-1).system, /Do not search the web/);

  const preExecute = listeners.get("tools/pre-execute")[0];
  const allow = async () => ({ kind: "allow" });
  assert.deepEqual(
    await preExecute({ agent, name: "read_image", arguments: { path: "/tmp/a.png" } }, allow),
    { kind: "deny", reason: "dsh-image-router blocked read_image: use only the routed visual description" },
  );
  assert.equal(
    (await preExecute({ agent, name: "glob", arguments: { pattern: "**/*.jpg", path: "/Users/emo" } }, allow)).kind,
    "deny",
  );
  assert.equal(
    (await preExecute({ agent, name: "web_search", arguments: { query: "who is in this image" } }, allow)).kind,
    "deny",
  );
  assert.equal(
    (await preExecute({ agent, name: "bash", arguments: { command: "find /Users/emo/Downloads -name '*.jpg'" } }, allow)).kind,
    "deny",
  );
  assert.equal(
    (await preExecute({ agent, name: "subagent", arguments: { task: "find the attached image" } }, allow)).kind,
    "deny",
  );
  assert.equal(
    (await preExecute({ agent, name: "read", arguments: { file_path: "/project/src/app.ts" } }, allow)).kind,
    "allow",
  );
  assert.equal(
    (await preExecute({ agent, name: "bash", arguments: { command: "npm test" } }, allow)).kind,
    "allow",
  );

  const visionCallsBeforeToolImage = calls.filter((call) => call.provider === "vision-provider").length;
  const toolImage = {
    id: "tool-image",
    role: "user",
    source: { kind: "plugin", plugin: "tool-fs" },
    content: [{
      type: "tool-result",
      content: [{
        type: "image",
        attachment: { attachmentId: "local-file", mediaType: "image/jpeg", bytes: 1, width: 1, height: 1 },
      }],
    }],
  };
  await listeners.get("agent/pre-step")[0](
    { agent, messages: [toolImage], turn: 1, step: 2, signal },
    async () => ({ kind: "enter", messages: [toolImage] }),
  );
  assert.equal(
    calls.filter((call) => call.provider === "vision-provider").length,
    visionCallsBeforeToolImage,
  );

  calls.push({ marker: "separator" });
  const laterMessages = [...decision.messages, {
    id: "a1",
    role: "assistant",
    source: { kind: "model", provider: "deepseek-official", model: "deepseek-model" },
    content: [{ type: "text", text: "done" }],
  }];
  const later = listeners.get("llm/stream")[0](
    {
      provider: "deepseek-official",
      model: "deepseek-model",
      messages: laterMessages,
      tools: [{ name: "run_code", description: "execute tool program", parameters: {} }],
    },
    () => { throw new Error("historical image request was not intercepted"); },
  );
  await Array.fromAsync(later);
  assert.equal(calls.at(-1).tools.length, 1);

  listeners.get("agent/turn-stopping")[0]({ agent, turn: 1 });
  assert.equal(
    (await preExecute({ agent, name: "read_image", arguments: { path: "/tmp/a.png" } }, allow)).kind,
    "allow",
  );

  cleanup();
  assert.deepEqual(
    (await llm.resolveModelInfo("deepseek-official", "deepseek-model")).inputModalities,
    ["text"],
  );
});

test("retries vision failures, then fails closed without calling DeepSeek", async () => {
  const listeners = new Map();
  const calls = [];
  const llm = {
    async resolveModelInfo(provider, model) {
      return { provider, id: model, inputModalities: ["text"] };
    },
    async listModels() { return []; },
    stream(options) {
      calls.push(options);
      if (options.provider === "vision-provider") {
        return chunks([{ type: "finish", reason: { kind: "error", failure: { message: "terminated" } } }]);
      }
      throw new Error("DeepSeek must not run after failed vision analysis");
    },
  };
  const ctx = {
    llm,
    effect(install) { install(); },
    on(name, callback) {
      const list = listeners.get(name) || [];
      list.push(callback);
      listeners.set(name, list);
    },
  };
  plugin._test.applyWithFactory(ctx, {
    visionProvider: "vision-provider",
    visionModel: "vision-model",
    visionAttempts: 2,
    sourceProviders: ["deepseek-official"],
  }, createUserMessage);

  const image = {
    id: "u-failure",
    role: "user",
    source: { kind: "user" },
    content: [{
      type: "image",
      attachment: { attachmentId: "failure-image", mediaType: "image/png", bytes: 1, width: 1, height: 1 },
    }],
  };
  const agent = { options: { provider: "deepseek-official" } };
  const signal = new AbortController().signal;
  const decision = await listeners.get("agent/pre-step")[0](
    { agent, messages: [image], turn: 1, step: 1, signal },
    async () => ({ kind: "enter", messages: [image] }),
  );
  assert.equal(calls.filter((call) => call.provider === "vision-provider").length, 2);
  const failure = decision.messages.find((message) => message.source?.plugin === "dsh-image-router");
  assert.match(failure.content[0].text, /^\[视觉分析失败\]/);

  const safeFailure = listeners.get("llm/stream")[0]({
    provider: "deepseek-official",
    model: "deepseek-model",
    messages: decision.messages,
    tools: [{ name: "run_code", parameters: {} }],
  }, () => { throw new Error("failed vision request was not intercepted"); });
  const output = await Array.fromAsync(safeFailure);
  assert.match(output.find((chunk) => chunk.type === "text-delta").text, /本轮已安全停止/);
  assert.equal(calls.some((call) => call.provider === "deepseek-official"), false);
});
