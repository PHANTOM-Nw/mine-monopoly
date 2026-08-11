/**
 * 房间人数上限相关常量与工具。
 *
 * 房间是 P2P 星型拓扑：所有客户端都连到房主，房主的上行带宽随人数线性增长，
 * 走 TURN 中继时更明显。因此硬顶取一个保守值，房主可在此范围内自行调整。
 */

/** 房间人数上限的下限（房主 + 至少一名对手） */
export const MIN_ROOM_PLAYERS = 2;

/** 房间人数上限的硬顶（受 AI 调色板容量与房主上行带宽约束） */
export const MAX_ROOM_PLAYERS_LIMIT = 12;

/** 房主未设置时的默认人数上限 */
export const DEFAULT_ROOM_PLAYERS = 6;

/**
 * 将任意输入收敛为合法的房间人数上限。
 * 非数字/非整数一律回落到默认值，避免脏数据把房间卡死。
 *
 * @param value - 待校验的值
 * @returns 位于 [MIN_ROOM_PLAYERS, MAX_ROOM_PLAYERS_LIMIT] 区间内的整数
 */
export function clampRoomPlayerLimit(value: unknown): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return DEFAULT_ROOM_PLAYERS;
	return Math.min(MAX_ROOM_PLAYERS_LIMIT, Math.max(MIN_ROOM_PLAYERS, Math.floor(num)));
}

/**
 * 按人数上限计算房间座位网格的列数，尽量排满且不过于扁平。
 *
 * @param maxPlayers - 房间人数上限
 * @returns 座位网格列数
 */
export function getRoomSeatColumns(maxPlayers: number): number {
	if (maxPlayers <= 4) return 2;
	if (maxPlayers <= 6) return 3;
	return 4;
}
