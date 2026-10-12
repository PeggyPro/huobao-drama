import type Database from 'better-sqlite3'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const CONTINUITY_MIGRATION = '20261016-continuity-v1'
const columns: Record<string, Record<string, string>> = {
  storyboards: {
    continuity_plan: 'TEXT',
    continuity_revision: 'INTEGER NOT NULL DEFAULT 0',
    transition_config: 'TEXT',
    video_task_id: 'INTEGER',
    pending_video_task_id: 'INTEGER',
  },
  sys_task: {
    batch_id: 'TEXT',
    depends_on_task_id: 'INTEGER',
    request_key: 'TEXT',
    request_hash: 'TEXT',
    phase: 'TEXT',
    worker_token: 'TEXT',
    lease_expires_at: 'TEXT',
    retry_of_task_id: 'INTEGER',
    blocked_reason: 'TEXT',
    artifacts: 'TEXT',
    deleted_at: 'TEXT',
  },
}

function hasTable(sqlite: Database.Database, name: string) {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}
function hasMigration(sqlite: Database.Database) {
  return hasTable(sqlite, 'schema_migrations') && !!sqlite.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(CONTINUITY_MIGRATION)
}

/** Online SQLite backup includes committed WAL pages. A failed backup prevents migration. */
export async function backupBeforeContinuityMigration(sqlite: Database.Database): Promise<string | null> {
  if (hasMigration(sqlite) || !hasTable(sqlite, 'storyboards') || !sqlite.name || sqlite.name === ':memory:') return null
  const source = path.resolve(sqlite.name)
  const directory = path.resolve(path.dirname(source), 'backups')
  await mkdir(directory, { recursive: true })
  const destination = path.resolve(directory, `${path.basename(source)}.before-continuity-${randomUUID()}.sqlite3`)
  if (path.dirname(destination) !== directory || destination === source) throw new Error('数据库备份路径无效')
  await sqlite.backup(destination)
  console.info(`[Database] continuity migration backup: ${destination}`)
  return destination
}

/** Call after base tables exist. DDL, version publication and unambiguous backfill are atomic. */
export function applyContinuityMigration(sqlite: Database.Database, backupPath: string | null = null) {
  if (hasMigration(sqlite)) return
  sqlite.transaction(() => {
    for (const [table, definitions] of Object.entries(columns)) {
      const present = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name))
      for (const [name, type] of Object.entries(definitions)) {
        if (!present.has(name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
      }
    }
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sys_task_request_key ON sys_task(request_key) WHERE request_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sys_task_batch ON sys_task(batch_id);
      CREATE INDEX IF NOT EXISTS idx_sys_task_dependency ON sys_task(depends_on_task_id);
      CREATE INDEX IF NOT EXISTS idx_sys_task_dispatch ON sys_task(status, deleted_at, lease_expires_at);
      CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, backup_path TEXT);
      UPDATE storyboards SET video_task_id = (
        SELECT MIN(t.id) FROM sys_task t
        WHERE t.storyboard_id = storyboards.id AND t.type = 'video' AND t.status = 'completed'
          AND t.local_path = storyboards.video_url AND t.deleted_at IS NULL
        HAVING COUNT(*) = 1
      ) WHERE video_task_id IS NULL AND video_url IS NOT NULL AND video_url <> '';
    `)
    sqlite.prepare('INSERT INTO schema_migrations(id, applied_at, backup_path) VALUES (?, ?, ?)')
      .run(CONTINUITY_MIGRATION, new Date().toISOString(), backupPath)
  })()
}
