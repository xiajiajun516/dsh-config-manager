/**
 * m-market：index.json（L1）与 items/<id>/manifest.json（L2）的纯字符串级解析与校验。
 * 零 fs、零副作用、node 可测。返回 ok/errors，绝不抛错（调用方决定如何呈现）。
 *
 * 安全纪律：
 *  - 深度保护解析（parseJsonSafe）；
 *  - 字段白名单：允许字段之外的多出字段一律进 errors（拒绝，不忽略 —— 防字段渗透）；
 *  - schemaVersion === 1 强制；
 *  - items 每项 id 过 SAFE_ITEM_ID_RE。
 */
import { parseJsonSafe } from '../utils/json.ts';
import { SAFE_ITEM_ID_RE, MARKET_INDEX_SCHEMA_VERSION, MARKET_ITEM_SCHEMA_VERSION } from './types.ts';
import type {
  MarketIndex, MarketIndexItem, MarketItemManifest, ParseIndexResult, ParseItemManifestResult,
} from './types.ts';
import { SECTION_IDS } from '../schema/config.ts';
import type { SectionId } from '../schema/types.ts';

const INDEX_ALLOWED = new Set(['schemaVersion', 'name', 'description', 'items']);
const INDEX_ITEM_ALLOWED = new Set(['id', 'name', 'description', 'author', 'version', 'updatedAt', 'categories']);
const MANIFEST_ALLOWED = new Set([
  'schemaVersion', 'id', 'name', 'version', 'author', 'description', 'updatedAt',
  'categories', 'sections', 'provenance', 'checksums',
]);
const PROVENANCE_ALLOWED = new Set(['source', 'note']);
const CHECKSUMS_ALLOWED = new Set(['zip']);

/** 校验未知字段；返回多余字段名数组（非空 → 拒绝） */
function unknownFields(obj: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !allowed.has(k));
}

/** 可选字符串字段：合法非空字符串则取，否则 null；非字符串 → errors（拒绝） */
function optString(obj: Record<string, unknown>, key: string, errors: string[], path: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    errors.push(`${path}.${key} 必须是字符串`);
    return undefined;
  }
  return v;
}

/** 可选字符串数组字段（categories）：数组且全为字符串，否则 errors */
function optStringArray(obj: Record<string, unknown>, key: string, errors: string[], path: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push(`${path}.${key} 必须是字符串数组`);
    return undefined;
  }
  return v as string[];
}

/** 解析并校验单条 MarketIndexItem（L1）；非法返回 null + errors */
function parseIndexItem(raw: unknown, errors: string[], inPath: string): MarketIndexItem | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${inPath} 必须是对象`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const uf = unknownFields(obj, INDEX_ITEM_ALLOWED);
  if (uf.length > 0) {
    errors.push(`${inPath} 含未知字段: ${uf.join(', ')}`);
    return null;
  }
  const id = obj['id'];
  if (typeof id !== 'string' || !SAFE_ITEM_ID_RE.test(id)) {
    errors.push(`${inPath}.id 非法: ${JSON.stringify(id)}（仅允许字母数字开头，字符限 . _ -）`);
    return null;
  }
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    errors.push(`${inPath}.name 必须是非空字符串`);
    return null;
  }
  return {
    id,
    name,
    description: optString(obj, 'description', errors, inPath),
    author: optString(obj, 'author', errors, inPath),
    version: optString(obj, 'version', errors, inPath),
    updatedAt: optString(obj, 'updatedAt', errors, inPath),
    categories: optStringArray(obj, 'categories', errors, inPath),
  };
}

/**
 * 解析市场目录 index.json（L1）。未知字段/越界字段一律进 errors（拒绝，不忽略）。
 * 深度保护 + 字段白名单 + schemaVersion===1 + items 每项 id 过 SAFE_ITEM_ID_RE。
 */
export function parseMarketIndex(raw: string): ParseIndexResult {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, index: null, errors: ['index.json 内容为空'] };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch (err) {
    return { ok: false, index: null, errors: [`index.json 解析失败: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, index: null, errors: ['index.json 必须是对象'] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  const uf = unknownFields(obj, INDEX_ALLOWED);
  if (uf.length > 0) {
    return { ok: false, index: null, errors: [`index.json 含未知字段: ${uf.join(', ')}`] };
  }
  if (obj['schemaVersion'] !== MARKET_INDEX_SCHEMA_VERSION) {
    return { ok: false, index: null, errors: [`index.json schemaVersion 必须是 ${MARKET_INDEX_SCHEMA_VERSION}（收到 ${String(obj['schemaVersion'])}）`] };
  }
  if (obj['items'] === undefined || !Array.isArray(obj['items'])) {
    return { ok: false, index: null, errors: ['index.json 缺少 items 数组'] };
  }
  const items: MarketIndexItem[] = [];
  (obj['items'] as unknown[]).forEach((item, i) => {
    const parsedItem = parseIndexItem(item, errors, `items[${i}]`);
    if (parsedItem !== null) items.push(parsedItem);
  });
  if (errors.length > 0) {
    return { ok: false, index: null, errors };
  }
  const index: MarketIndex = {
    schemaVersion: MARKET_INDEX_SCHEMA_VERSION,
    name: optString(obj, 'name', errors, '$'),
    description: optString(obj, 'description', errors, '$'),
    items,
  };
  if (errors.length > 0) return { ok: false, index: null, errors };
  return { ok: true, index, errors: [] };
}

