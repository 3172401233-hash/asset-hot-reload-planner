# asset-hot-reload-planner
JavaScript 游戏资源热更新规划库，处理依赖失效、原子切换、失败回退和并发加载

## 快速开始

```js
import { HotReloadPlanner } from 'asset-hot-reload-planner';

const planner = new HotReloadPlanner({
  graph: { texture: [], material: ['texture'], model: ['material'] },
  versions: { texture: 'tex@1', material: 'mat@1', model: 'mdl@1' },
  data: { texture: tex1, material: mat1, model: mdl1 },
  loader: async (id, version, ctx) => {
    // ctx.get(depId) 优先读到本事务已暂存的新版本依赖
    const deps = Object.fromEntries(ctx.dependencies.map((d) => [d, ctx.get(d)]));
    return await loadAsset(id, version, deps, ctx.signal);
  },
  dispose: (id, data, version) => data.destroy?.(),
});

const handle = planner.acquire('model');   // 读取中的资源加引用
const result = await planner.update({ texture: 'tex@2' });
// result.status: 'committed' | 'rolled-back' | 'cancelled' | 'rejected' | 'noop'
handle.release();                          // 旧版本数据在引用归零后才销毁
```

运行测试：`npm test`（即 `node --test`）。

## 事务边界

一次 `update()` 构成一个事务，分为三个阶段：

- **规划（同步）**：过滤与当前版本相同的重复事件；从变更资源沿反向依赖边传播，
  得到失效集合；对失效集合做强连通分量分解并按“依赖在前”拓扑排序。
  命中不可热替换资源时整体 `rejected`，不产生任何副作用。
- **准备（异步）**：按拓扑顺序逐层调用 loader，同层（含同一循环依赖环）并发加载。
  此阶段旧版本仍在服务，`acquire()` 拿到的仍是旧数据；loader 通过 `ctx.get()`
  读到的是本事务已暂存的新依赖，保证依赖链上版本一致。
- **提交（同步）**：全部依赖准备成功后，一次性交换所有版本，不存在部分可见的
  中间态。提交前校验准备期读取的依赖版本与最终版本一致，防止版本混用。

任一资源加载失败即整体回退：暂存数据被销毁，当前版本与已有句柄完全不受影响，
场景不会读到“新贴图 + 旧材质”的混合状态。删除用 `update({ id: null })` 表达，
同样参与事务：若依赖方无法容忍缺失，删除随事务一起回退。

## 并发与取消

- 任何时刻最多一个进行中事务；`update()` 事件进入队列，按到达顺序串行执行。
- 加载中再次调用 `update()` 默认排队；传 `{ interrupt: true }` 会取消进行中事务，
  其事件与最新事件合并后重新规划，原调用方收到 `cancelled`。
- `planner.cancel()` 取消进行中事务并清空队列，旧版本保持不变。
- 同一资源的重复事件被合并，最新版本胜出；与当前版本相同的事件直接 `noop`。

## 句柄与旧版本释放

`acquire(id)` 返回的句柄对当时版本的数据持有引用。版本切换后旧句柄依然可读
（读到旧数据），直到 `release()` 且引用归零，旧数据才交给 `dispose` 回调销毁。
这保证渲染途中的帧不会因热更新读到被释放的资源。

## 循环依赖

环上资源（如 A↔B）被识别为同一强连通分量，作为一个整体原子准备与切换。
由于环内不存在合法的加载顺序，loader 在准备期读到环内对端时只能拿到旧版本，
事务结果中以 `warnings` 标注（`cycle fallback`）；提交时环上成员仍一次性切换。

## 无法热替换的资源类型

以下情况会导致事务 `rejected`（整体拒绝，无副作用）：

- 通过 `nonReloadable: [...]` 显式声明的资源（如启动期 baked 的着色器、只读配置）；
- 没有注册任何 loader 的资源（既无专属 `loaders[id]` 也无兜底 `loader`）。

注意判定作用于整个失效集合：若不可热替换的资源依赖于某个变更资源
（例如 `model` 不可热替换而 `texture` 更新），整个事务会被拒绝，
需要重启或走完整重载流程。
