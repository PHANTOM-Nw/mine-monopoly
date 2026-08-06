/** 地图审核状态 */
export type GameMapStatus = "reviewing" | "published" | "rejected" | "offline";

/**
 * 数据库游戏地图接口
 * 表示存储在数据库中的游戏地图
 */
export interface GameMapInDb {
	/** 地图唯一标识 */
	id: string;

	/** 地图名称 */
	name: string;

	/** 地图作者 */
	author: string;

	/** 已发布版本号（审核通过时递增） */
	version: number;

	/** 地图描述 */
	description: string;

	/** 地图哈希值 */
	hash: string;

	/** 封面图片 URL */
	coverUrl: string;

	/** 当前公开生效地图数据 URL */
	mapUrl: string;

	/** 是否正在使用 */
	inuse: boolean;

	/** 上传用户 ID；存量/管理员上传为 null */
	creatorId: string | null;

	/** 创作者用户名（列表查询时附带，未绑定时为 null） */
	creatorName?: string | null;

	/** 创作者账号（列表查询时附带，未绑定时为 null） */
	creatorAccount?: string | null;

	/** 审核状态 */
	status: GameMapStatus;

	/** 驳回原因 */
	rejectReason: string | null;

	/** 待审核地图数据 URL */
	pendingUrl: string | null;

	/** 待审核版本的地图源文件（.fpmap）URL，与 pendingUrl 配对 */
	pendingSourceUrl: string | null;

	/** 当前公开版本的地图源文件（.fpmap）URL，与 mapUrl 配对 */
	sourceUrl: string | null;

	/** 待审核地图哈希 */
	pendingHash: string | null;

	/** 作者提交的语义化版本 */
	pendingVersion: string | null;
}

export interface MapKeyInDb {
	id: string;
	userId: string;
	key: string;
	revokedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface AdminAuditLogInDb {
	id: string;
	adminId: string | null;
	targetUserId: string | null;
	action: string;
	detail: string | null;
	createdAt: Date;
}