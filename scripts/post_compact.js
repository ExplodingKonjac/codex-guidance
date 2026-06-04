#!/usr/bin/env node
"use strict";

const { handlePostCompact, runCli } = require("./shared/entry.js");

void runCli(handlePostCompact);
