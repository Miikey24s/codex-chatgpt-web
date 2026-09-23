import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  syncCockpitIntegration,
  syncCockpitModelCatalog,
  syncCockpitPoolRoutingRules,
  syncCockpitProvidersPool,
  syncCockpitRoutingRules,
} from "../src/cockpit";

const PLUS_WEB_MODELS = ["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol"];

function accountId(apiKey: string): string {
  return `codex_apikey_${createHash("md5").update(apiKey).digest("hex")}`;
}

describe("Cockpit model routing", () => {
  test("syncs an enabled Web GPT pool without touching unrelated providers", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-web-cockpit-pool-"));
    try {
      writeFileSync(join(home, "codex_model_providers.json"), JSON.stringify([
        {
          id: "cmp_native_custom",
          name: "Custom Responses Provider",
          baseUrl: "http://127.0.0.1:18000/v1",
          modelCatalog: ["custom/model"],
          apiKeys: [{ id: "native-key", name: "Native", apiKey: "native-secret" }],
        },
        {
          id: "cmp_webgpt_primary",
          name: "Codex Web GPT",
          baseUrl: "http://127.0.0.1:17841/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ id: "primary-key", name: "Primary", apiKey: "primary-secret" }],
        },
        {
          id: "cmp_webgpt_stale",
          name: "Codex Web GPT · Stale",
          baseUrl: "http://127.0.0.1:17999/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ id: "stale-key", name: "Stale", apiKey: "stale-secret" }],
        },
      ]));

      expect(syncCockpitProvidersPool([
        { id: "primary", name: "Primary", port: 17841 },
        { id: "instance-2", name: "Work 2", port: 17842 },
        { id: "instance-3", name: "Work 3", port: 17843, enabled: false },
      ], home)).toBe(true);

      const providers = JSON.parse(readFileSync(join(home, "codex_model_providers.json"), "utf8"));
      expect(providers).toHaveLength(3);
      expect(providers[0]).toEqual({
        id: "cmp_native_custom",
        name: "Custom Responses Provider",
        baseUrl: "http://127.0.0.1:18000/v1",
        modelCatalog: ["custom/model"],
        apiKeys: [{ id: "native-key", name: "Native", apiKey: "native-secret" }],
      });
      expect(providers[1].name).toBe("Codex Web GPT");
      expect(providers[1].baseUrl).toBe("http://127.0.0.1:17841/v1");
      expect(providers[1].modelCatalog).toEqual(PLUS_WEB_MODELS);
      expect(providers[1].apiKeys).toEqual([{ id: "primary-key", name: "Primary", apiKey: "primary-secret" }]);
      expect(providers[2]).toMatchObject({
        id: "cmp_webgpt_instance_2",
        name: "Codex Web GPT · Work 2",
        baseUrl: "http://127.0.0.1:17842/v1",
        modelCatalog: PLUS_WEB_MODELS,
        wireApi: "responses",
      });
      expect(providers[2].apiKeys).toEqual([{
        id: "cmk_webgpt_instance_2",
        name: "Work 2",
        apiKey: "local-webgpt-instance-2",
      }]);
      expect(providers.some((provider: { baseUrl?: string }) => provider.baseUrl?.includes("17843"))).toBe(false);
      expect(providers.some((provider: { baseUrl?: string }) => provider.baseUrl?.includes("17999"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("provider catalogs follow each managed instance capability without advertising locked models", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-web-cockpit-capabilities-"));
    try {
      writeFileSync(join(home, "codex_model_providers.json"), "[]\n");
      expect(syncCockpitProvidersPool([
        { id: "primary", name: "Primary", port: 17841, solAvailable: false },
        { id: "instance-2", name: "Plus", port: 17842, solAvailable: true, extraHighAvailable: true, proAvailable: false },
        { id: "instance-3", name: "Pro-capable", port: 17843, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      ], home)).toBe(true);

      const providers = JSON.parse(readFileSync(join(home, "codex_model_providers.json"), "utf8"));
      expect(providers.map((provider: { modelCatalog: string[] }) => provider.modelCatalog)).toEqual([
        ["chatgpt-web/gpt-5.6-luna"],
        PLUS_WEB_MODELS,
        [...PLUS_WEB_MODELS, "chatgpt-web/gpt-5.6-pro", "chatgpt-web/gpt-6-pro"],
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("experimental Cockpit catalog publishes the v6 union and replaces a legacy Web default", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-cockpit-catalog-"));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = root;
      const catalogPath = join(root, ".cockpit-experimental-model-catalog-config.json");
      writeFileSync(catalogPath, `${JSON.stringify({
        version: 1,
        default_model_id: "chatgpt-web/high",
        models: [
          { model_id: "native-custom", display_name: "Native custom", reasoning_efforts: ["high"] },
          { model_id: "chatgpt-web/light", display_name: "Legacy Instant", reasoning_efforts: ["low"] },
          { model_id: "chatgpt-web/high", display_name: "Legacy High", reasoning_efforts: ["high"] },
        ],
      }, null, 2)}\n`);

      expect(syncCockpitModelCatalog([
        { id: "primary", name: "Primary", port: 17841, solAvailable: true, proAvailable: false },
        { id: "instance-2", name: "Work", port: 17842, solAvailable: true, extraHighAvailable: true, proAvailable: false },
      ])).toBe(true);

      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(catalog.default_model_id).toBe("chatgpt-web/gpt-5.6-sol");
      expect(catalog.models).toEqual([
        { model_id: "native-custom", display_name: "Native custom", reasoning_efforts: ["high"] },
        { model_id: "chatgpt-web/gpt-5.6-sol-instant", display_name: "GPT-5.6 Sol Instant (Web)", reasoning_efforts: ["low"] },
        { model_id: "chatgpt-web/gpt-5.6-sol", display_name: "GPT-5.6 Sol (Web)", reasoning_efforts: ["medium", "high", "xhigh"] },
      ]);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routes every active Web GPT pool account and fails closed until all are active", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-web-cockpit-pool-routing-"));
    try {
      const primary = accountId("primary-secret");
      const work2 = accountId("work2-secret");
      writeFileSync(join(home, "codex_model_providers.json"), JSON.stringify([
        {
          id: "cmp_webgpt_primary",
          name: "Codex Web GPT",
          baseUrl: "http://127.0.0.1:17841/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ apiKey: "primary-secret" }],
        },
        {
          id: "cmp_webgpt_instance_2",
          name: "Codex Web GPT · Work 2",
          baseUrl: "http://127.0.0.1:17842/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ apiKey: "work2-secret" }],
        },
      ]));
      writeFileSync(join(home, "codex_local_access.json"), JSON.stringify({
        accountIds: ["oauth-a", primary],
        accountModelRules: [],
      }));

      const pool = [
        { id: "primary", name: "Primary", port: 17841 },
        { id: "instance-2", name: "Work 2", port: 17842 },
      ];
      expect(syncCockpitPoolRoutingRules(pool, home)).toBe(false);

      writeFileSync(join(home, "codex_local_access.json"), JSON.stringify({
        accountIds: ["oauth-a", primary, work2],
        accountModelRules: [
          { accountId: "oauth-a", excludedModels: ["native-custom"] },
          { accountId: work2, excludedModels: ["web-custom"] },
        ],
      }));
      expect(syncCockpitPoolRoutingRules(pool, home)).toBe(true);

      const config = JSON.parse(readFileSync(join(home, "codex_local_access.json"), "utf8"));
      expect(config.accountModelRules).toEqual([
        { accountId: "oauth-a", excludedModels: ["native-custom", "chatgpt-web/*"] },
        { accountId: primary, excludedModels: ["gpt-*", "codex-*"] },
        { accountId: work2, excludedModels: ["web-custom", "gpt-*", "codex-*"] },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps OAuth and Codex Web GPT model families isolated and cleans legacy Aurora exclusions", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-web-cockpit-"));
    try {
      const bridgeAccount = accountId("local-bridge-key");
      writeFileSync(join(home, "codex_model_providers.json"), JSON.stringify([
        {
          name: "Codex Web GPT",
          baseUrl: "http://127.0.0.1:17841/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ apiKey: "local-bridge-key" }],
        },
      ]));
      writeFileSync(join(home, "codex_local_access.json"), JSON.stringify({
        accountIds: ["oauth-a", bridgeAccount],
        accountModelRules: [
          { accountId: "oauth-a", excludedModels: ["gpt-5.5", "gpt-5-6-thinking"] },
          { accountId: bridgeAccount, excludedModels: ["CHATGPT-WEB/HIGH", "legacy"] },
        ],
      }));

      expect(syncCockpitRoutingRules(17841, home)).toBe(true);
      const config = JSON.parse(readFileSync(join(home, "codex_local_access.json"), "utf8"));
      expect(config.accountModelRules).toEqual([
        { accountId: "oauth-a", excludedModels: ["gpt-5.5", "chatgpt-web/*"] },
        { accountId: bridgeAccount, excludedModels: ["legacy", "gpt-*", "codex-*"] },
      ]);

      const first = readFileSync(join(home, "codex_local_access.json"), "utf8");
      expect(syncCockpitRoutingRules(17841, home)).toBe(true);
      expect(readFileSync(join(home, "codex_local_access.json"), "utf8")).toBe(first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails closed until the provider account is active in the API Service pool", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-web-cockpit-"));
    try {
      writeFileSync(join(home, "codex_model_providers.json"), JSON.stringify([
        {
          name: "Codex Web GPT",
          baseUrl: "http://127.0.0.1:17841/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ apiKey: "local" }],
        },
      ]));
      const original = JSON.stringify({ accountIds: ["oauth-a"], accountModelRules: [] });
      writeFileSync(join(home, "codex_local_access.json"), original);

      expect(syncCockpitRoutingRules(17841, home)).toBe(false);
      expect(readFileSync(join(home, "codex_local_access.json"), "utf8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("canonical sync handles every provider key and preserves Cockpit-owned active catalog metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-cockpit-sync-"));
    const cockpitHome = join(root, "cockpit");
    const codexHome = join(root, "codex");
    const previousCockpitHome = process.env.ANTIGRAVITY_COCKPIT_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      mkdirSync(cockpitHome, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      process.env.ANTIGRAVITY_COCKPIT_HOME = cockpitHome;
      process.env.CODEX_HOME = codexHome;

      const bridgeA = accountId("bridge-key-a");
      const bridgeB = accountId("bridge-key-b");
      writeFileSync(join(cockpitHome, "codex_model_providers.json"), JSON.stringify([
        {
          name: "Codex Web GPT",
          baseUrl: "http://127.0.0.1:17841/v1",
          modelCatalog: ["chatgpt-web/high"],
          apiKeys: [{ apiKey: "bridge-key-a" }, { apiKey: "bridge-key-b" }],
        },
      ]));
      writeFileSync(join(cockpitHome, "codex_local_access.json"), JSON.stringify({
        port: 54005,
        accountIds: ["oauth-a", bridgeA, bridgeB],
        accountModelRules: [
          { accountId: "oauth-a", excludedModels: ["custom-native-exclusion"] },
          { accountId: bridgeA, excludedModels: [] },
          { accountId: bridgeB, excludedModels: ["custom-bridge-exclusion"] },
        ],
      }));
      const activeCatalog = `${JSON.stringify({
        models: [{
          slug: "chatgpt-web/high",
          display_name: "Cockpit-owned ChatGPT metadata",
          context_window: 400000,
        }],
      }, null, 2)}\n`;
      writeFileSync(join(codexHome, "cockpit-model-catalog.json"), activeCatalog);

      expect(syncCockpitIntegration(17841)).toEqual({
        ok: true,
        providerConfigured: true,
        routingIsolated: true,
        catalogSynced: true,
        message: "Cockpit provider, routing rules, and model catalog synchronized",
      });
      expect(readFileSync(join(codexHome, "cockpit-model-catalog.json"), "utf8")).toBe(activeCatalog);
      const config = JSON.parse(readFileSync(join(cockpitHome, "codex_local_access.json"), "utf8"));
      expect(config.accountModelRules).toEqual([
        { accountId: "oauth-a", excludedModels: ["custom-native-exclusion", "chatgpt-web/*"] },
        { accountId: bridgeA, excludedModels: ["gpt-*", "codex-*"] },
        { accountId: bridgeB, excludedModels: ["custom-bridge-exclusion", "gpt-*", "codex-*"] },
      ]);
    } finally {
      if (previousCockpitHome === undefined) delete process.env.ANTIGRAVITY_COCKPIT_HOME;
      else process.env.ANTIGRAVITY_COCKPIT_HOME = previousCockpitHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
