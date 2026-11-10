// SPDX-License-Identifier: MIT OR Apache-2.0
// Scenario "daily". usage: node scripts/scenario-daily.mjs [--device <label> --class phone|laptop|other] [--endpoint <origin of web/endpoints.mjs>] [--results <dir> --commit <commit> [--session <id>] [--out charts]]
// Prints the page link; with --results writes <out>/daily.json and the chart (see scripts/scenario.mjs).
import { main } from './scenario.mjs';
main('daily');
