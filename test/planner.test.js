import test from 'node:test';
import assert from 'node:assert/strict';
import { HotReloadPlanner } from '../index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 材质 ← 贴图，模型 ← 材质 的三级链。
// loader 记录加载顺序，可通过 options.failWhen / options.delays 注入失败与延迟。
function buildChain({ failWhen, delays = {}, extra = {} } = {}) {
  const log = [];
  const disposed = [];
  const commits = [];
  const planner = new HotReloadPlanner({
    graph: { texture: [], material: ['texture'], model: ['material'] },
    versions: { texture: 'tex@1', material: 'mat@1', model: 'mdl@1' },
    data: {
      texture: { pixels: 'old-pixels' },
      material: { shader: 'old-shader' },
      model: { mesh: 'old-mesh' },
    },
    loader: async (id, version, ctx) => {
      log.push(`begin:${id}@${version}`);
      if (delays[id]) await sleep(delays[id]);
      const deps = {};
      for (const dep of ctx.dependencies) {
        deps[dep] = ctx.has(dep) ? ctx.get(dep) : null;
      }
      if (failWhen?.(id, version, deps)) throw new Error(`load failed: ${id}@${version}`);
      log.push(`end:${id}@${version}`);
      return { id, version, deps };
    },
    dispose: (id, data, version) => disposed.push({ id, version }),
    onCommit: ({ committed }) => commits.push(committed),
    ...extra,
  });
  return { planner, log, disposed, commits };
}

test('成功切换：贴图更新使材质与模型级联失效，按拓扑顺序准备并原子提交', async () => {
  const { planner, log } = buildChain();
  const result = await planner.update({ texture: 'tex@2' });

  assert.equal(result.status, 'committed');
  assert.deepEqual(
    new Set(result.invalidated),
    new Set(['texture', 'material', 'model']),
  );
  assert.equal(result.committed.texture, 'tex@2');
  assert.equal(result.committed.material, 'mat@1'); // 版本号不变，但数据被重新准备

  // 拓扑顺序：texture 先于 material，material 先于 model
  const beginOf = (id) => log.findIndex((l) => l.startsWith(`begin:${id}@`));
  assert.ok(beginOf('texture') < beginOf('material'));
  assert.ok(beginOf('material') < beginOf('model'));

  // 无版本混用：material 准备时读到的是新贴图
  assert.equal(planner.getData('material').deps.texture.version, 'tex@2');
  assert.equal(planner.getData('model').deps.material.version, 'mat@1');
  assert.equal(planner.getVersion('texture'), 'tex@2');
});

test('部分失败：材质加载失败时整体回退，旧版本与旧句柄保持可读', async () => {
  const { planner, commits } = buildChain({
    failWhen: (id, version, deps) => id === 'material' && deps.texture?.version === 'tex@bad',
  });
  const handle = planner.acquire('model');
  const oldData = handle.data;

  const result = await planner.update({ texture: 'tex@bad' });

  assert.equal(result.status, 'rolled-back');
  assert.equal(commits.length, 0);
  assert.deepEqual(planner.snapshot(), { texture: 'tex@1', material: 'mat@1', model: 'mdl@1' });
  // 旧句柄仍然可读，且内容未被新数据污染
  assert.equal(handle.data, oldData);
  assert.equal(handle.version, 'mdl@1');
  assert.equal(planner.getData('texture').pixels, 'old-pixels');
  handle.release();
});

test('循环依赖：环上资源作为整体原子切换', async () => {
  const planner = new HotReloadPlanner({
    graph: { a: ['b'], b: ['a'], c: ['a'] },
    versions: { a: 'a@1', b: 'b@1', c: 'c@1' },
    data: { a: 1, b: 2, c: 3 },
    loader: async (id, version, ctx) => {
      const deps = {};
      for (const dep of ctx.dependencies) deps[dep] = ctx.get(dep);
      return { id, version, deps };
    },
  });
  const result = await planner.update({ a: 'a@2' });
  assert.equal(result.status, 'committed');
  assert.deepEqual(new Set(result.invalidated), new Set(['a', 'b', 'c']));
  assert.equal(planner.getVersion('a'), 'a@2');
  assert.equal(planner.getData('c').deps.a.version, 'a@2');
});

test('并发更新：事务串行执行，互不交错', async () => {
  const { planner, commits } = buildChain({ delays: { texture: 20 } });
  const [r1, r2] = await Promise.all([
    planner.update({ texture: 'tex@2' }),
    planner.update({ material: 'mat@2' }),
  ]);
  assert.equal(r1.status, 'committed');
  assert.equal(r2.status, 'committed');
  assert.equal(commits.length, 2);
  assert.deepEqual(planner.snapshot(), { texture: 'tex@2', material: 'mat@2', model: 'mdl@1' });
  // 第二个事务里 material 读到的是已提交的 tex@2
  assert.equal(planner.getData('material').deps.texture.version, 'tex@2');
});

