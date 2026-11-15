/**
 * 生效 patch 链（issue #144）。
 *
 * DSH 启动时把**多层** patch 合并到同一份 plugin 树上（dsh-app-boot 的 readProfilePatches）：
 *   bundle 层（各 bundle 的 `dsh.bundle.patch`，按 `dsh.profile.bundles` 顺序）
 *   → profile 层（`profiles/<profile>/cordis.patch.yml`）
 *   → home 层（`cordis.patch.yml`）→ overlays。
 *
 * 同一个 id 只能有**一份**「新增」来源：两处 `- insert:` 成员会把同一条目插两次，宿主
 * composeEntries 之后拿到的 config 变成数组 / 取到没有 config 的那份，于是插件自己的
 * ConfigEditor 落盘时报
 * `Configuration for "X" is overridden by a home patch or command-line overlay` —— 报错把原因
 * 说反了（真正的原因是「我们插了第二份」，issue #144）。
 *
 * 于是「这个 id 存在吗」必须按**整条链**判定，而不是只看两个 patch 文件（issue #144 之前的
 * 判据只覆盖 home/profile 两层，见 `patchLayerRels`）：
 *   - 链上已存在 ⇒ 只能写**顶层覆盖行**（`- id: X`，带 config；写 name 时必须与既有条目一致，
 *     否则宿主 `patch: name mismatch … skipping` 整行跳过）；
 *   - 链上不存在 ⇒ 只能写 `- insert:` 成员（顶层行会被 `patch: entry not found` 丢弃）。
 *
 * 本模块只做**纯计算**（core 层零依赖、不碰 YAML / IO）：各层文档由宿主门面读好交进来，
 * 三个消费点（导入判定、写后自检、跨层覆盖守卫）共用同一份索引。
 */
import { patchDocumentEntries } from './patch-document.ts';

/** 生效链上的一层：层身份 + 已解析的文档。 */
export interface PatchChainSource {
  /**
   * 层身份。前两种与 `patch-layers.ts` 同口径（相对 homeDir 的 POSIX 路径）；bundle 层用
   * `bundles:<包名>/<patch 文件>` —— 它不是本机可写的层，只用于判重与取 name。
   */
  file: string;
  doc: unknown;
}

/** 门面读到的整条链（宿主合并序）与读失败的层。 */
export interface PatchChainRead {
  /** 宿主合并序：bundle 层在前，然后 profile 层、home 层 */
  sources: PatchChainSource[];
  /** 读不出来 / 解析不了的层（fail-open：判定只做加强，绝不据此拒绝写入） */
  failures: { file: string; reason: string }[];
}

/** 链上某个 id 的合流结果。 */
export interface PatchChainEntry {
  id: string;
  /** 条目声明的 name（写顶层覆盖行时必须与之一致，否则宿主整行跳过） */
  name?: string;
  /** 提供该 id 的层（按合并序去重） */
  layers: string[];
  /** 其中**以 `- insert:` 成员形式**提供该 id 的层 */
  insertLayers: string[];
}

/** 写回结果（`applyPatchChanges` 的返回值）：被降级的 insert id。 */
export interface PatchWriteOutcome {
  /**
   * 本次被**降级为顶层覆盖行**的 id：调用方要求 insert，但链上已有其他层提供该 id
   * （issue #144 的存量修复；正常路径在计划阶段就已判定，这里只是最后一道兜底）。
   */
  downgraded: string[];
}

/** 把整条链折成 id → 层/形态索引（顺序 = 宿主合并序，先出现者优先记 name）。 */
export function patchChainIndex(read: PatchChainRead): Map<string, PatchChainEntry> {
  const index = new Map<string, PatchChainEntry>();
  for (const source of read.sources) {
    for (const entry of patchDocumentEntries(source.doc)) {
      const known = index.get(entry.id);
      if (known === undefined) {
        const fresh: PatchChainEntry = { id: entry.id, layers: [source.file], insertLayers: [] };
        if (entry.name !== undefined) fresh.name = entry.name;
        if (entry.inInsert) fresh.insertLayers.push(source.file);
        index.set(entry.id, fresh);
        continue;
      }
      if (!known.layers.includes(source.file)) known.layers.push(source.file);
      if (entry.inInsert && !known.insertLayers.includes(source.file)) known.insertLayers.push(source.file);
      // name 取**第一个**声明它的层：宿主按既有条目的 name 校验覆盖行，低优先级层的同名条目最终也会被覆盖
      if (known.name === undefined && entry.name !== undefined) known.name = entry.name;
    }
  }
  return index;
}

/** 链上「**本文件之外**的层」提供的 id（写这一层时的判据）。 */
export function providedByOtherLayers(
  index: Map<string, PatchChainEntry>,
  file: string,
): Map<string, PatchChainEntry> {
  const out = new Map<string, PatchChainEntry>();
  for (const [id, entry] of index) {
    if (entry.layers.some((layer) => layer !== file)) out.set(id, entry);
  }
  return out;
}

/** 读整条链并折成索引；门面没实现该能力（老宿主 / 测试替身）→ `null`（判定退化为两层）。 */
export async function readPatchChainIndex(
  patchFile: { readPatchChain?: () => Promise<PatchChainRead> },
): Promise<Map<string, PatchChainEntry> | null> {
  if (patchFile.readPatchChain === undefined) return null;
  return patchChainIndex(await patchFile.readPatchChain());
}
