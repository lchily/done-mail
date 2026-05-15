import { migration as v1 } from './0001_init';
import { migration as v2 } from './0002_public_body_fast_path';
import { migration as v3 } from './0003_safe_body_fast_path';
import type { Migration, MigrationDefinition } from './types';

type MigrationEntry = readonly [version: number, migration: MigrationDefinition];

function defineMigrations(entries: MigrationEntry[]): Migration[] {
  const versions = new Set<number>();
  const names = new Set<string>();
  let previousVersion = 0;

  return entries.map(([version, migration]) => {
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`数据库迁移版本必须是正整数：${version}`);
    }
    if (version <= previousVersion) {
      throw new Error(`数据库迁移版本必须严格递增：${version}`);
    }
    if (versions.has(version)) {
      throw new Error(`数据库迁移版本重复：${version}`);
    }
    if (!migration.name.trim()) {
      throw new Error(`数据库迁移 ${version} 缺少名称`);
    }
    if (names.has(migration.name)) {
      throw new Error(`数据库迁移名称重复：${migration.name}`);
    }
    if (!migration.statements.length) {
      throw new Error(`数据库迁移 ${version} 没有 SQL 语句`);
    }

    previousVersion = version;
    versions.add(version);
    names.add(migration.name);
    return { version, ...migration };
  });
}

export const migrations = defineMigrations([[1, v1], [2, v2], [3, v3]]);
export type { Migration } from './types';
