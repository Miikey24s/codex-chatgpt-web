const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { ManagedInstance } = require("../electron/managed-instance.cjs");

function fakeInstance(id, port) {
  return {
    id,
    name: id === "primary" ? "Primary" : "Work 2",
    port,
    coreHome: path.resolve("C:/tmp", id),
    browserPartition: id === "primary" ? "persist:codex-web-gpt-chatgpt" : `persist:codex-web-gpt-${id}`,
    enabled: true,
    createdAt: new Date(0).toISOString(),
  };
}

function harness() {
  const events = [];
  class FakeControl {
    constructor(options) { this.options = options; this.closed = false; }
    async start() { events.push("control:start"); return this; }
    descriptor() { return { endpoint: "http://127.0.0.1:1000", token: "x".repeat(48) }; }
    async close() { this.closed = true; events.push("control:close"); }
  }
  class FakeSupervisor {
    constructor(options) { this.options = options; this.shutdowns = []; this.starts = 0; this.stops = 0; this.restarts = 0; }
    async startIfConfigured() { this.starts++; return { status: "ready" }; }
    async stopForSetup() { this.stops++; return { status: "stopped" }; }
    async restart() { this.restarts++; return { status: "ready" }; }
    async shutdown(options) { this.shutdowns.push(options); events.push("runtime:shutdown"); }
    cancelBrowserTurn() {}
  }
  class FakeRuntimeHost {
    constructor(options) { this.options = options; }
    currentOperation() { return null; }
    runtimeConfigSnapshot() { return { configured: true }; }
    browserConnectorName() { return "Codex"; }
    capturePasskeyLogin() {}
  }
  class FakeBrowserHost {
    constructor(options) { this.options = options; this.destroyed = false; }
    async ready() { events.push("browser:ready"); }
    currentOperation() { return null; }
    snapshot() { return { status: "ready" }; }
    async persistSession() { events.push("browser:persist"); }
    destroy() { this.destroyed = true; events.push("browser:destroy"); }
  }
  return { events, FakeControl, FakeSupervisor, FakeRuntimeHost, FakeBrowserHost };
}

test("managed instances own independent runtime browser and control lifecycles", async () => {
  const first = harness();
  const second = harness();
  const stateStore = { read: () => ({ browserInteractionMode: "automatic" }) };
  const common = {
    app: {}, launcherProfile: "production", codexHome: path.resolve("C:/codex"), userData: path.resolve("C:/launcher"),
    window: {}, cdpPort: 9222, browserHelperPath: path.resolve("C:/helper.cjs"), sourceRoot: path.resolve("C:/repo"),
    installedRuntimeRoot: path.resolve("C:/runtime"), runtimeRootProvider: () => path.resolve("C:/runtime"), logger: {},
    stateStore, sessionForPartition: partition => ({ resolveProxy: async () => partition }), showWindow() {},
  };
  const a = new ManagedInstance({
    ...common, instance: fakeInstance("primary", 17841), browserControlClass: first.FakeControl,
    runtimeSupervisorClass: first.FakeSupervisor, runtimeHostClass: first.FakeRuntimeHost, browserHostClass: first.FakeBrowserHost,
  });
  const b = new ManagedInstance({
    ...common, instance: fakeInstance("instance-2", 17842), browserControlClass: second.FakeControl,
    runtimeSupervisorClass: second.FakeSupervisor, runtimeHostClass: second.FakeRuntimeHost, browserHostClass: second.FakeBrowserHost,
  });

  await Promise.all([a.initialize(), b.initialize()]);
  assert.notEqual(a.runtimeSupervisor, b.runtimeSupervisor);
  assert.notEqual(a.browserHost, b.browserHost);
  assert.equal(a.runtimeSupervisor.options.coreHome, fakeInstance("primary", 17841).coreHome);
  assert.equal(b.runtimeSupervisor.options.coreHome, fakeInstance("instance-2", 17842).coreHome);
  assert.equal(a.snapshot().port, 17841);
  assert.equal(b.snapshot().port, 17842);

  assert.deepEqual(await b.startRuntime(), { status: "ready" });
  assert.deepEqual(await b.stopRuntime(), { status: "stopped" });
  assert.deepEqual(await b.restartRuntime(), { status: "ready" });
  assert.equal(b.runtimeSupervisor.starts, 1);
  assert.equal(b.runtimeSupervisor.stops, 1);
  assert.equal(b.runtimeSupervisor.restarts, 1);

  await b.shutdown();
  assert.deepEqual(second.events.slice(-4), ["runtime:shutdown", "browser:persist", "browser:destroy", "control:close"]);
  assert.equal(first.FakeBrowserHost?.destroyed, undefined);
  assert.equal(a.initialized, true);
});

test("managed instance forwards operation and browser state with its instance id", async () => {
  const h = harness();
  const operations = [];
  const browsers = [];
  const managed = new ManagedInstance({
    app: {}, instance: fakeInstance("instance-2", 17842), launcherProfile: "production",
    codexHome: path.resolve("C:/codex"), userData: path.resolve("C:/launcher"), window: {}, cdpPort: 9222,
    browserHelperPath: path.resolve("C:/helper.cjs"), sourceRoot: path.resolve("C:/repo"), installedRuntimeRoot: path.resolve("C:/runtime"),
    runtimeRootProvider: () => path.resolve("C:/runtime"), logger: {},
    stateStore: { read: () => ({ browserInteractionMode: "automatic" }) },
    sessionForPartition: () => ({ resolveProxy: async () => "DIRECT" }),
    publishOperation: operation => operations.push(operation), publishBrowserState: (...args) => browsers.push(args), showWindow() {},
    browserControlClass: h.FakeControl, runtimeSupervisorClass: h.FakeSupervisor,
    runtimeHostClass: h.FakeRuntimeHost, browserHostClass: h.FakeBrowserHost,
  });
  await managed.initialize();
  managed.runtimeSupervisor.options.publishOperation({ name: "start", status: "running", message: "starting" });
  managed.browserHost.options.publishState({ status: "ready" });
  assert.deepEqual(operations, [{ name: "start", status: "running", message: "starting", instanceId: "instance-2" }]);
  assert.deepEqual(browsers, [["instance-2", { status: "ready" }]]);
});
