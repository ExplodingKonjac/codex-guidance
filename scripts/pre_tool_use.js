#!/usr/bin/env node
"use strict";

const { handlePreToolUse, runCli } = require("./shared/entry.js");

void runCli(handlePreToolUse);
