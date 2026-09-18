import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCockpitIntegration, syncCockpitRoutingRules } from "../src/cockpit";

function accountId(apiKey: string): string {
  return `codex_apikey_${createHash("md5").update(apiKey).digest("hex")}`;
}

describe("Cockpit model routing", () => {
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
