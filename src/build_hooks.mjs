import { mkdir, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const entryPoints = {
  session_start: "handleSessionStart",
  post_tool_use: "handlePostToolUse",
  pre_tool_use: "handlePreToolUse",
  post_compact: "handlePostCompact",
};

await mkdir("scripts/shared", { recursive: true });

await build({
  entryPoints: ["src/hooks/shared_entry.ts"],
  outfile: "scripts/shared/entry.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  sourcemap: false,
  logLevel: "silent",
});

await Promise.all(
  Object.entries(entryPoints).map(([scriptName, handlerName]) =>
    writeFile(
      `scripts/${scriptName}.js`,
      `#!/usr/bin/env node
"use strict";

const { ${handlerName}, runCli } = require("./shared/entry.js");

void runCli(${handlerName});
`,
      "utf8",
    ),
  ),
);
