const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const INSTANCE_REGISTRY_VERSION = 1;
const PRIMARY_INSTANCE_ID = "primary";
const PRIMARY_INSTANCE_PORT = 17841;
const FIRST_MANAGED_INSTANCE_PORT = 17842;
const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeAbsolutePath(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return path.resolve(value);
}

function validateInstance(instance) {
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    throw new Error("Instance registry entry must be an object");
  }
  if (typeof instance.id !== "string" || !INSTANCE_ID_PATTERN.test(instance.id)) {
    throw new Error("Instance id is invalid");
  }
  if (typeof instance.name !== "string" || !instance.name.trim() || instance.name.trim().length > 80) {
    throw new Error(`Instance ${instance.id} name is invalid`);
  }
  if (!Number.isInteger(instance.port) || instance.port < 1024 || instance.port > 65535) {
    throw new Error(`Instance ${instance.id} port is invalid`);
  }
  const coreHome = normalizeAbsolutePath(instance.coreHome, `Instance ${instance.id} coreHome`);
  if (typeof instance.browserPartition !== "string" || !instance.browserPartition.startsWith("persist:")) {
    throw new Error(`Instance ${instance.id} browserPartition is invalid`);
  }
  if (typeof instance.enabled !== "boolean") {
    throw new Error(`Instance ${instance.id} enabled must be boolean`);
  }
  if (typeof instance.createdAt !== "string" || !Number.isFinite(Date.parse(instance.createdAt))) {
    throw new Error(`Instance ${instance.id} createdAt is invalid`);
  }
  return {
    id: instance.id,
    name: instance.name.trim(),
    port: instance.port,
    coreHome,
    browserPartition: instance.browserPartition,
    enabled: instance.enabled,
    createdAt: instance.createdAt,
  };
}

function validateRegistry(value) {
  if (!value || typeof value !== "object" || value.version !== INSTANCE_REGISTRY_VERSION) {
    throw new Error(`Instance registry must use version ${INSTANCE_REGISTRY_VERSION}`);
  }
  if (!Array.isArray(value.instances) || value.instances.length === 0) {
    throw new Error("Instance registry must contain at least one instance");
  }
  const instances = value.instances.map(validateInstance);
  const unique = (values, label) => {
    if (new Set(values).size !== values.length) throw new Error(`Instance registry has duplicate ${label}`);
  };
  unique(instances.map(instance => instance.id), "ids");
  unique(instances.map(instance => instance.port), "ports");
  unique(instances.map(instance => path.resolve(instance.coreHome).toLowerCase()), "core homes");
  unique(instances.map(instance => instance.browserPartition), "browser partitions");
  if (!instances.some(instance => instance.id === PRIMARY_INSTANCE_ID)) {
    throw new Error("Instance registry is missing the primary instance");
  }
  return { version: INSTANCE_REGISTRY_VERSION, instances };
}

function primaryInstanceFor(profile, createdAt) {
  return {
    id: PRIMARY_INSTANCE_ID,
    name: "Primary",
    port: PRIMARY_INSTANCE_PORT,
    coreHome: normalizeAbsolutePath(profile?.coreHome, "Primary coreHome"),
    browserPartition: profile?.browserPartition,
    enabled: true,
    createdAt,
  };
}

function reconcilePrimary(registry, profile) {
  const primaryIndex = registry.instances.findIndex(instance => instance.id === PRIMARY_INSTANCE_ID);
  const current = registry.instances[primaryIndex];
  const next = {
    ...current,
    port: PRIMARY_INSTANCE_PORT,
    coreHome: normalizeAbsolutePath(profile?.coreHome, "Primary coreHome"),
    browserPartition: profile?.browserPartition,
  };
  validateInstance(next);
  const instances = registry.instances.slice();
  instances[primaryIndex] = next;
  return validateRegistry({ version: INSTANCE_REGISTRY_VERSION, instances });
}

function managedInstancesRoot(profile) {
  const primaryHome = normalizeAbsolutePath(profile?.coreHome, "Primary coreHome");
  return path.join(path.dirname(primaryHome), `${path.basename(primaryHome)}-instances`);
}

function nextInstanceNumber(instances) {
  const used = new Set(instances.map(instance => instance.id));
  for (let number = 2; number < 10_000; number += 1) {
    if (!used.has(`instance-${number}`)) return number;
  }
  throw new Error("Instance registry has no available instance ids");
}

function nextPort(instances) {
  const used = new Set(instances.map(instance => instance.port));
  for (let port = FIRST_MANAGED_INSTANCE_PORT; port <= 65535; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error("Instance registry has no available ports");
}

function createInstanceRegistryStore(filePath, { primaryProfile, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Instance registry path must be absolute");
  }
  let registry;
  let dirty = false;
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    registry = reconcilePrimary(validateRegistry(parsed), primaryProfile);
    dirty = JSON.stringify(parsed) !== JSON.stringify(registry);
  } else {
    registry = validateRegistry({
      version: INSTANCE_REGISTRY_VERSION,
      instances: [primaryInstanceFor(primaryProfile, now())],
    });
    dirty = true;
  }

  const persist = () => writePrivateFileAtomic(filePath, `${JSON.stringify(registry, null, 2)}\n`);
  if (dirty) persist();

  return {
    read() {
      return structuredClone(registry);
    },
    has(instanceId) {
      return registry.instances.some(instance => instance.id === instanceId);
    },
    create({ name } = {}) {
      const number = nextInstanceNumber(registry.instances);
      const id = `instance-${number}`;
      const instance = validateInstance({
        id,
        name: typeof name === "string" && name.trim() ? name.trim() : `Instance ${number}`,
        port: nextPort(registry.instances),
        coreHome: path.join(managedInstancesRoot(primaryProfile), id),
        browserPartition: `persist:codex-web-gpt-${id}`,
        enabled: false,
        createdAt: now(),
      });
      registry = validateRegistry({
        version: INSTANCE_REGISTRY_VERSION,
        instances: [...registry.instances, instance],
      });
      persist();
      return structuredClone(instance);
    },
    update(instanceId, patch = {}) {
      const index = registry.instances.findIndex(instance => instance.id === instanceId);
      if (index < 0) throw new Error(`Unknown instance: ${instanceId}`);
      const current = registry.instances[index];
      const allowed = {};
      if (Object.hasOwn(patch, "name")) allowed.name = patch.name;
      if (Object.hasOwn(patch, "enabled")) allowed.enabled = patch.enabled;
      const next = validateInstance({ ...current, ...allowed });
      const instances = registry.instances.slice();
      instances[index] = next;
      registry = validateRegistry({ version: INSTANCE_REGISTRY_VERSION, instances });
      persist();
      return structuredClone(next);
    },
    remove(instanceId) {
      if (instanceId === PRIMARY_INSTANCE_ID) throw new Error("Primary instance cannot be removed");
      if (!registry.instances.some(instance => instance.id === instanceId)) {
        throw new Error(`Unknown instance: ${instanceId}`);
      }
      registry = validateRegistry({
        version: INSTANCE_REGISTRY_VERSION,
        instances: registry.instances.filter(instance => instance.id !== instanceId),
      });
      persist();
      return structuredClone(registry);
    },
  };
}

module.exports = {
  FIRST_MANAGED_INSTANCE_PORT,
  INSTANCE_REGISTRY_VERSION,
  PRIMARY_INSTANCE_ID,
  PRIMARY_INSTANCE_PORT,
  createInstanceRegistryStore,
  managedInstancesRoot,
  validateRegistry,
};
