import fg from "fast-glob";

const logs = await fg(
  [
    "release/**/app/node_modules/**/*.log",
    "release/**/app/node_modules/**/.log*",
    "release/**/app/**/ti-*.log",
    "release/**/app/**/._*",
    "release/**/app/**/.DS_Store",
    "release/**/__MACOSX/**",
  ],
  { dot: true },
);
if (logs.length > 0) {
  console.error("Packaged app contains build logs:");
  for (const file of logs.slice(0, 20)) console.error(`- ${file}`);
  process.exit(1);
}
console.log("Package check: no build logs or AppleDouble files.");
