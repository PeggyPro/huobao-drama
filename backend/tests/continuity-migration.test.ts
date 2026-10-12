import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'
import { CONTINUITY_MIGRATION } from '../src/db/continuity-migration.js'

// Deliberately use the pre-upgrade schema: no new-field fixture can prove ALTER works.
function oldDatabase(db: Database.Database) {
  db.exec(`
    CREATE TABLE storyboards (id INTEGER PRIMARY KEY, episode_id INTEGER, storyboard_number INTEGER, video_url TEXT);
    CREATE TABLE sys_task (id INTEGER PRIMARY KEY, type TEXT, drama_id INTEGER, storyboard_id INTEGER, status TEXT, local_path TEXT);
    INSERT INTO storyboards VALUES (1, 9, 1, 'static/videos/first.mp4'), (2, 9, 2, 'static/videos/ambiguous.mp4');
    INSERT INTO sys_task VALUES (10, 'video', 2, 1, 'completed', 'static/videos/first.mp4'),
      (11, 'video', 2, 2, 'completed', 'static/videos/ambiguous.mp4'), (12, 'video', 2, 2, 'completed', 'static/videos/ambiguous.mp4');
  `)
}

test('legacy database uses a WAL-consistent backup and backfills only unambiguous versions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'huobao-continuity-migration-'))
  const database = new Database(path.join(directory, 'legacy.sqlite3'))
  try {
    database.pragma('journal_mode = WAL')
    oldDatabase(database)
    await initSqliteSchema(database)
    const row = database.prepare('SELECT backup_path FROM schema_migrations WHERE id = ?').get(CONTINUITY_MIGRATION) as { backup_path: string }
    assert.ok(row.backup_path.startsWith(directory + path.sep))
    const backup = new Database(row.backup_path, { readonly: true, fileMustExist: true })
    try {
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM storyboards').get().n, 2)
      assert.equal(backup.pragma('table_info(storyboards)').some((column: any) => column.name === 'continuity_plan'), false)
      assert.equal(backup.pragma('quick_check', { simple: true }), 'ok')
    } finally { backup.close() }
    assert.deepEqual(database.prepare('SELECT video_task_id, continuity_revision, continuity_plan FROM storyboards ORDER BY id').all(), [
      { video_task_id: 10, continuity_revision: 0, continuity_plan: null },
      { video_task_id: null, continuity_revision: 0, continuity_plan: null },
    ])
    await initSqliteSchema(database)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1)
    assert.equal(database.prepare('SELECT backup_path FROM schema_migrations WHERE id = ?').get(CONTINUITY_MIGRATION).backup_path, row.backup_path)
    database.prepare("UPDATE sys_task SET request_key = 'same-request' WHERE id = 10").run()
    assert.throws(() => database.prepare("UPDATE sys_task SET request_key = 'same-request' WHERE id = 11").run(), /UNIQUE/)
  } finally {
    database.close()
    // Exact mkdtemp output owned by this test, never a computed repository/data path.
    assert.equal(path.dirname(directory), os.tmpdir())
    await rm(directory, { recursive: true, force: true })
  }
})

test('fresh in-memory databases initialize all continuity fields without a disk backup', async () => {
  const database = new Database(':memory:')
  try {
    await initSqliteSchema(database)
    assert.equal(database.prepare('SELECT backup_path FROM schema_migrations').get().backup_path, null)
    for (const column of ['batch_id', 'depends_on_task_id', 'request_key', 'request_hash', 'phase', 'worker_token', 'lease_expires_at', 'retry_of_task_id', 'blocked_reason', 'artifacts', 'deleted_at']) {
      assert.ok(database.pragma('table_info(sys_task)').some((row: any) => row.name === column))
    }
  } finally { database.close() }
})
