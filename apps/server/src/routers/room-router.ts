import { Router } from "express";
import { randomUUID } from "crypto";
import { createRecord } from "#src/db/api/game-record";
import { ResInterface } from "#src/interfaces/res";
import { User } from "#src/interfaces/bace";
import { verToken } from "#src/utils/token";
import { generateIceServers } from "#src/utils/turn-credentials";

type RoomMapItem = {
	roomId: string;
	hostName: string;
	hostId: string;
	hostPeerId: string | null;
	createTime: number;
	deleteTime: number;
	lastHeartTime: number;
	isPrivate: boolean;
	isStarted: boolean;
	mapId: string | null;
	mapName: string | null;
	status: "active" | "closed" | "expired";
	statusUpdatedAt: number;
	hostLeaseToken: string;
	hostEpoch: number;
};

export const roomRouter = Router();
const heartContinuationTimeMs = 10000; // 房主心跳租约时长
const closedSessionRetentionMs = 5 * 60 * 1000;
const roomMap = new Map<string, RoomMapItem>();

//删除房间定时器
setInterval(() => {
	Array.from(roomMap.entries()).forEach((room) => {
		const roomItem = room[1];
		if (roomItem.status === "active" && roomItem.deleteTime < Date.now()) {
			roomItem.status = "expired";
			roomItem.statusUpdatedAt = Date.now();
			roomItem.hostPeerId = null;
			createRecord(roomItem.roomId, Date.now() - roomItem.createTime, roomItem.mapId, roomItem.mapName);
		}
		if (roomItem.status !== "active" && roomItem.statusUpdatedAt + closedSessionRetentionMs < Date.now()) {
			roomMap.delete(room[0]);
		}
	});
}, 2000);

roomRouter.get("/join", async (req, res, next) => {
	const { roomId } = req.query as { roomId: string; hostName: string; hostId: string };

	// 尝试解析 JWT 获取 userId，用于生成 TURN 凭证（游客模式无 token 则跳过）
	let userId: string | undefined;
	const token = req.headers.authorization;
	if (token) {
		try {
			const tokenInfo = verToken(token);
			if (tokenInfo) userId = tokenInfo.userId;
		} catch {
			// token 无效时静默忽略，不阻断加入房间流程
		}
	}
	const iceServers = generateIceServers(userId);
	console.log(`[room-router] /join roomId=${roomId} userId=${userId || "guest"} iceServers=${JSON.stringify(iceServers.map(s => s.urls))}`);

	if (roomId && roomId.length < 13) {
		if (roomMap.has(roomId)) {
			const room = roomMap.get(roomId);
			if (room && room.status !== "active") {
				res.status(410).json({ status: 410, msg: room.status === "closed" ? "房间已关闭" : "房间已过期", data: { status: room.status } });
				return;
			}
			if (room && room.hostPeerId !== null) {
				const resMsg: ResInterface = {
					status: 200,
					data: { hostPeerId: room.hostPeerId, needCreate: false, iceServers, hostEpoch: room.hostEpoch },
				};
				res.status(resMsg.status).json(resMsg);
			} else {
				const resMsg: ResInterface = {
					status: 202,
					msg: "服务器正在与房主建立联系, 请稍后重试...",
				};
				res.status(resMsg.status).json(resMsg);
			}
		} else {
			//创建房间s
			roomMap.set(roomId, {
				roomId,
				hostName: "",
				hostId: "",
				hostPeerId: null,
				createTime: Date.now(),
				deleteTime: Date.now() + heartContinuationTimeMs,
				lastHeartTime: Date.now(),
				isPrivate: true,
				isStarted: false,
				mapId: null,
				mapName: null,
				status: "active",
				statusUpdatedAt: Date.now(),
				hostLeaseToken: randomUUID(),
				hostEpoch: 0,
			});
			const resMsg: ResInterface = {
				status: 200,
				data: { hostPeerId: "", needCreate: true, deleteIntervalMs: heartContinuationTimeMs, iceServers, hostLeaseToken: roomMap.get(roomId)!.hostLeaseToken, hostEpoch: 0 },
			};
			res.status(resMsg.status).json(resMsg);
		}
	} else {
		const resMsg: ResInterface = {
			status: 400,
			msg: "RoomId不符合标准",
		};
		res.status(resMsg.status).json(resMsg);
	}
});

