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
  const signal = new AbortController().signal;
  const decision = await listeners.get("agent/pre-step")[0](
    { agent: { options: { provider: "deepseek-official" } }, messages: [image], signal },
    async () => ({ kind: "enter", messages: [image] }),
  );
  assert.equal(calls[0].provider, "vision-provider");
  assert.match(decision.messages[1].content[0].text, /测试图片描述/);

  const routed = listeners.get("llm/stream")[0](
    { provider: "deepseek-official", model: "deepseek-model", messages: decision.messages },
    () => { throw new Error("image request was not intercepted"); },
  );
  assert.equal(typeof routed[Symbol.asyncIterator], "function");
  assert.equal(typeof routed.then, "undefined");
  await Array.fromAsync(routed);
  assert.equal(JSON.stringify(calls.at(-1).messages).includes('"type":"image"'), false);
  assert.match(JSON.stringify(calls.at(-1).messages), /vision-model/);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).messages), /\$\{config\.visionModel\}/);

  cleanup();
  assert.deepEqual(
    (await llm.resolveModelInfo("deepseek-official", "deepseek-model")).inputModalities,
    ["text"],
  );
});
