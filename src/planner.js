import { computeInvalidation, orderByDependency } from './graph.js';

export class CancelledError extends Error {
  constructor(message = 'transaction cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

// 支持三种事件形态：
//   { texture: 'tex@2', model: null }          // 对象映射，null 表示删除
//   [{ id: 'texture', version: 'tex@2' }]      // 事件数组
//   new Map([['texture', 'tex@2']])            // Map
function normalizeEvents(events) {
  const map = new Map();
  if (events == null) return map;
  if (events instanceof Map) {
    for (const [id, version] of events) map.set(id, version ?? null);
    return map;
  }
  if (Array.isArray(events)) {
    for (const event of events) map.set(event.id, event.version ?? null);
    return map;
  }
  if (typeof events === 'object') {
    for (const [id, version] of Object.entries(events)) map.set(id, version ?? null);
    return map;
  }
  throw new TypeError('unsupported events shape');
}

export class HotReloadPlanner {
  #deps = new Map();
  #entries = new Map();
  #retired = new Set();
  #loaders = new Map();
  #fallbackLoader;
  #nonReloadable;
  #dispose;
  #onCommit;
  #onRollback;
  #pending = new Map();
  #pumping = false;
  #currentTx = null;
  #txSeq = 0;

  constructor({
    graph = {},
    versions = {},
    data = {},
    loaders = {},
    loader = null,
    nonReloadable = [],
    dispose = null,
    onCommit = null,
    onRollback = null,
  } = {}) {
    for (const [id, deps] of Object.entries(graph)) {
      this.#deps.set(id, new Set(deps));
    }
    for (const [id, version] of Object.entries(versions)) {
      this.#entries.set(id, { version, data: data[id], refs: 0, retired: false });
    }
    for (const [id, fn] of Object.entries(loaders)) this.#loaders.set(id, fn);
    this.#fallbackLoader = loader;
    this.#nonReloadable = new Set(nonReloadable);
    this.#dispose = dispose;
    this.#onCommit = onCommit;
    this.#onRollback = onRollback;
  }

  // ---- 只读状态 ----

  has(id) {
    return this.#entries.has(id);
  }

  getVersion(id) {
    return this.#entries.get(id)?.version ?? null;
  }

  getData(id) {
    return this.#entries.get(id)?.data;
  }

  snapshot() {
    const versions = {};
    for (const [id, entry] of this.#entries) versions[id] = entry.version;
    return versions;
  }

  setDependencies(id, deps) {
    this.#deps.set(id, new Set(deps));
  }

  // ---- 句柄：读取中的资源在切换后依然可读 ----

  acquire(id) {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`resource not available: ${id}`);
    entry.refs += 1;
    let released = false;
    return {
      id,
      get version() {
        return entry.version;
      },
      get data() {
        return entry.data;
      },
      release: () => {
        if (released) return;
        released = true;
        entry.refs -= 1;
        this.#maybeDispose(id, entry);
      },
    };
  }

  #maybeDispose(id, entry) {
    if (entry.retired && entry.refs === 0 && this.#retired.has(entry)) {
      this.#retired.delete(entry);
      this.#dispose?.(id, entry.data, entry.version);
    }
  }

  // ---- 更新入口 ----

  // 返回 Promise，解析为该批事件所在事务的结果：
  // { status: 'committed' | 'rolled-back' | 'cancelled' | 'rejected' | 'noop', ... }
  update(events, { interrupt = false } = {}) {
    const normalized = normalizeEvents(events);
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    if (normalized.size === 0) {
      resolve({ status: 'noop', committed: {}, invalidated: [] });
      return promise;
    }
    const waiter = { resolve };
    for (const [id, version] of normalized) {
      const existing = this.#pending.get(id);
      if (existing) {
        existing.version = version; // 重复事件合并，最新版本胜出
        existing.waiters.add(waiter);
      } else {
        this.#pending.set(id, { version, waiters: new Set([waiter]) });
      }
    }
    if (interrupt) this.#interrupt();
    this.#pump();
    return promise;
  }

  // 取消进行中的事务并丢弃排队事件；旧版本保持不变。
  cancel() {
    for (const entry of this.#pending.values()) {
      this.#settle(entry, { status: 'cancelled', committed: {}, invalidated: [] });
    }
    this.#pending.clear();
    if (this.#currentTx) this.#currentTx.abort();
  }

  #interrupt() {
    if (!this.#currentTx) return;
    this.#currentTx.requeueOnCancel = true;
    this.#currentTx.abort();
  }

  #settle(entry, result) {
    for (const waiter of entry.waiters) waiter.resolve(result);
    entry.waiters.clear();
  }

  // ---- 事务队列：任何时刻最多一个进行中事务 ----

  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    (async () => {
      try {
        while (this.#pending.size > 0) {
          const events = this.#pending;
          this.#pending = new Map();
          const tx = this.#createTx(events);
          this.#currentTx = tx;
          const result = await this.#runTx(tx);
          this.#currentTx = null;
          if (result.status === 'cancelled' && tx.requeueOnCancel) {
            // 被 interrupt 打断：把原事件并回队列，与新事件合并后重新规划
            for (const [id, entry] of events) {
              this.#settle(entry, result); // 原调用方收到 cancelled
              if (!this.#pending.has(id)) {
                this.#pending.set(id, entry);
              }
            }
          } else {
            for (const entry of events.values()) this.#settle(entry, result);
          }
        }
      } finally {
        this.#pumping = false;
      }
    })();
  }

