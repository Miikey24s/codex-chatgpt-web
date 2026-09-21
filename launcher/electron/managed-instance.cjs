const path = require("node:path");

const { BrowserHost } = require("./browser-host.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");

function scopedLogger(logger, instanceId) {
  if (!logger || typeof logger !== "object") return logger;
  const withInstance = (detail) => ({
    ...(detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {}),
    instanceId,
  });
  return {
    ...logger,
    debug: (event, detail) => logger.debug?.(event, withInstance(detail)),
    info: (event, detail) => logger.info?.(event, withInstance(detail)),
    warn: (event, detail) => logger.warn?.(event, withInstance(detail)),
    error: (event, detail) => logger.error?.(event, withInstance(detail)),
  };
}

class ManagedInstance {
  constructor({
    app,
    instance,
    launcherProfile,
    codexHome,
    userData,
    window,
    cdpPort,
    browserHelperPath,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    logger,
    stateStore,
    sessionForPartition,
    publishOperation,
    publishBrowserState,
    showWindow,
    isDevProfile = false,
    browserHostClass = BrowserHost,
    browserControlClass = BrowserControlServer,
    runtimeHostClass = RuntimeHost,
    runtimeSupervisorClass = RuntimeSupervisor,
  }) {
    if (!instance || typeof instance.id !== "string") throw new Error("Managed instance metadata is required");
    if (!stateStore || typeof stateStore.read !== "function") throw new Error("Managed instance state store is required");
    if (typeof sessionForPartition !== "function") throw new Error("Managed instance session resolver is required");

    this.app = app;
    this.instance = structuredClone(instance);
    this.launcherProfile = launcherProfile;
    this.codexHome = codexHome;
    this.userData = userData;
    this.window = window;
    this.cdpPort = cdpPort;
    this.browserHelperPath = browserHelperPath;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.logger = scopedLogger(logger, this.instance.id);
    this.stateStore = stateStore;
    this.sessionForPartition = sessionForPartition;
    this.publishOperation = publishOperation;
    this.publishBrowserState = publishBrowserState;
    this.showWindow = showWindow;
    this.isDevProfile = isDevProfile;
    this.browserHostClass = browserHostClass;
    this.browserControlClass = browserControlClass;
    this.runtimeHostClass = runtimeHostClass;
    this.runtimeSupervisorClass = runtimeSupervisorClass;
    this.browserDescriptorPath = path.join(this.instance.coreHome, "runtime", "launcher-browser.json");
    this.browserHost = null;
    this.browserControl = null;
    this.runtimeHost = null;
    this.runtimeSupervisor = null;
    this.initialized = false;
  }

  operation(operation) {
    if (!operation) return;
    this.publishOperation?.({ ...operation, instanceId: this.instance.id });
  }

  async initialize() {
    if (this.initialized) return this;
    this.browserControl = await new this.browserControlClass({
      logger: this.logger,
      getBrowserHost: () => this.browserHost,
      getPreferences: () => this.stateStore.read(),
      resolveProxy: url => this.sessionForPartition(this.instance.browserPartition).resolveProxy(url),
    }).start();
    this.runtimeSupervisor = new this.runtimeSupervisorClass({
      app: this.app,
      logger: this.logger,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      runtimeRootProvider: this.runtimeRootProvider,
      coreHome: this.instance.coreHome,
      browserDescriptorPath: this.browserDescriptorPath,
      launcherProfile: this.launcherProfile,
      publishOperation: operation => this.operation(operation),
    });
    this.runtimeHost = new this.runtimeHostClass({
      app: this.app,
      logger: this.logger,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      runtimeRootProvider: this.runtimeRootProvider,
      browserDescriptorPath: this.browserDescriptorPath,
      coreHome: this.instance.coreHome,
      codexHome: this.codexHome,
      userData: this.userData,
      instancePort: this.instance.port,
      instanceId: this.instance.id,
      launcherProfile: this.launcherProfile,
      publishOperation: operation => this.operation(operation),
      supervisor: this.runtimeSupervisor,
      getBrowserInteractionMode: () => this.stateStore.read().browserInteractionMode,
    });
    this.browserHost = new this.browserHostClass({
      window: this.window,
      descriptorPath: this.browserDescriptorPath,
      cdpPort: this.cdpPort,
      control: this.browserControl.descriptor(),
      cancelTurn: this.isDevProfile
        ? undefined
        : (traceId, reason) => this.runtimeSupervisor.cancelBrowserTurn(traceId, reason),
      getConnectorName: () => this.runtimeHost.browserConnectorName(),
      helper: { executable: process.execPath, script: this.browserHelperPath },
      instanceId: this.instance.id,
      logger: this.logger,
      loginWithPasskey: () => this.runtimeHost.capturePasskeyLogin(),
      partition: this.instance.browserPartition,
      profile: this.launcherProfile,
      publishState: state => this.publishBrowserState?.(this.instance.id, state),
      showWindow: this.showWindow,
      getBrowserInteractionMode: () => this.stateStore.read().browserInteractionMode,
    });
    await this.browserHost.ready();
    this.initialized = true;
    return this;
  }

  currentOperation() {
    return this.runtimeHost?.currentOperation() || this.browserHost?.currentOperation() || null;
  }

  snapshot() {
    return {
      id: this.instance.id,
      name: this.instance.name,
      port: this.instance.port,
      enabled: this.instance.enabled,
      coreHome: this.instance.coreHome,
      browserPartition: this.instance.browserPartition,
      browser: this.browserHost?.snapshot() ?? null,
      configured: this.runtimeHost?.runtimeConfigSnapshot().configured ?? false,
      operation: this.currentOperation(),
    };
  }

  async startRuntime() {
    await this.initialize();
    return this.runtimeSupervisor.startIfConfigured();
  }

  async stopRuntime() {
    if (!this.initialized) return { status: "stopped" };
    return this.runtimeSupervisor.stopForSetup();
  }

  async restartRuntime() {
    await this.initialize();
    return this.runtimeSupervisor.restart();
  }

  async shutdown({ cancelActiveTurns = true, force = true } = {}) {
    const activeOperation = this.currentOperation();
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before stopping ${this.instance.name}`);
    }
    await this.runtimeSupervisor?.shutdown({ cancelActiveTurns, force });
    await this.browserHost?.persistSession();
    this.browserHost?.destroy();
    await this.browserControl?.close();
    this.initialized = false;
  }
}

module.exports = { ManagedInstance, scopedLogger };
