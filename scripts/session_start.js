#!/usr/bin/env node
"use strict";

const { handleSessionStart, runCli } = require("./shared/entry.js");

void runCli(handleSessionStart);
