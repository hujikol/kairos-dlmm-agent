const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function supportsCoverageFlag() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 18;
}

const args = ["--test"];
if (supportsCoverageFlag()) {
  args.push("--experimental-test-coverage");
}

function matchingFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(predicate)
    .map((file) => path.join(dir, file));
}

const files = [
  ...matchingFiles(".", (file) => /^test-.*\.js$/.test(file) || /.*\.test\.js$/.test(file)),
];

args.push(...files);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
