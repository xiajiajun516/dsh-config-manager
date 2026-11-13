/**
 * `js-yaml@4.x` 的最小类型面（issue #135）。
 *
 * 为什么要有这个声明：DSH 本体读 `cordis.patch.yml` 用的是随包的 js-yaml 4.x，
 * 而本插件用 5.x 写。要证明「写出去的字节两边读到同一个值」，只能真的把 4.x 装上读一遍；
 * 4.x 以 devDependency 别名 `js-yaml4`（`npm:js-yaml@^4.3.2`）安装，没有随包类型，
 * `@types/js-yaml` 是 5.x 的形状、不能复用。
 *
 * 范围刻意只到「测试需要的最小面」：schema 扩展与 load。运行时依赖仍然只有 `js-yaml`。
 */
declare module 'js-yaml4' {
  export interface JsYaml4TypeOptions {
    kind: 'scalar' | 'sequence' | 'mapping'
    /** 显式标签（`!!foo`）的构造：4.x 只在标签被显式写出时调用。 */
    construct?: (data: unknown) => unknown
    /** 隐式解析的判据（字符串 → 是否属于本类型）。 */
    resolve?: (data: string) => boolean
    /** 写回时：内存值是否属于本类型。 */
    predicate?: (data: unknown) => boolean
    /** 写回时：把内存值还原成源码文本。 */
    represent?: (data: unknown) => unknown
  }

  export class Type {
    constructor(tag: string, options: JsYaml4TypeOptions)
  }

  export interface JsYaml4Schema {
    extend(types: Type[]): JsYaml4Schema
  }

  export const JSON_SCHEMA: JsYaml4Schema

  export function load(input: string, options?: { schema?: JsYaml4Schema }): unknown
}
