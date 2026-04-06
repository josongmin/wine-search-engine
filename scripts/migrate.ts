#!/usr/bin/env node
import { runMigrations } from '../src/infrastructure/db/migrate.js';
await runMigrations();