roomRouter.post("/emit-host", async (req, res, next) => {
	const { roomId, hostPeerId, hostName, hostId, hostLeaseToken } = req.body as {
		roomId: string;
		hostPeerId: string;
		hostName: string;
		hostId: string;
		hostLeaseToken: string;
	};
	if (roomId && hostPeerId && hostName && hostId) {
		if (roomMap.has(roomId)) {
			// roomMap.set(roomId, { roomId,hostPeerId, deleteTime: Date.now() + heartContinuationTimeMs });
			const item = roomMap.get(roomId) as RoomMapItem;
			if (item.status !== "active" || item.hostLeaseToken !== hostLeaseToken) {
				res.status(409).json({ status: 409, msg: "房主租约无效" });
				return;
			}
			item.hostPeerId = hostPeerId;
			item.hostEpoch++;
			item.hostName = hostName;
			item.hostId = hostId;
			item.deleteTime = Date.now() + heartContinuationTimeMs;

			const resMsg: ResInterface = {
				status: 200,
				data: { hostEpoch: item.hostEpoch },
			};
			res.status(resMsg.status).json(resMsg);
		} else {
			const resMsg: ResInterface = {
				status: 400,
				msg: "RoomId不存在",
			};
			res.status(resMsg.status).json(resMsg);
		}
	} else {
		const resMsg: ResInterface = {
			status: 400,
			msg: "RoomId不符合标准",
		};
		res.status(resMsg.status).json(resMsg);
	}
});

roomRouter.post("/delete", async (req, res) => {
	const { roomId, hostLeaseToken } = req.query as { roomId: string; hostLeaseToken?: string };
	const room = roomMap.get(roomId);
	if (!room) { res.status(200).json({ status: 200 }); return; }
	if (room.hostLeaseToken !== hostLeaseToken) { res.status(409).json({ status: 409, msg: "房主租约无效" }); return; }
	room.status = "closed";
	room.statusUpdatedAt = Date.now();
	room.hostPeerId = null;
	res.status(200).json({ status: 200 });
});

roomRouter.get("/status", async (req, res) => {
	const { roomId } = req.query as { roomId: string };
	const room = roomMap.get(roomId);
	if (!room) { res.status(200).json({ status: 200, data: { status: "expired", hostEpoch: 0 } }); return; }
	res.status(200).json({ status: 200, data: { status: room.status, hostEpoch: room.hostEpoch } });
});

roomRouter.get("/heart", async (req, res) => {
	const { roomId, hostLeaseToken } = req.query as { roomId: string; hostLeaseToken?: string };
	const room = roomMap.get(roomId);
	if (!room || room.status !== "active" || room.hostLeaseToken !== hostLeaseToken) {
		res.status(409).json({ status: 409, msg: "房主租约无效" });
		return;
	}
	const now = Date.now();
	room.deleteTime = now + heartContinuationTimeMs;
	room.lastHeartTime = now;
	res.status(200).end();
});

roomRouter.get("/room-list", async (req, res, next) => {
	res.status(200).json({
		data: Array.from(roomMap.values()).map((r) => {
			return <RoomMapItem>{
				...r,
				hostPeerId: null,
			};
		}),
	});
});

roomRouter.get("/random-public-room", async (req, res, next) => {
	const roomArr = Array.from(roomMap.values()).filter((r) => !r.isPrivate && !r.isStarted);

	if (roomArr.length > 0) {
		function getRandomElement<T>(arr: Array<T>) {
			const randomIndex = Math.floor(Math.random() * arr.length);
			return arr[randomIndex];
		}
		res.status(200).json({ roomId: getRandomElement(roomArr).roomId });
	} else {
		res.status(200).json({ roomId: "" });
	}
});

roomRouter.post("/set-private", async (req, res, next) => {
	const { roomId, isPrivate } = req.body as { roomId: string; isPrivate: boolean };
	const room = roomMap.get(roomId);
	if (room) {
		room.isPrivate = isPrivate;
		res.status(200).json(<ResInterface>{
			status: 200,
			msg: room.isPrivate ? "现在房间只能通过输入ID进入啦" : "已将房间公开",
			data: { roomId: roomId, isPrivate: room.isPrivate },
		});
	} else {
		res.status(400).json(<ResInterface>{ status: 400, msg: "不存在的房间" });
	}
});

roomRouter.post("/set-started", async (req, res, next) => {
	const { roomId, isStarted, mapId, mapName } = req.body as {
		roomId: string;
		isStarted: boolean;
		mapId?: string | null;
		mapName?: string | null;
	};
	const room = roomMap.get(roomId);
	if (room) {
		room.isStarted = isStarted;
		if (isStarted) {
			room.mapId = mapId ?? null;
			room.mapName = mapName ?? null;
		}
		res.status(200).json(<ResInterface>{
			status: 200,
		});
	} else {
		res.status(400).json(<ResInterface>{ status: 400, msg: "不存在的房间" });
	}
});
