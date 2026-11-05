// 滚动位置的两样记录：待恢复的位置（页面重建、换会话、返回上一层之后，等内容到了才用）和上层的位置（图标视图进入子目录前的位置，只在内存里）。
// 不碰 DOM：滚动的元素由页面通过 panes 给。设计见 docs/design/phase-3.md 第 14.5 节。
import { View } from './model.mjs';

export const TRAIL_LIMIT = 32;

// 图标视图进入子目录之前，上层的滚动位置：按目录存，最多 limit 层，满了丢最久没用的。不存进 setState：页面卸载后就没了。
export function createTrail(limit = TRAIL_LIMIT) {
  const tops = new Map();
  return {
    remember(dir, top) { tops.delete(dir); tops.set(dir, top); while (tops.size > limit) tops.delete(tops.keys().next().value); },
    // 取出并删掉：回到上一层时用一次。
    take(dir) { const top = tops.get(dir); tops.delete(dir); return top; },
    clear() { tops.clear(); },
    get size() { return tops.size; },
  };
}

const VIEW = { tree: View.LIST, grid: View.ICONS };

// 待恢复的滚动：每个视图（tree、grid）最多一份。不能只等一次 refresh() 完成：旧的一轮完成不等于内容到了，太早设置会被夹回顶部。
// 一份恢复绑定会话、根目录的身份（model.scope）、排序和目录（图标视图是 cwd），任何一个对不上就作废；
// 绑定的视图不是正在看的视图时等着，切过去才用。目标目录的内容到了才用，条数不够时浏览器夹到能到的最大值；加载失败就结束；用户自己滚动了就放弃。
// panes：{ tree, grid }，各有 scroll() 和 scrollTo(top)。
export function createRestore(model, panes) {
  const plans = { tree: null, grid: null };
  // 内容到了：列表是根和展开的目录，图标是 cwd；每个都已经加载（或失败了，失败也算有结果），空着的、没发出的不算。
  const dirsOf = key => (key === 'grid' ? [model.cwd] : ['', ...model.expanded]);
  const bound = (key, plan) => plan.session === model.session && plan.scope === model.scope && plan.sort === model.sort && (key === 'tree' || plan.dir === model.cwd);

  return {
    // 现在的滚动位置就是用户没动过的基准：调用前页面先把滚动元素滚到顶部。
    plan(key, top) {
      plans[key] = { session: model.session, scope: model.scope, sort: model.sort, dir: key === 'grid' ? model.cwd : '', top, at: panes[key].scroll() };
    },
    drop(key) { plans[key] = null; },
    clear() { plans.tree = plans.grid = null; },
    // 还在等的位置（保存状态时用它，别存成还没恢复的 0）；对不上的不算。
    top(key) { return plans[key] && bound(key, plans[key]) ? plans[key].top : null; },
    // 滚动事件：位置不是计划时的基准，就是用户自己滚的，不再跳回去。
    scrolled(key) { if (plans[key] && panes[key].scroll() !== plans[key].at) plans[key] = null; },
    // 每次重画之后调用。
    settle() {
      for (const key of Object.keys(plans)) {
        const plan = plans[key];
        if (!plan) continue;
        if (!bound(key, plan)) { plans[key] = null; continue; }
        if (model.view !== VIEW[key]) continue;
        const states = dirsOf(key).map(dir => model.dirs.get(dir));
        if (key === 'grid' && states[0] && !states[0].loaded && states[0].error) { plans[key] = null; continue; }
        if (!states.every(state => state && (state.loaded || state.error))) continue;
        plans[key] = null;
        panes[key].scrollTo(plan.top);
      }
    },
  };
}
