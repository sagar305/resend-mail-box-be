/*
 * A minimal in-memory stand-in for the slice of the MongoDB driver these tests
 * touch. db.js already anticipates this — useDatabase() exists so tests can hand
 * the app a database without a server running.
 *
 * It implements the operators the ledger and job code actually use, and nothing
 * else. Anything unsupported throws loudly rather than quietly returning the
 * wrong answer, because a fake that silently disagrees with Mongo is worse than
 * no fake at all.
 */

const DUPLICATE_KEY = 11000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** Supports the comparison operators used by the slot ledger and job claims. */
function matchesCondition(value, condition) {
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
    return value === condition;
  }
  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case '$lte': return value <= operand;
      case '$gte': return value >= operand;
      case '$lt': return value < operand;
      case '$gt': return value > operand;
      case '$ne': return value !== operand;
      case '$in': return operand.includes(value);
      default: throw new Error(`memoryDb: unsupported operator ${operator}`);
    }
  });
}

function matches(doc, filter) {
  return Object.entries(filter ?? {}).every(([field, condition]) => {
    if (field === '$or') return condition.some((sub) => matches(doc, sub));
    // An absent field is `undefined`; `{ count: { $lte: 5 } }` must not match a
    // document with no count, which is how real Mongo behaves.
    if (doc[field] === undefined && condition !== undefined && typeof condition === 'object') {
      return false;
    }
    return matchesCondition(doc[field], condition);
  });
}

function applyUpdate(doc, update) {
  const next = { ...doc };
  for (const [operator, fields] of Object.entries(update)) {
    switch (operator) {
      case '$set':
        Object.assign(next, clone(fields));
        break;
      case '$setOnInsert':
        break; // Only meaningful on insert; handled by the upsert path.
      case '$inc':
        for (const [field, amount] of Object.entries(fields)) {
          next[field] = (next[field] ?? 0) + amount;
        }
        break;
      default:
        throw new Error(`memoryDb: unsupported update operator ${operator}`);
    }
  }
  return next;
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [field, direction] of entries) {
      if (a[field] < b[field]) return -direction;
      if (a[field] > b[field]) return direction;
    }
    return 0;
  });
}

class MemoryCollection {
  constructor() {
    this.docs = new Map();
  }

  async createIndex() {
    return 'ok';
  }

  async findOne(filter) {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) return clone(doc);
    }
    return null;
  }

  find(filter) {
    let results = [...this.docs.values()].filter((doc) => matches(doc, filter));
    const cursor = {
      sort: (spec) => {
        results = sortDocs(results, spec);
        return cursor;
      },
      limit: (n) => {
        results = results.slice(0, n);
        return cursor;
      },
      toArray: async () => results.map(clone),
    };
    return cursor;
  }

  async insertOne(doc) {
    if (this.docs.has(doc._id)) {
      const error = new Error('E11000 duplicate key error');
      error.code = DUPLICATE_KEY;
      throw error;
    }
    this.docs.set(doc._id, clone(doc));
    return { insertedId: doc._id };
  }

  async insertMany(docs) {
    for (const doc of docs) await this.insertOne(doc);
    return { insertedCount: docs.length };
  }

  async updateOne(filter, update, options = {}) {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) {
        this.docs.set(doc._id, applyUpdate(doc, update));
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
    }

    if (options.upsert) {
      // Real Mongo seeds an upsert from the filter's equality fields, then applies
      // the update — including $setOnInsert. A filter with only a comparison on a
      // unique _id therefore collides instead of inserting, which is precisely the
      // behaviour the slot ledger is written to avoid.
      const seed = {};
      for (const [field, condition] of Object.entries(filter)) {
        if (condition === null || typeof condition !== 'object') seed[field] = condition;
      }
      if (seed._id !== undefined && this.docs.has(seed._id)) {
        const error = new Error('E11000 duplicate key error');
        error.code = DUPLICATE_KEY;
        throw error;
      }
      const inserted = applyUpdate({ ...seed, ...clone(update.$setOnInsert ?? {}) }, update);
      const id = inserted._id ?? `generated-${this.docs.size + 1}`;
      this.docs.set(id, { ...inserted, _id: id });
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }

    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  async updateMany(filter, update) {
    let modified = 0;
    for (const doc of [...this.docs.values()]) {
      if (matches(doc, filter)) {
        this.docs.set(doc._id, applyUpdate(doc, update));
        modified += 1;
      }
    }
    return { matchedCount: modified, modifiedCount: modified };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) {
        const updated = applyUpdate(doc, update);
        this.docs.set(doc._id, updated);
        return clone(options.returnDocument === 'after' ? updated : doc);
      }
    }
    return null;
  }

  async deleteOne(filter) {
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) {
        this.docs.delete(doc._id);
        return { deletedCount: 1 };
      }
    }
    return { deletedCount: 0 };
  }

  async deleteMany(filter) {
    let deleted = 0;
    for (const doc of [...this.docs.values()]) {
      if (matches(doc, filter)) {
        this.docs.delete(doc._id);
        deleted += 1;
      }
    }
    return { deletedCount: deleted };
  }

  async countDocuments(filter = {}) {
    return [...this.docs.values()].filter((doc) => matches(doc, filter)).length;
  }
}

export function createMemoryDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection());
      return collections.get(name);
    },
    reset() {
      collections.clear();
    },
  };
}
