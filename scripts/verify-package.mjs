const base = process.argv[2] ?? "release";
import fs from "node:fs/promises";
import fg from "fast-glob";

const logs = await fg(
  [
    `${base}/**/app/node_modules/**/*.log`,
    `${base}/**/app/node_modules/**/.log*`,
    `${base}/**/app/**/ti-*.log`,
    `${base}/**/app/**/._*`,
    `${base}/**/app/**/.DS_Store`,
    `${base}/**/__MACOSX/**`,
  ],
  { dot: true },
);
if (logs.length > 0) {
  console.error("Packaged app contains build logs:");
  for (const file of logs.slice(0, 20)) console.error(`- ${file}`);
  process.exit(1);
}
const runtimes = await fg(
  [
    `${base}/**/runtime/node/bin/node`,
    `${base}/**/runtime/node/node.exe`,
  ],
  { dot: true, onlyFiles: true },
);
const unpackedApps = await fg(
  [`${base}/**/Contents/Resources/app/package.json`, `${base}/**/resources/app/package.json`],
  { dot: true, onlyFiles: true },
);
if (runtimes.length === 0 && unpackedApps.length > 0) {
  console.error(
    "Packaged app is missing the bundled Node runtime. Run `npm run fetch:node` before packaging.",
  );
  process.exit(1);
}
if (runtimes.length > 0) {
  const runtimeStat = await fs.stat(runtimes[0]);
  if (runtimeStat.size < 20 * 1024 * 1024) {
    console.error(
      `Bundled Node runtime looks incomplete: ${runtimes[0]} (${runtimeStat.size} bytes)`,
    );
    process.exit(1);
  }
  console.log(
    `Package check: no build logs or AppleDouble files; bundled Node runtime present (${runtimes[0]}).`,
  );
} else {
  console.log("Package check: no unpacked app in this output; runtime verified during packaging.");
}
