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

function terminateProcessesInDirectory(dirPath, { excludePids = [process.pid] } = {}) {
  if (!dirPath || typeof dirPath !== "string") return [];
  const normalizedTarget = path.resolve(dirPath).toLowerCase();
  const terminatedPids = [];
  const excluded = new Set(excludePids.filter(p => Number.isInteger(p) && p > 0));
  excluded.add(process.pid);

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const escaped = normalizedTarget.replace(/'/g, "''");
    const script = [
      `$target = '${escaped}'.ToLower()`,
      "Get-CimInstance Win32_Process | ForEach-Object {",
      "  if ($_.ProcessId -ne $PID) {",
      "    $p = $_.ExecutablePath",
      "    $c = $_.CommandLine",
      "    $hit = $false",
      "    if ($p -and $p.ToLower().StartsWith($target)) { $hit = $true }",
      "    elseif ($c -and $c.ToLower().Contains($target)) { $hit = $true }",
      "    if ($hit) { Write-Output $_.ProcessId }",
      "  }",
      "}",
    ].join("\n");

    try {
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      if (result.status === 0 && typeof result.stdout === "string") {
        const pids = result.stdout
          .split(/\r?\n/)
          .map(line => Number.parseInt(line.trim(), 10))
          .filter(pid => Number.isInteger(pid) && pid > 0 && !excluded.has(pid));

        for (const pid of pids) {
          try {
            spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
              timeout: 5_000,
            });
            terminatedPids.push(pid);
          } catch {}
        }
      }
    } catch {}
    return terminatedPids;
  }

  try {
    const lsof = spawnSync("lsof", ["+D", dirPath, "-t"], { encoding: "utf8", timeout: 5_000 });
    if (lsof.status === 0 && typeof lsof.stdout === "string") {
      const pids = lsof.stdout
        .split(/\r?\n/)
        .map(line => Number.parseInt(line.trim(), 10))
        .filter(pid => Number.isInteger(pid) && pid > 0 && !excluded.has(pid));
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
          terminatedPids.push(pid);
        } catch {}
      }
    }
  } catch {}

  return terminatedPids;
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
  terminateProcessesInDirectory,
  tunnelProcessRunning,
};

