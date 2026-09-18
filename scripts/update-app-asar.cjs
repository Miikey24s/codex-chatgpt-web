const asar = require("../launcher/node_modules/@electron/asar");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

async function main() {
  const root = path.resolve(__dirname, "..");
  const launcherRoot = path.join(root, "launcher");
  const targetAsar = "C:/Users/MIIKEY/AppData/Local/Programs/Codex Web GPT/resources/app.asar";
  const backupAsar = "C:/Users/MIIKEY/AppData/Local/Programs/Codex Web GPT/resources/app.asar.bak";

  console.log("Preparing staging directory...");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-asar-staging-"));

  try {
    // Copy dist/
    fs.cpSync(path.join(launcherRoot, "dist"), path.join(staging, "dist"), { recursive: true });

    // Copy electron/
    fs.cpSync(path.join(launcherRoot, "electron"), path.join(staging, "electron"), { recursive: true });

    // Copy assets/
    fs.cpSync(path.join(launcherRoot, "assets"), path.join(staging, "assets"), { recursive: true });

    // Copy package.json
    fs.copyFileSync(path.join(launcherRoot, "package.json"), path.join(staging, "package.json"));

    console.log("Packing into asar...");
    const tempAsar = path.join(os.tmpdir(), `app-${Date.now()}.asar`);
    await asar.createPackage(staging, tempAsar);
    console.log("Asar created at temp:", tempAsar);

    // Backup current asar if not already backed up
    if (fs.existsSync(targetAsar) && !fs.existsSync(backupAsar)) {
      console.log("Creating backup:", backupAsar);
      fs.copyFileSync(targetAsar, backupAsar);
    }

    // Copy new asar to destination
    console.log("Installing to target:", targetAsar);
    fs.copyFileSync(tempAsar, targetAsar);
    fs.unlinkSync(tempAsar);
    console.log("Successfully updated app.asar!");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Error updating asar:", err);
  process.exit(1);
});