test('加载中再次更新：排队执行，最终状态为最新版本且无混用', async () => {
  const { planner } = buildChain({ delays: { texture: 30 } });
  const p1 = planner.update({ texture: 'tex@2' });
  await sleep(5); // 确保第一个事务已进入加载阶段
  const p2 = planner.update({ texture: 'tex@3' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'committed');
  assert.equal(r2.status, 'committed');
  assert.equal(planner.getVersion('texture'), 'tex@3');
  assert.equal(planner.getData('material').deps.texture.version, 'tex@3');
});

test('加载中再次更新（interrupt）：打断进行中事务并以最新事件重新规划', async () => {
  const { planner, commits } = buildChain({ delays: { texture: 30 } });
  const p1 = planner.update({ texture: 'tex@2' });
  await sleep(5);
  const p2 = planner.update({ texture: 'tex@3' }, { interrupt: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'cancelled');
  assert.equal(r2.status, 'committed');
  // tex@2 从未提交过
  assert.ok(commits.every((c) => c.texture !== 'tex@2'));
  assert.equal(planner.getVersion('texture'), 'tex@3');
});

test('资源删除：删除后不可再获取，旧句柄仍可读，依赖方感知缺失', async () => {
  const { planner } = buildChain();
  const handle = planner.acquire('texture');

  const result = await planner.update({ texture: null });
  assert.equal(result.status, 'committed');
  assert.equal(result.committed.texture, null);
  assert.equal(planner.has('texture'), false);
  assert.throws(() => planner.acquire('texture'), /not available/);
  // 旧句柄仍然可读
  assert.equal(handle.data.pixels, 'old-pixels');
  // material 重新准备时看到贴图已缺失
  assert.equal(planner.getData('material').deps.texture, null);
  handle.release();
});

test('重复事件：与当前版本相同为 noop；同批重复事件只加载一次', async () => {
  const { planner, log } = buildChain();

  const noop = await planner.update({ texture: 'tex@1' });
  assert.equal(noop.status, 'noop');
  assert.equal(log.length, 0);

  const result = await planner.update([
    { id: 'texture', version: 'tex@2' },
    { id: 'texture', version: 'tex@2' },
  ]);
  assert.equal(result.status, 'committed');
  assert.equal(log.filter((l) => l.startsWith('begin:texture@')).length, 1);
});

test('取消：进行中事务被中止，版本不变，后续更新可继续', async () => {
  const { planner, commits } = buildChain({ delays: { texture: 30 } });
  const p = planner.update({ texture: 'tex@2' });
  await sleep(5);
  planner.cancel();
  const result = await p;
  assert.equal(result.status, 'cancelled');
  assert.equal(commits.length, 0);
  assert.deepEqual(planner.snapshot(), { texture: 'tex@1', material: 'mat@1', model: 'mdl@1' });

  const again = await planner.update({ texture: 'tex@3' });
  assert.equal(again.status, 'committed');
  assert.equal(planner.getVersion('texture'), 'tex@3');
});

test('旧句柄释放：切换后旧数据继续可读，释放后触发 dispose', async () => {
  const { planner, disposed } = buildChain();
  const handle = planner.acquire('texture');
  assert.equal(handle.version, 'tex@1');

  await planner.update({ texture: 'tex@2' });

  // 切换后旧句柄仍读到旧版本数据
  assert.equal(handle.version, 'tex@1');
  assert.equal(handle.data.pixels, 'old-pixels');
  // 新句柄读到新版本
  const fresh = planner.acquire('texture');
  assert.equal(fresh.version, 'tex@2');
  fresh.release();

  assert.ok(disposed.every((d) => d.id !== 'texture')); // 旧贴图仍被句柄引用，不能销毁
  handle.release();
  assert.deepEqual(
    disposed.filter((d) => d.id === 'texture'),
    [{ id: 'texture', version: 'tex@1' }],
  );
});

test('无法热替换的资源：命中失效集合时整体拒绝，不产生任何副作用', async () => {
  const { planner, log, commits } = buildChain({ extra: { nonReloadable: ['model'] } });
  const result = await planner.update({ texture: 'tex@2' });
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /model/);
  assert.equal(log.length, 0);
  assert.equal(commits.length, 0);
  assert.deepEqual(planner.snapshot(), { texture: 'tex@1', material: 'mat@1', model: 'mdl@1' });
});

test('无版本混用：提交前校验准备期读取的依赖版本与最终版本一致', async () => {
  const { planner } = buildChain();
  const result = await planner.update({ texture: 'tex@2', material: 'mat@2' });
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.warnings, []);
  // model 读到的 material 与 material 读到的 texture 都是本事务的新版本
  assert.equal(planner.getData('material').deps.texture.version, 'tex@2');
  assert.equal(planner.getData('model').deps.material.version, 'mat@2');
});
