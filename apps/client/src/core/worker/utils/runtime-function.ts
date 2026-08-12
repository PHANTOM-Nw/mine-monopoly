/**
 * 地图里的各种代码字段（角色初始化、地图事件、结束规则……）都是可选的：
 * 编辑器允许留空，序列化器也明确不为空代码生成 .ts 文件
 * （map-serializer.ts 的 `if (initCode)`）。
 *
 * 但 `new Function("")()` 返回的是 undefined 而不是抛异常，
 * 于是「编译失败」的 try/catch 抓不到它，undefined 一路漏到调用点才炸成
 * "xxx is not a function"，把整个 Worker 打进安全模式。
 *
 * 这里统一收口：编译结果不是函数就换成一个安全的替身。
 */

/**
 * 把动态编译的结果规整成一定可调用的函数。
 *
 * @param compiled - `new Function(code)()` 的返回值
 * @param fallback - 结果不可调用时的替身，默认空实现
 */
export function asRuntimeFunction<T extends (...args: any[]) => any>(
	compiled: unknown,
	fallback: T,
): T {
	return typeof compiled === "function" ? (compiled as T) : fallback;
}

/** 什么都不做的替身，给「留空即无行为」的代码字段用 */
export const NOOP_RUNTIME_FN = (() => undefined) as (...args: any[]) => any;
