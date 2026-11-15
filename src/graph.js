// 依赖图算法：失效传播与带循环依赖的拓扑排序。

// 从变更集合出发，沿“被谁依赖”的反向边做闭包传播，
// 得到需要失效（重新准备）的完整资源集合。
export function computeInvalidation(changedIds, dependentsOf) {
  const invalidated = new Set();
  const stack = [...changedIds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (invalidated.has(id)) continue;
    invalidated.add(id);
    for (const dependent of dependentsOf(id)) {
      if (!invalidated.has(dependent)) stack.push(dependent);
    }
  }
  return invalidated;
}

// 对失效集合的诱导子图做 Tarjan 强连通分量分解，
// 再按“依赖在前、依赖方在后”的顺序输出 SCC 列表。
// 同一 SCC 内的资源互为循环依赖，必须作为一个整体原子准备与切换。
export function orderByDependency(ids, depsOf) {
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  const strongconnect = (node) => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const dep of depsOf(node)) {
      if (!ids.has(dep)) continue;
      if (!index.has(dep)) {
        strongconnect(dep);
        lowlink.set(node, Math.min(lowlink.get(node), lowlink.get(dep)));
      } else if (onStack.has(dep)) {
        lowlink.set(node, Math.min(lowlink.get(node), index.get(dep)));
      }
    }
    if (lowlink.get(node) === index.get(node)) {
      const scc = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        scc.push(member);
      } while (member !== node);
      sccs.push(scc);
    }
  };

  for (const id of ids) {
    if (!index.has(id)) strongconnect(id);
  }

  const sccOf = new Map();
  sccs.forEach((scc, i) => scc.forEach((id) => sccOf.set(id, i)));

  const visited = new Set();
  const ordered = [];
  const visit = (i) => {
    if (visited.has(i)) return;
    visited.add(i);
    for (const id of sccs[i]) {
      for (const dep of depsOf(id)) {
        if (ids.has(dep)) visit(sccOf.get(dep));
      }
    }
    ordered.push(sccs[i]);
  };
  for (let i = 0; i < sccs.length; i += 1) visit(i);
  return ordered;
}