  #createTx(events) {
    const controller = new AbortController();
    let cancelReject;
    const cancelPromise = new Promise((_, reject) => {
      cancelReject = reject;
    });
    cancelPromise.catch(() => {});
    const tx = {
      id: ++this.#txSeq,
      events,
      signal: controller.signal,
      cancelPromise,
      requeueOnCancel: false,
      cancelled: false,
      warnings: [],
      reads: [],
      abort() {
        if (tx.cancelled) return;
        tx.cancelled = true;
        controller.abort();
        cancelReject(new CancelledError());
      },
    };
    return tx;
  }

  // ---- 规划 ----

  #dependentsMap() {
    const reverse = new Map();
    for (const [id, deps] of this.#deps) {
      for (const dep of deps) {
        if (!reverse.has(dep)) reverse.set(dep, new Set());
        reverse.get(dep).add(id);
      }
    }
    return reverse;
  }

  #resolveLoader(id) {
    return this.#loaders.get(id) ?? this.#fallbackLoader ?? null;
  }

  #plan(tx) {
    const changed = new Map();
    for (const [id, entry] of tx.events) {
      const current = this.#entries.get(id)?.version ?? null;
      if (entry.version === current) continue; // 重复事件：与当前版本一致，跳过
      changed.set(id, entry.version);
    }
    if (changed.size === 0) return { kind: 'noop' };

    const reverse = this.#dependentsMap();
    const invalidated = computeInvalidation(changed.keys(), (id) => reverse.get(id) ?? []);

    for (const id of invalidated) {
      const isDeletion = changed.get(id) === null;
      if (this.#nonReloadable.has(id)) {
        return { kind: 'rejected', reason: `resource is not hot-reloadable: ${id}` };
      }
      if (!isDeletion && !this.#resolveLoader(id)) {
        return { kind: 'rejected', reason: `no loader registered for: ${id}` };
      }
    }

    const order = orderByDependency(invalidated, (id) => this.#deps.get(id) ?? []);
    return { kind: 'ok', changed, invalidated, order };
  }

  // ---- 执行 ----

  async #runTx(tx) {
    const plan = this.#plan(tx);
    if (plan.kind === 'noop') {
      return { status: 'noop', transactionId: tx.id, committed: {}, invalidated: [] };
    }
    if (plan.kind === 'rejected') {
      return {
        status: 'rejected',
        transactionId: tx.id,
        reason: plan.reason,
        committed: {},
        invalidated: [],
      };
    }

    const staged = new Map();
    const deletions = new Set();
    for (const [id, version] of plan.changed) {
      if (version === null) deletions.add(id);
    }

    try {
      for (const group of plan.order) {
        const loads = [...group]
          .filter((id) => !deletions.has(id))
          .map((id) => this.#loadOne(tx, id, plan, staged, deletions));
        await Promise.race([Promise.all(loads), tx.cancelPromise]);
      }
      const committed = this.#commit(tx, plan, staged, deletions);
      return {
        status: 'committed',
        transactionId: tx.id,
        committed,
        invalidated: [...plan.invalidated],
        warnings: tx.warnings,
      };
    } catch (error) {
      // 回退：丢弃暂存数据，旧版本与旧句柄完全不受影响
      for (const [id, item] of staged) this.#dispose?.(id, item.data, item.version);
      if (error instanceof CancelledError) {
        return { status: 'cancelled', transactionId: tx.id, committed: {}, invalidated: [] };
      }
      this.#onRollback?.({ transactionId: tx.id, error, invalidated: [...plan.invalidated] });
      return {
        status: 'rolled-back',
        transactionId: tx.id,
        error,
        committed: {},
        invalidated: [...plan.invalidated],
      };
    }
  }

  async #loadOne(tx, id, plan, staged, deletions) {
    const version = plan.changed.has(id)
      ? plan.changed.get(id)
      : this.#entries.get(id)?.version ?? null;
    const load = this.#resolveLoader(id);
    const ctx = {
      id,
      version,
      signal: tx.signal,
      dependencies: [...(this.#deps.get(id) ?? [])],
      has: (depId) =>
        !deletions.has(depId) && (staged.has(depId) || this.#entries.has(depId)),
      get: (depId) => {
        if (deletions.has(depId)) throw new Error(`dependency deleted: ${depId}`);
        if (staged.has(depId)) {
          const item = staged.get(depId);
          tx.reads.push({ from: id, to: depId, version: item.version });
          return item.data;
        }
        const entry = this.#entries.get(depId);
        if (!entry) throw new Error(`dependency missing: ${depId}`);
        if (plan.invalidated.has(depId)) {
          // 循环依赖：对端尚未暂存完成，只能读到旧版本；
          // 环内成员在提交时整体切换，此读取不参与版本混用校验
          tx.warnings.push(`cycle fallback: ${id} read stale ${depId}`);
          tx.reads.push({ from: id, to: depId, version: entry.version, stale: true });
          return entry.data;
        }
        tx.reads.push({ from: id, to: depId, version: entry.version });
        return entry.data;
      },
    };
    const data = await load(id, version, ctx);
    if (tx.cancelled) throw new CancelledError();
    staged.set(id, { version, data });
  }

  // 提交是同步的：一次性交换所有版本，不存在中间态。
  #commit(tx, plan, staged, deletions) {
    // 版本混用校验：准备期间读到的依赖版本必须与最终提交的版本一致
    for (const read of tx.reads) {
      if (read.stale) continue;
      const finalVersion = staged.has(read.to)
        ? staged.get(read.to).version
        : deletions.has(read.to)
          ? null
          : this.#entries.get(read.to)?.version ?? null;
      if (finalVersion !== read.version) {
        throw new Error(
          `version mixing detected: ${read.from} read ${read.to}@${read.version}, final is ${finalVersion}`,
        );
      }
    }

    const committed = {};
    for (const id of deletions) {
      this.#retire(id);
      committed[id] = null;
    }
    for (const [id, item] of staged) {
      this.#retire(id);
      this.#entries.set(id, { version: item.version, data: item.data, refs: 0, retired: false });
      committed[id] = item.version;
    }
    this.#onCommit?.({ transactionId: tx.id, committed });
    return committed;
  }

  #retire(id) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    this.#entries.delete(id);
    entry.retired = true;
    this.#retired.add(entry);
    this.#maybeDispose(id, entry);
  }
}
