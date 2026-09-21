const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PRIMARY_INSTANCE_ID,
  PRIMARY_INSTANCE_PORT,
  createInstanceRegistryStore,
} = require("../electron/instance-registry.cjs");

function fixtureProfile(root) {
  return {
    coreHome: path.join(root, ".codex-chatgpt-web"),
    browserPartition: "persist:codex-web-gpt-chatgpt",
  };
}

test("instance registry migrates the existing launcher into primary without moving its data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-instance-registry-"));
  const file = path.join(root, "launcher", "instances.json");
  try {
    const profile = fixtureProfile(root);
    const store = createInstanceRegistryStore(file, {
      primaryProfile: profile,
      now: () => "2026-09-21T03:00:00.000Z",
    });
    assert.deepEqual(store.read(), {
      version: 1,
      instances: [{
        id: PRIMARY_INSTANCE_ID,
        name: "Primary",
        port: PRIMARY_INSTANCE_PORT,
        coreHome: profile.coreHome,
        browserPartition: profile.browserPartition,
        enabled: true,
        createdAt: "2026-09-21T03:00:00.000Z",
      }],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), store.read());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instance registry allocates stable isolated ids ports homes and browser partitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-instance-registry-"));
  const file = path.join(root, "launcher", "instances.json");
  try {
    const profile = fixtureProfile(root);
    let tick = 0;
    const store = createInstanceRegistryStore(file, {
      primaryProfile: profile,
      now: () => `2026-09-21T03:00:0${tick++}.000Z`,
    });
    const second = store.create({ name: "Work 2" });
    const third = store.create();
    assert.equal(second.id, "instance-2");
    assert.equal(second.port, 17842);
    assert.equal(second.name, "Work 2");
    assert.equal(second.enabled, false);
    assert.equal(second.coreHome, path.join(root, ".codex-chatgpt-web-instances", "instance-2"));
    assert.equal(second.browserPartition, "persist:codex-web-gpt-instance-2");
    assert.equal(third.id, "instance-3");
    assert.equal(third.port, 17843);
    assert.equal(third.name, "Instance 3");
    assert.notEqual(third.coreHome, second.coreHome);
    assert.notEqual(third.browserPartition, second.browserPartition);

    const reloaded = createInstanceRegistryStore(file, {
      primaryProfile: profile,
      now: () => "2099-01-01T00:00:00.000Z",
    });
    assert.deepEqual(reloaded.read(), store.read());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instance registry follows an explicit primary home move without changing managed instances", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-instance-registry-"));
  const file = path.join(root, "launcher", "instances.json");
  try {
    const initialProfile = fixtureProfile(root);
    const store = createInstanceRegistryStore(file, {
      primaryProfile: initialProfile,
      now: () => "2026-09-21T03:00:00.000Z",
    });
    const second = store.create();
    const movedProfile = {
      ...initialProfile,
      coreHome: path.join(root, "moved-primary"),
    };
    const reloaded = createInstanceRegistryStore(file, { primaryProfile: movedProfile });
    const primary = reloaded.read().instances.find(instance => instance.id === PRIMARY_INSTANCE_ID);
    assert.equal(primary.coreHome, movedProfile.coreHome);
    assert.deepEqual(reloaded.read().instances.find(instance => instance.id === second.id), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instance registry rejects duplicate durable ownership instead of silently rewriting it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-instance-registry-"));
  const file = path.join(root, "instances.json");
  try {
    const profile = fixtureProfile(root);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      instances: [
        {
          id: "primary",
          name: "Primary",
          port: 17841,
          coreHome: profile.coreHome,
          browserPartition: profile.browserPartition,
          enabled: true,
          createdAt: "2026-09-21T03:00:00.000Z",
        },
        {
          id: "instance-2",
          name: "Broken",
          port: 17841,
          coreHome: path.join(root, "other"),
          browserPartition: "persist:other",
          enabled: true,
          createdAt: "2026-09-21T03:00:01.000Z",
        },
      ],
    }));
    assert.throws(
      () => createInstanceRegistryStore(file, { primaryProfile: profile }),
      /duplicate ports/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("instance registry updates mutable metadata and refuses to remove primary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-instance-registry-"));
  const file = path.join(root, "instances.json");
  try {
    const store = createInstanceRegistryStore(file, {
      primaryProfile: fixtureProfile(root),
      now: () => "2026-09-21T03:00:00.000Z",
    });
    const second = store.create({ name: "Work 2" });
    const updated = store.update(second.id, { name: "Research", enabled: false, port: 19999 });
    assert.equal(updated.name, "Research");
    assert.equal(updated.enabled, false);
    assert.equal(updated.port, second.port, "durable ownership fields must not be mutable");
    assert.throws(() => store.remove(PRIMARY_INSTANCE_ID), /Primary instance cannot be removed/);
    const after = store.remove(second.id);
    assert.equal(after.instances.length, 1);
    assert.equal(after.instances[0].id, PRIMARY_INSTANCE_ID);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
