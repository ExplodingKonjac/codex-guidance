#!/usr/bin/env node
"use strict";

const { handlePostToolUse, runCli } = require("./shared/entry.js");

void runCli(handlePostToolUse);
