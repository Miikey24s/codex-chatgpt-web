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

export function syncCockpitProvidersFile(bridgePort = 17841, cockpitHome = getCockpitHome()): boolean {
  const providersFile = join(cockpitHome, "codex_model_providers.json");
  if (!existsSync(providersFile)) return false;

  try {
    const providers = JSON.parse(readFileSync(providersFile, "utf8")) as Array<{
      id: string;
      name: string;
      baseUrl: string;
      modelCatalog: string[];
      supportsVision?: boolean;
      wireApi?: string;
      supportsWebsockets?: boolean;
      enableModePreference?: string;
      apiKeys?: Array<{ id: string; name: string; apiKey: string }>;
    }>;

    const expectedUrl = `http://127.0.0.1:${bridgePort}/v1`;
    let found = false;
    for (const provider of providers) {
      if (provider.name === "Codex Web GPT" || provider.baseUrl === expectedUrl) {
        found = true;
        provider.baseUrl = expectedUrl;
        provider.modelCatalog = ["chatgpt-web/high"];
        break;
      }
    }

    if (!found) {
      providers.push({
        id: `cmp_${Date.now()}_cockpit_web_gpt`,
        name: "Codex Web GPT",
        baseUrl: expectedUrl,
        modelCatalog: ["chatgpt-web/high"],
        supportsVision: false,
        wireApi: "responses",
        supportsWebsockets: false,
        enableModePreference: "direct",
        apiKeys: [
          {
            id: `cmk_${Date.now()}_1`,
            name: "Local Bridge",
            apiKey: "local",
          },
        ],
      });
    }

    writeFileSync(providersFile, `${JSON.stringify(providers, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
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
  const providersFile = join(cockpitHome, "codex_model_providers.json");
  const localAccessFile = join(cockpitHome, "codex_local_access.json");
  if (!existsSync(providersFile) || !existsSync(localAccessFile)) return false;

  try {
    const providers = JSON.parse(readFileSync(providersFile, "utf8")) as CockpitModelProvider[];
    const expectedUrl = `http://127.0.0.1:${bridgePort}/v1`;
    const webProvider = providers.find(item => item.name === "Codex Web GPT" || item.baseUrl === expectedUrl);
    const webAccountIds = providerAccountIds(webProvider);
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
    return true;
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

/**
 * Canonical Cockpit integration policy. Electron must call this through the core
 * CLI instead of maintaining a second routing implementation.
 */
export function syncCockpitIntegration(bridgePort = 17841): CockpitSyncResult {
  const providerConfigured = syncCockpitProvidersFile(bridgePort);
  const routingIsolated = syncCockpitRoutingRules(bridgePort);
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
