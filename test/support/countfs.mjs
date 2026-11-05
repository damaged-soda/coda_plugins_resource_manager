// 数文件系统调用的 fs：给 lib/tree.mjs 的 createListing 注入。
// lstat、stat、realpath 是受并发上限管的读取，同时在途的数量记为 peak；让出一次事件循环，并行的请求才真正重叠。
import * as real from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';

const LIMITED = ['lstat', 'stat', 'realpath'];

// hooks：按名字替换实现，如 { readdir: async (path, options, original) => ... }，用来在读目录前后动手脚或卡住。
export function countingFs({ hooks = {} } = {}) {
  const counts = { lstat: 0, stat: 0, realpath: 0, readdir: 0 };
  const state = { counts, active: 0, peak: 0 };
  const wrap = name => async (...args) => {
    counts[name]++;
    const limited = LIMITED.includes(name);
    if (limited) state.peak = Math.max(state.peak, ++state.active);
    try {
      await tick();
      const original = (...rest) => real[name](...rest);
      return await (hooks[name] ? hooks[name](...args, original) : original(...args));
    } finally { if (limited) state.active--; }
  };
  state.fs = { lstat: wrap('lstat'), stat: wrap('stat'), realpath: wrap('realpath'), readdir: wrap('readdir') };
  state.reads = () => counts.lstat + counts.stat + counts.realpath + counts.readdir;
  return state;
}
