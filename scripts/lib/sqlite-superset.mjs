import { DatabaseSync } from "node:sqlite";

/** Prove a live Core DB contains every legacy row, allowing only monotonic
 * experience-envelope advances plus additional live rows. */
export function verifyCoreDatabaseSupersedes(activePath, legacyPath) {
  const active = new DatabaseSync(activePath, { readOnly: true });
  const legacy = new DatabaseSync(legacyPath, { readOnly: true });
  const failures = [];
  const tables = [];
  try {
    const activeTables = tableNames(active);
    const legacyTables = tableNames(legacy);
    if (JSON.stringify(activeTables) !== JSON.stringify(legacyTables)) {
      failures.push("table sets differ");
      return { ok: false, failures, tables };
    }
    for (const table of legacyTables) {
      const activeColumns = columns(active, table);
      const legacyColumns = columns(legacy, table);
      if (JSON.stringify(activeColumns) !== JSON.stringify(legacyColumns)) {
        failures.push(`${table}: schema differs`);
        continue;
      }
      const primary = legacyColumns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
      if (!primary.length) {
        failures.push(`${table}: no primary key`);
        continue;
      }
      const names = legacyColumns.map((column) => column.name);
      const quoted = quote(table);
      const legacyRows = legacy.prepare(`SELECT * FROM "${quoted}"`).all();
      const activeCount = Number(active.prepare(`SELECT count(*) AS count FROM "${quoted}"`).get().count);
      let identical = 0;
      let advanced = 0;
      let missing = 0;
      for (const row of legacyRows) {
        const where = primary.map(({ name }) => `"${quote(name)}" = ?`).join(" AND ");
        const candidate = active.prepare(`SELECT * FROM "${quoted}" WHERE ${where}`).get(
          ...primary.map(({ name }) => row[name]),
        );
        if (!candidate) {
          missing += 1;
          continue;
        }
        if (names.every((name) => equalValue(row[name], candidate[name]))) {
          identical += 1;
          continue;
        }
        if (table === "experience_envelopes" && envelopeAdvanced(row, candidate, names)) {
          advanced += 1;
          continue;
        }
        failures.push(`${table}: shared primary-key row changed non-monotonically`);
      }
      if (activeCount < legacyRows.length) failures.push(`${table}: active row count is smaller`);
      if (missing) failures.push(`${table}: ${missing} legacy primary-key rows are missing`);
      tables.push({ table, legacyRows: legacyRows.length, activeRows: activeCount, identical, advanced, missing });
    }
    return { ok: failures.length === 0, failures, tables };
  } finally {
    active.close();
    legacy.close();
  }
}

function tableNames(database) {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map(({ name }) => String(name));
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_info("${quote(table)}")`).all()
    .map(({ name, type, notnull, dflt_value, pk }) => ({
      name: String(name), type: String(type), notnull: Number(notnull),
      dflt_value: dflt_value ?? null, pk: Number(pk),
    }));
}

function envelopeAdvanced(before, after, names) {
  const mutable = new Set(["revision", "payload_json", "updated_at", "updated_by_device_id"]);
  if (!names.filter((name) => !mutable.has(name)).every((name) => equalValue(before[name], after[name]))) {
    return false;
  }
  return Number(after.revision) >= Number(before.revision)
    && String(after.updated_at || "") >= String(before.updated_at || "");
}

function equalValue(left, right) {
  if (ArrayBuffer.isView(left) && ArrayBuffer.isView(right)) {
    return Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
  }
  return left === right;
}

function quote(value) {
  return String(value).replaceAll('"', '""');
}
