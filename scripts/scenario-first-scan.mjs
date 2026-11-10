// SPDX-License-Identifier: MIT OR Apache-2.0
// Scenario "first-scan". usage: node scripts/scenario-first-scan.mjs [--device <label> --class phone|laptop|other] [--endpoint <origin of web/endpoints.mjs>] [--results <dir> --commit <commit> [--session <id>] [--out charts]]
// Prints the page link; with --results writes <out>/first-scan.json and the chart (see scripts/scenario.mjs).
import { main } from './scenario.mjs';
main('first-scan');
