import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCodexHome } from "./codex-integration-shared";

export interface CockpitAuthInfo {
  present: boolean;
  email?: string;
  name?: string;
  planType?: string;
  accountId?: string;
  accessToken?: string;
  idToken?: string;
  refreshToken?: string;
  lastRefresh?: string;
  valid: boolean;
}

export function getCockpitHome(): string {
  return process.env.ANTIGRAVITY_COCKPIT_HOME?.trim() || join(homedir(), ".antigravity_cockpit");
}

/** Resolve Cockpit's loopback Local Access endpoint without exposing any account credentials. */
export function cockpitLocalAccessBaseUrl(cockpitHome = getCockpitHome()): string {
  const localAccessFile = join(cockpitHome, "codex_local_access.json");
  if (!existsSync(localAccessFile)) {
    throw new Error(`Cockpit Local Access configuration is missing: ${localAccessFile}`);
  }
  let port: unknown;
  try {
    const parsed = JSON.parse(readFileSync(localAccessFile, "utf8")) as { port?: unknown };
    port = parsed.port;
  } catch (error) {
    throw new Error(
      `Cockpit Local Access configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new Error("Cockpit Local Access configuration has an invalid port");
  }
  return `http://127.0.0.1:${port}/v1`;
}

export function isCockpitActive(): boolean {
  const codexHome = getCodexHome();
  const cockpitAuthFile = join(codexHome, ".cockpit_codex_auth.json");
  const cockpitCatalogConfigFile = join(codexHome, ".cockpit-experimental-model-catalog-config.json");
  return existsSync(cockpitAuthFile) || existsSync(cockpitCatalogConfigFile);
}

export function readCockpitAuth(): CockpitAuthInfo {
  if (!isCockpitActive()) {
    return { present: false, valid: false };
  }
  const authFile = join(getCodexHome(), "auth.json");
  if (!existsSync(authFile)) {
    return { present: false, valid: false };
  }
  try {
    const content = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    const tokens = (content.tokens ?? {}) as Record<string, unknown>;
    const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
    const accountId = typeof tokens.account_id === "string" ? tokens.account_id : undefined;
    const lastRefresh = typeof content.last_refresh === "string" ? content.last_refresh : undefined;

    let email: string | undefined;
    let name: string | undefined;
    let planType: string | undefined;

    if (idToken || accessToken) {
      const jwtPart = (idToken || accessToken)!.split(".")[1];
      if (jwtPart) {
        try {
          const payload = JSON.parse(Buffer.from(jwtPart, "base64").toString("utf8")) as Record<string, unknown>;
          email = typeof payload.email === "string" ? payload.email : undefined;
          name = typeof payload.name === "string" ? payload.name : undefined;
          const authObj = (payload["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
          planType = typeof authObj.chatgpt_plan_type === "string" ? authObj.chatgpt_plan_type : undefined;
        } catch {}
      }
    }

    const valid = Boolean(accessToken && accessToken.length > 20);
    return {
      present: true,
      email,
      name,
      planType,
      accountId,
      accessToken,
      idToken,
      refreshToken,
      lastRefresh,
      valid,
    };
  } catch {
    return { present: false, valid: false };
  }
}

export function syncCockpitModelCatalog(): boolean {
  const catalogConfigFile = join(getCodexHome(), ".cockpit-experimental-model-catalog-config.json");
  const activeCatalogFile = join(getCodexHome(), "cockpit-model-catalog.json");
  const activeCatalogHasWebModel = (): boolean => {
    if (!existsSync(activeCatalogFile)) return false;
    try {
      const content = JSON.parse(readFileSync(activeCatalogFile, "utf8")) as {
        models?: Array<{ slug?: string; id?: string; model_id?: string }>;
      };
      return (content.models ?? []).some(model => (
        model.slug === COCKPIT_WEB_MODEL
        || model.id === COCKPIT_WEB_MODEL
        || model.model_id === COCKPIT_WEB_MODEL
      ));
    } catch {
      return false;
    }
  };

  // Newer Cockpit releases own the active Codex catalog. If it already contains our
  // provider model, do not rewrite Cockpit-generated model metadata.
  if (!existsSync(catalogConfigFile)) return activeCatalogHasWebModel();

  try {
    const content = JSON.parse(readFileSync(catalogConfigFile, "utf8")) as {
      version?: number;
      models?: Array<{
        model_id: string;
        display_name: string;
        reasoning_efforts?: string[];
      }>;
      default_model_id?: string;
    };

    content.models ??= [];
    // Only keep chatgpt-web/high as requested by user
    const target = {
      model_id: "chatgpt-web/high",
      display_name: "Codex Web GPT",
      reasoning_efforts: ["high"],
    };

    // Remove legacy light/medium if user prefers single high model
    content.models = content.models.filter(m => m.model_id !== "chatgpt-web/light" && m.model_id !== "chatgpt-web/medium");

    const existing = content.models.find(m => m.model_id === target.model_id);
    if (!existing) {
      content.models.push(target);
    } else {
      existing.display_name = target.display_name;
    }

    const next = `${JSON.stringify(content, null, 2)}\n`;
    if (next !== readFileSync(catalogConfigFile, "utf8")) {
      writeFileSync(catalogConfigFile, next, "utf8");
    }
    return true;
  } catch {
    return activeCatalogHasWebModel();
  }
}

export interface CockpitWebInstance {
  id: string;
  name: string;
  port: number;
  enabled?: boolean;
}

interface CockpitProviderApiKey {
  id: string;
  name: string;
  apiKey: string;
}

interface CockpitProviderDocument {
  id: string;
  name: string;
  baseUrl: string;
  modelCatalog: string[];
  supportsVision?: boolean;
  wireApi?: string;
  supportsWebsockets?: boolean;
  enableModePreference?: string;
  apiKeys?: CockpitProviderApiKey[];
}

const MANAGED_PROVIDER_ID_PREFIX = "cmp_webgpt_";
const MANAGED_PROVIDER_NAME_PREFIX = "Codex Web GPT · ";

function validateCockpitWebInstances(instances: CockpitWebInstance[]): CockpitWebInstance[] {
  const enabled = instances.filter(instance => instance.enabled !== false).map(instance => ({ ...instance }));
  const ids = new Set<string>();
  const ports = new Set<number>();
  for (const instance of enabled) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(instance.id)) throw new Error(`Invalid Web GPT instance id: ${instance.id}`);
    if (typeof instance.name !== "string" || !instance.name.trim() || instance.name.length > 80) {
      throw new Error(`Invalid Web GPT instance name: ${instance.id}`);
    }
    if (!Number.isSafeInteger(instance.port) || instance.port < 1 || instance.port > 65_535) {
      throw new Error(`Invalid Web GPT instance port: ${instance.id}`);
    }
    if (ids.has(instance.id)) throw new Error(`Duplicate Web GPT instance id: ${instance.id}`);
    if (ports.has(instance.port)) throw new Error(`Duplicate Web GPT instance port: ${instance.port}`);
    ids.add(instance.id);
    ports.add(instance.port);
  }
  return enabled;
}

function managedProviderId(instanceId: string): string {
  return `${MANAGED_PROVIDER_ID_PREFIX}${instanceId.replace(/-/g, "_")}`;
}

function managedProviderName(instance: CockpitWebInstance): string {
  return instance.id === "primary" ? "Codex Web GPT" : `${MANAGED_PROVIDER_NAME_PREFIX}${instance.name.trim()}`;
}

function managedProviderUrl(instance: CockpitWebInstance): string {
  return `http://127.0.0.1:${instance.port}/v1`;
}

function defaultProviderApiKey(instance: CockpitWebInstance): CockpitProviderApiKey {
  const suffix = instance.id.replace(/[^a-z0-9-]/g, "-");
  return {
    id: `cmk_webgpt_${suffix.replace(/-/g, "_")}`,
    name: instance.id === "primary" ? "Local Bridge" : instance.name.trim(),
    apiKey: instance.id === "primary" ? "local" : `local-webgpt-${suffix}`,
  };
}

function isManagedPoolProvider(provider: CockpitProviderDocument): boolean {
  return provider.id?.startsWith(MANAGED_PROVIDER_ID_PREFIX)
    || provider.name === "Codex Web GPT"
    || provider.name?.startsWith(MANAGED_PROVIDER_NAME_PREFIX);
}

export function syncCockpitProvidersPool(
  rawInstances: CockpitWebInstance[],
  cockpitHome = getCockpitHome(),
): boolean {
  const providersFile = join(cockpitHome, "codex_model_providers.json");
  if (!existsSync(providersFile)) return false;

  try {
    const original = readFileSync(providersFile, "utf8");
    const providers = JSON.parse(original) as CockpitProviderDocument[];
    if (!Array.isArray(providers)) return false;
    const instances = validateCockpitWebInstances(rawInstances);
    const desiredUrls = new Map(instances.map(instance => [managedProviderUrl(instance), instance]));
    const desiredIds = new Map(instances.map(instance => [managedProviderId(instance.id), instance]));
    const claimed = new Set<string>();
    const claimedApiKeys = new Set<string>();
    const next: CockpitProviderDocument[] = [];

    for (const provider of providers) {
      let instance = desiredIds.get(provider.id) ?? desiredUrls.get(provider.baseUrl);
      if (!instance && provider.name === "Codex Web GPT") {
        instance = instances.find(candidate => candidate.id === "primary");
      }
      if (!instance) {
        if (!isManagedPoolProvider(provider)) next.push(provider);
        continue;
      }
      if (claimed.has(instance.id)) continue;
      claimed.add(instance.id);
      const expectedKey = defaultProviderApiKey(instance);
      const apiKeys = (provider.apiKeys ?? []).filter(
        item => typeof item.apiKey === "string" && item.apiKey.trim() && !claimedApiKeys.has(item.apiKey.trim()),
      );
      for (const item of apiKeys) claimedApiKeys.add(item.apiKey.trim());
      const effectiveKeys = apiKeys.length > 0 ? apiKeys : [expectedKey];
      if (apiKeys.length === 0) claimedApiKeys.add(expectedKey.apiKey);
      next.push({
        ...provider,
        id: managedProviderId(instance.id),
        name: managedProviderName(instance),
        baseUrl: managedProviderUrl(instance),
        modelCatalog: ["chatgpt-web/high"],
        supportsVision: false,
        wireApi: "responses",
        supportsWebsockets: false,
        enableModePreference: "direct",
        apiKeys: effectiveKeys,
      });
    }

    for (const instance of instances) {
      if (claimed.has(instance.id)) continue;
      next.push({
        id: managedProviderId(instance.id),
        name: managedProviderName(instance),
        baseUrl: managedProviderUrl(instance),
        modelCatalog: [COCKPIT_WEB_MODEL],
        supportsVision: false,
        wireApi: "responses",
        supportsWebsockets: false,
        enableModePreference: "direct",
        apiKeys: [defaultProviderApiKey(instance)],
      });
    }

    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (serialized !== original) writeFileSync(providersFile, serialized, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function syncCockpitProvidersFile(bridgePort = 17841, cockpitHome = getCockpitHome()): boolean {
  return syncCockpitProvidersPool([{ id: "primary", name: "Primary", port: bridgePort }], cockpitHome);
}

interface CockpitAccountModelRule {
  accountId: string;
  excludedModels: string[];
}

interface CockpitLocalAccessConfig {
  accountIds?: string[];
  accountModelRules?: CockpitAccountModelRule[];
}

interface CockpitModelProvider {
  name?: string;
  baseUrl?: string;
  modelCatalog?: string[];
  apiKeys?: Array<{ apiKey?: string }>;
}

const COCKPIT_WEB_MODEL = "chatgpt-web/high";
const OAUTH_EXCLUSIONS = ["chatgpt-web/*"];
const COCKPIT_WEB_EXCLUSIONS = ["gpt-*", "codex-*"];
const LEGACY_AURORA_EXCLUSIONS = ["gpt-5-6-thinking", "gpt-5.*", "gpt-image-*"];
const MANAGED_EXCLUSIONS = new Set([
  COCKPIT_WEB_MODEL,
  ...OAUTH_EXCLUSIONS,
  ...COCKPIT_WEB_EXCLUSIONS,
  ...LEGACY_AURORA_EXCLUSIONS,
].map(model => model.toLowerCase()));

function cockpitApiKeyAccountId(apiKey: string): string {
  return `codex_apikey_${createHash("md5").update(apiKey).digest("hex")}`;
}

function providerAccountIds(provider: CockpitModelProvider | undefined): Set<string> {
  return new Set(
    (provider?.apiKeys ?? [])
      .map(item => item.apiKey?.trim())
      .filter((apiKey): apiKey is string => Boolean(apiKey))
      .map(cockpitApiKeyAccountId),
  );
}

/**
 * Keep each model family on its intended credential type:
 * - native Codex models -> OAuth accounts
 * - chatgpt-web/high -> local Codex Web GPT provider
 *
 * Cockpit pools every enabled credential by default. Per-account model
 * exclusions are therefore the deterministic routing boundary.
 */
export function syncCockpitRoutingRules(
  bridgePort = 17841,
  cockpitHome = getCockpitHome(),
): boolean {
  return syncCockpitPoolRoutingRules([{ id: "primary", name: "Primary", port: bridgePort }], cockpitHome);
}

export function syncCockpitPoolRoutingRules(
  rawInstances: CockpitWebInstance[],
  cockpitHome = getCockpitHome(),
): boolean {
  const providersFile = join(cockpitHome, "codex_model_providers.json");
  const localAccessFile = join(cockpitHome, "codex_local_access.json");
  if (!existsSync(providersFile) || !existsSync(localAccessFile)) return false;

  try {
    const instances = validateCockpitWebInstances(rawInstances);
    const expectedUrls = new Set(instances.map(managedProviderUrl));
    const providers = JSON.parse(readFileSync(providersFile, "utf8")) as CockpitModelProvider[];
    const webProviders = providers.filter(item => item.baseUrl && expectedUrls.has(item.baseUrl));
    const webAccountIds = new Set(webProviders.flatMap(provider => [...providerAccountIds(provider)]));
    if (webAccountIds.size === 0) return false;

    const config = JSON.parse(readFileSync(localAccessFile, "utf8")) as CockpitLocalAccessConfig;
    const accountIds = [...new Set((config.accountIds ?? []).map(id => id.trim()).filter(Boolean))];
    const activeWebAccountIds = new Set(accountIds.filter(id => webAccountIds.has(id)));
    if (activeWebAccountIds.size === 0) return false;

    const previousRules = config.accountModelRules ?? [];
    const previousByAccount = new Map(previousRules.map(rule => [rule.accountId, rule]));
    const nextRules: CockpitAccountModelRule[] = [];

    for (const accountId of accountIds) {
      const previous = previousByAccount.get(accountId);
      const exclusions = (previous?.excludedModels ?? [])
        .filter(model => !MANAGED_EXCLUSIONS.has(model.trim().toLowerCase()));
      if (activeWebAccountIds.has(accountId)) {
        exclusions.push(...COCKPIT_WEB_EXCLUSIONS);
      } else {
        exclusions.push(...OAUTH_EXCLUSIONS);
      }
      if (exclusions.length > 0) nextRules.push({ accountId, excludedModels: exclusions });
    }

    config.accountModelRules = nextRules;
    const next = `${JSON.stringify(config, null, 2)}\n`;
    if (next !== readFileSync(localAccessFile, "utf8")) {
      writeFileSync(localAccessFile, next, "utf8");
    }
    return activeWebAccountIds.size === webAccountIds.size;
  } catch {
    return false;
  }
}

export interface CockpitSyncResult {
  ok: boolean;
  providerConfigured: boolean;
  routingIsolated: boolean;
  catalogSynced: boolean;
  message: string;
}

function defaultInstanceRegistryPath(cockpitHome = getCockpitHome()): string {
  if (process.env.CODEX_CHATGPT_WEB_INSTANCES_FILE) {
    return process.env.CODEX_CHATGPT_WEB_INSTANCES_FILE;
  }
  if (process.env.ANTIGRAVITY_COCKPIT_HOME) {
    return join(cockpitHome, "instances.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Codex Web GPT", "instances.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Codex Web GPT", "instances.json");
  }
  return join(homedir(), ".config", "Codex Web GPT", "instances.json");
}

function loadPersistedCockpitWebInstances(fallbackPort = 17841, cockpitHome = getCockpitHome()): CockpitWebInstance[] {
  try {
    const registryPath = defaultInstanceRegistryPath(cockpitHome);
    if (existsSync(registryPath)) {
      const data = JSON.parse(readFileSync(registryPath, "utf8")) as { instances?: CockpitWebInstance[] };
      if (Array.isArray(data.instances) && data.instances.length > 0) {
        return data.instances.filter(i => i.enabled !== false);
      }
    }
  } catch {
    // fallback below
  }
  return [{ id: "primary", name: "Primary", port: fallbackPort }];
}

/**
 * Canonical Cockpit integration policy. Electron must call this through the core
 * CLI instead of maintaining a second routing implementation.
 */
export function syncCockpitIntegration(bridgePort = 17841, cockpitHome = getCockpitHome()): CockpitSyncResult {
  const instances = loadPersistedCockpitWebInstances(bridgePort, cockpitHome);
  return syncCockpitInstancePool(instances, cockpitHome);
}

export function syncCockpitInstancePool(instances: CockpitWebInstance[], cockpitHome = getCockpitHome()): CockpitSyncResult {
  const providerConfigured = syncCockpitProvidersPool(instances, cockpitHome);
  const routingIsolated = syncCockpitPoolRoutingRules(instances, cockpitHome);
  const catalogSynced = syncCockpitModelCatalog();
  const ok = providerConfigured && routingIsolated && catalogSynced;
  return {
    ok,
    providerConfigured,
    routingIsolated,
    catalogSynced,
    message: ok
      ? "Cockpit provider, routing rules, and model catalog synchronized"
      : "Cockpit synchronization is incomplete; run diagnostics for the missing component",
  };
}
