// In-memory stand-in for the subset of the supabase-js query builder the
// Edge Functions use: from().select/insert/update/delete with eq/neq/is/in/
// gt/gte/lt/lte/order/limit/maybeSingle/single, plus rpc() and
// auth.getUser(). RPCs are plain JS functions registered by each test, so
// the SQL functions' contracts are exercised without a database.
import { randomUUID } from "node:crypto";

export class FakeDb {
  constructor() {
    this.tables = new Map();
    this.uniques = new Map();
    this.rpcs = new Map();
    this.users = new Map(); // bearer token -> user id
    this.calls = []; // every table op and rpc, in order
    this.failures = []; // { match(entry) -> bool, error, times }
    this.tampers = new Map(); // table -> fn(row) applied to rows as stored
  }

  install() {
    globalThis.__fakeDb = this;
    return this;
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }

  seed(name, rows) {
    for (const r of rows) this.table(name).push({ ...r });
    return this;
  }

  // unique(name, ["user_id","idempotency_key"], row => row.idempotency_key != null)
  unique(name, cols, where = () => true) {
    if (!this.uniques.has(name)) this.uniques.set(name, []);
    this.uniques.get(name).push({ cols, where });
    return this;
  }

  rpc(name, fn) {
    this.rpcs.set(name, fn);
    return this;
  }

  // Simulates a column the database did not actually persist the way the
  // caller asked (e.g. a trigger or default overriding it).
  tamper(name, fn) {
    this.tampers.set(name, fn);
    return this;
  }

  failWhen(match, error = { code: "XX000", message: "injected failure" }, times = 1) {
    this.failures.push({ match, error, times });
    return this;
  }

  rpcCalls(name) {
    return this.calls.filter((c) => c.kind === "rpc" && c.name === name);
  }

  opCalls(table, op) {
    return this.calls.filter((c) => c.kind === "table" && c.table === table && (!op || c.op === op));
  }

  injected(entry) {
    for (const f of this.failures) {
      if (f.times > 0 && f.match(entry)) {
        f.times--;
        return f.error;
      }
    }
    return null;
  }

  client({ authorization }) {
    const db = this;
    return {
      from: (table) => new Query(db, table),
      rpc: async (name, args = {}) => {
        const entry = { kind: "rpc", name, args };
        db.calls.push(entry);
        const err = db.injected(entry);
        if (err) return { data: null, error: err };
        const fn = db.rpcs.get(name);
        if (!fn) return { data: null, error: { code: "PGRST202", message: `no fake for ${name}` } };
        try {
          const out = await fn(args, db);
          if (out && typeof out === "object" && ("error" in out) && ("data" in out)) return out;
          return { data: out ?? null, error: null };
        } catch (e) {
          return { data: null, error: { code: "P0001", message: String(e?.message ?? e) } };
        }
      },
      auth: {
        getUser: async () => {
          const token = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/, "") : "";
          const id = db.users.get(token);
          if (!id) return { data: { user: null }, error: { message: "invalid token" } };
          return { data: { user: { id } }, error: null };
        },
      },
    };
  }
}

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    // PostgREST JSON path, e.g. "metadata->>reply_token" (text value).
    const path = col.split("->>");
    const v = path.length === 2 ? (row[path[0]] && row[path[0]][path[1]] != null ? String(row[path[0]][path[1]]) : null) : row[col];
    switch (op) {
      case "eq": return v === val;
      case "neq": return v !== val;
      case "is": return val === null ? v === null || v === undefined : v === val;
      case "in": return val.includes(v);
      case "gt": return v > val;
      case "gte": return v >= val;
      case "lt": return v < val;
      case "lte": return v <= val;
      default: throw new Error(`unsupported filter ${op}`);
    }
  });
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.tableName = table;
    this.op = "select";
    this.filters = [];
    this.returning = false;
    this.mode = "many";
    this.orderBy = null;
    this.limitN = null;
    this.payload = null;
  }
  select() {
    if (this.op === "select") this.op = "select";
    else this.returning = true;
    return this;
  }
  insert(rows) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = "update"; this.payload = patch; return this; }
  upsert(rows) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.filters.push(["eq", c, v]); return this; }
  neq(c, v) { this.filters.push(["neq", c, v]); return this; }
  is(c, v) { this.filters.push(["is", c, v]); return this; }
  in(c, v) { this.filters.push(["in", c, v]); return this; }
  gt(c, v) { this.filters.push(["gt", c, v]); return this; }
  gte(c, v) { this.filters.push(["gte", c, v]); return this; }
  lt(c, v) { this.filters.push(["lt", c, v]); return this; }
  lte(c, v) { this.filters.push(["lte", c, v]); return this; }
  order(c, opts = {}) { this.orderBy = [c, opts.ascending !== false]; return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  single() { this.mode = "single"; return this; }
  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (e) {
      reject(e);
    }
  }

  execute() {
    const db = this.db;
    const entry = { kind: "table", table: this.tableName, op: this.op, filters: this.filters, payload: this.payload };
    db.calls.push(entry);
    const err = db.injected(entry);
    if (err) return { data: null, error: err };
    const rows = db.table(this.tableName);
    let out;

    if (this.op === "insert") {
      const inserted = [];
      for (const raw of this.payload) {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...structuredClone(raw) };
        for (const u of db.uniques.get(this.tableName) ?? []) {
          if (!u.where(row)) continue;
          const clash = rows.find((r) => u.where(r) && u.cols.every((c) => r[c] === row[c]));
          if (clash) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const tamper = db.tampers.get(this.tableName);
        if (tamper) tamper(row);
        inserted.push(row);
      }
      rows.push(...inserted);
      out = inserted;
      if (!this.returning) return { data: null, error: null };
    } else if (this.op === "update") {
      out = rows.filter((r) => matches(r, this.filters));
      for (const r of out) Object.assign(r, structuredClone(this.payload));
      if (!this.returning) return { data: null, error: null };
    } else if (this.op === "delete") {
      const keep = rows.filter((r) => !matches(r, this.filters));
      out = rows.filter((r) => matches(r, this.filters));
      rows.length = 0;
      rows.push(...keep);
      if (!this.returning) return { data: null, error: null };
    } else {
      out = rows.filter((r) => matches(r, this.filters));
      if (this.orderBy) {
        const [c, asc] = this.orderBy;
        out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.limitN != null) out = out.slice(0, this.limitN);
    }

    out = out.map((r) => structuredClone(r));
    if (this.mode === "maybe") {
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      return { data: out[0] ?? null, error: null };
    }
    if (this.mode === "single") {
      if (out.length !== 1) return { data: null, error: { code: "PGRST116", message: "not exactly one row" } };
      return { data: out[0], error: null };
    }
    return { data: out, error: null };
  }
}