/**
 * 解析单条目清单 items/<id>/manifest.json（L2）。
 * 未知字段/越界字段一律进 errors；id 必须过 SAFE_ITEM_ID_RE；
 * sections 每项必须 ∈ SECTION_IDS；checksums.zip 必须为非空字符串。
 */
export function parseMarketItemManifest(raw: string): ParseItemManifestResult {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, manifest: null, errors: ['manifest.json 内容为空'] };
  }
  let parsed: unknown;
  try {
    parsed = parseJsonSafe(raw);
  } catch (err) {
    return { ok: false, manifest: null, errors: [`manifest.json 解析失败: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, manifest: null, errors: ['manifest.json 必须是对象'] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  const uf = unknownFields(obj, MANIFEST_ALLOWED);
  if (uf.length > 0) {
    return { ok: false, manifest: null, errors: [`manifest.json 含未知字段: ${uf.join(', ')}`] };
  }
  if (obj['schemaVersion'] !== MARKET_ITEM_SCHEMA_VERSION) {
    return { ok: false, manifest: null, errors: [`manifest.json schemaVersion 必须是 ${MARKET_ITEM_SCHEMA_VERSION}（收到 ${String(obj['schemaVersion'])}）`] };
  }
  const id = obj['id'];
  if (typeof id !== 'string' || !SAFE_ITEM_ID_RE.test(id)) {
    return { ok: false, manifest: null, errors: [`manifest.json.id 非法: ${JSON.stringify(id)}`] };
  }
  const name = obj['name'];
  if (typeof name !== 'string' || name === '') {
    return { ok: false, manifest: null, errors: ['manifest.json.name 必须是非空字符串'] };
  }
  const version = obj['version'];
  if (typeof version !== 'string' || version === '') {
    return { ok: false, manifest: null, errors: ['manifest.json.version 必须是非空字符串'] };
  }
  if (!Array.isArray(obj['sections']) || obj['sections'].some((s) => typeof s !== 'string')) {
    return { ok: false, manifest: null, errors: ['manifest.json.sections 必须是字符串数组'] };
  }
  const sections = obj['sections'] as unknown[];
  for (const s of sections) {
    if (!(SECTION_IDS as readonly string[]).includes(s as string)) {
      return { ok: false, manifest: null, errors: [`manifest.json.sections 含未知分区: ${String(s)}`] };
    }
  }
  const checksums = obj['checksums'];
  if (checksums === null || typeof checksums !== 'object' || Array.isArray(checksums)) {
    return { ok: false, manifest: null, errors: ['manifest.json.checksums 必须是对象'] };
  }
  const csObj = checksums as Record<string, unknown>;
  const csUf = unknownFields(csObj, CHECKSUMS_ALLOWED);
  if (csUf.length > 0) {
    return { ok: false, manifest: null, errors: [`manifest.json.checksums 含未知字段: ${csUf.join(', ')}`] };
  }
  const zip = csObj['zip'];
  if (typeof zip !== 'string' || zip === '') {
    return { ok: false, manifest: null, errors: ['manifest.json.checksums.zip 必须是非空字符串'] };
  }

  let provenance: MarketItemManifest['provenance'];
  if (obj['provenance'] !== undefined) {
    const p = obj['provenance'];
    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, manifest: null, errors: ['manifest.json.provenance 必须是对象'] };
    }
    const pObj = p as Record<string, unknown>;
    const pUf = unknownFields(pObj, PROVENANCE_ALLOWED);
    if (pUf.length > 0) {
      return { ok: false, manifest: null, errors: [`manifest.json.provenance 含未知字段: ${pUf.join(', ')}`] };
    }
    const source = pObj['source'];
    const note = pObj['note'];
    if (source !== undefined && typeof source !== 'string') {
      return { ok: false, manifest: null, errors: ['manifest.json.provenance.source 必须是字符串'] };
    }
    if (note !== undefined && typeof note !== 'string') {
      return { ok: false, manifest: null, errors: ['manifest.json.provenance.note 必须是字符串'] };
    }
    provenance = {
      ...(source !== undefined ? { source } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }

  if (errors.length > 0) return { ok: false, manifest: null, errors };

  return {
    ok: true,
    manifest: {
      schemaVersion: MARKET_ITEM_SCHEMA_VERSION,
      id,
      name,
      version,
      author: optString(obj, 'author', errors, '$'),
      description: optString(obj, 'description', errors, '$'),
      updatedAt: optString(obj, 'updatedAt', errors, '$'),
      categories: optStringArray(obj, 'categories', errors, '$'),
      sections: sections as SectionId[],
      ...(provenance !== undefined ? { provenance } : {}),
      checksums: { zip },
    },
    errors: [],
  };
}
