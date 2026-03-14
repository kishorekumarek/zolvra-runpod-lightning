#!/usr/bin/env node
// scripts/run-db-migration.mjs — Run SQL migrations via pg pooler
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigration() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('❌ SUPABASE_DB_URL not set in .env');
    process.exit(1);
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('✅ Connected to Supabase (pooler)');

    // Run migration 001
    const migrationPath = join(__dirname, '..', 'migrations', '001_create_tables.sql');
    const sql = readFileSync(migrationPath, 'utf8');

    console.log('Running migration: 001_create_tables.sql...');
    await client.query(sql);
    console.log('✅ Migration 001 complete');

    // Verify tables
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'character_library',
          'video_pipeline_runs',
          'pipeline_feedback',
          'pipeline_settings',
          'scene_assets',
          'ops_tasks'
        )
      ORDER BY table_name;
    `);

    const tables = tableCheck.rows.map(r => r.table_name);
    const expected = ['character_library', 'ops_tasks', 'pipeline_feedback', 'pipeline_settings', 'scene_assets', 'video_pipeline_runs'];

    console.log('\n📋 Tables created:');
    for (const t of expected) {
      const exists = tables.includes(t);
      console.log(`  ${exists ? '✅' : '❌'} ${t}`);
    }

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
