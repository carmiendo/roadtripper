// Trims Nevada 511's road conditions for the app: drops "No Report" entries
// (most of the list on a normal day) and keeps only the fields the app uses.
// Usage: node scripts/nevada.mjs raw.json > nevada.json
// Copyright (C) 2026 Carmen Jackson. Licensed under the GNU GPL v3.0 (see LICENSE).

import { readFileSync } from 'node:fs';
import { trimNevada } from './nevada-trim.mjs';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(trimNevada(raw, new Date())));
