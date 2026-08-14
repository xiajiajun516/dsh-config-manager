/**
 * CSS Modules 类型声明（dsh-ssh 同款：src/client/css-modules.d.ts）。
 * p3 的 tsdown 构建需配置 CSS Modules 处理（dsh-ssh 用 lightningcss）。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
