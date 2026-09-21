const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DETACH_OWNED_CHILD = process.platform !== "win32";

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists even though this user cannot signal it.
    return error?.code === "EPERM";
  }
}

function terminateOwnedProcessTree(child, signal = "SIGTERM") {
  if (!child) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid < 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned child process has no valid pid and refused termination");
    }
    return;
  }

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if ((result.error || result.status !== 0) && processRunning(pid)) {
      const detail = result.error?.message || `taskkill exited with status ${result.status ?? "unknown"}`;
      throw new Error(`Could not terminate owned Windows process tree ${pid}: ${detail}`);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(
      `Could not terminate owned process group ${pid}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function processImageName(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const tasklist = path.join(systemRoot, "System32", "tasklist.exe");
    const result = spawnSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const match = result.stdout.match(/^"([^"]+)"/m);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    const name = result.stdout.trim().toLowerCase();
    return name || null;
  }
  return null;
}

const DAEMON_EXECUTABLE_NAMES = new Set([
  "bun",
  "bun.exe",
  "node",
  "node.exe",
  "electron",
  "electron.exe",
]);

const LAUNCHER_EXECUTABLE_NAMES = new Set([
  "codex web gpt",
  "codex web gpt.exe",
  "codex-web-gpt",
  "codex-web-gpt.exe",
  "electron",
  "electron.exe",
  "node",
  "node.exe",
]);

const TUNNEL_EXECUTABLE_NAMES = new Set([
  "tunnel-client",
  "tunnel-client.exe",
  "node",
  "node.exe",
  "bun",
  "bun.exe",
]);

function daemonProcessRunning(pid) {
  if (!processRunning(pid)) return false;
  const image = processImageName(pid);
  if (!image) return true;
  return DAEMON_EXECUTABLE_NAMES.has(image);
}

function launcherProcessRunning(pid) {
  if (!processRunning(pid)) return false;
  const image = processImageName(pid);
  if (!image) return true;
  return LAUNCHER_EXECUTABLE_NAMES.has(image);
}

function tunnelProcessRunning(pid) {
  if (!processRunning(pid)) return false;
  const image = processImageName(pid);
  if (!image) return true;
  return TUNNEL_EXECUTABLE_NAMES.has(image);
}

module.exports = {
  DAEMON_EXECUTABLE_NAMES,
  DETACH_OWNED_CHILD,
  LAUNCHER_EXECUTABLE_NAMES,
  TUNNEL_EXECUTABLE_NAMES,
  daemonProcessRunning,
  launcherProcessRunning,
  processImageName,
  processRunning,
  terminateOwnedProcessTree,
  tunnelProcessRunning,
};
