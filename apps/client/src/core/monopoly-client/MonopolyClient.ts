import { FPMessage } from "@mine-monopoly/ui";
import { randomUUID } from "@mine-monopoly/utils/crypto";
import { useChat, useGameLog, useLoading, useRoomInfo, useUserInfo, useUtil } from "@src/store";
import { useGameData } from "@src/store/game";
import { emitHostPeerId, joinRoomApi } from "@src/utils/api/room-router";
import { WebRtcSessionManager, SessionSendResult } from "@src/core/network/WebRtcSessionManager";
import {
	AIDecisionConfig,
	RoomMapInfo,
	GameSetting,
	OperateType,
	SocketMsgSource,
	SocketMsgType,
	ClientSocketMessage,
} from "@mine-monopoly/types";
import { handleServerSocketMessage } from "./host-message-handlers";
import router from "@src/router";
import { connectionDiagnostics } from "@src/utils/connection-diagnostics";

type MonopolyClientOptions = {
	iceServer: {
		host: string;
		port: number;
	};
};


export class MonopolyClient {
	private static instance: MonopolyClient | null;
	private session: WebRtcSessionManager;
	private currentInitSessionId: string | null = null;

	public static getInstance(): MonopolyClient;
	public static getInstance(options: MonopolyClientOptions): Promise<MonopolyClient>;
	public static getInstance(options?: MonopolyClientOptions) {
		if (this.instance) {
			return this.instance;
		}
		if (options) {
			return (async () => {
				this.instance = new MonopolyClient(options);

				return this.instance;
			})();
		} else {
			// if (!this.instance) {
			// 	throw Error("在调用MonopolyClient之前应该先对其初始化, 使用useMonopolyClient时提供options以初始化");
			// }
			return this.instance;
		}
	}

	private constructor(options: MonopolyClientOptions) {
		this.session = new WebRtcSessionManager({
			iceServer: options.iceServer,
			onMessage: (data) => {
				if (data.msg && data.type !== SocketMsgType.LeaveRoom && data.type !== SocketMsgType.GameOver) {
					useLoading().hideLoading();
					FPMessage({ type: data.msg.type, message: data.msg.content });
				}
				handleServerSocketMessage(data, this);
			},
			onHeartbeat: (ping) => { useUtil().ping = ping; },
			onReconnectAttempt: (attempt, strategy) => {
				useUtil().connectionReconnectAttempt = attempt;
				useUtil().connectionPolicy = strategy === "force-relay" ? "relay" : "auto";
			},
			onStateChange: (state, detail) => {
				useUtil().connectionStatusText = state;
				useUtil().connectionStatusReason = detail || "";
				useUtil().connectionMode = state === "connected" ? (this.session.getConnectionStrategy() === "force-relay" ? "relay" : "p2p") : "unknown";
			},
			onHostClosed: (status) => {
				this.handleDisconnect({
					type: "error",
					content: status === "expired" ? "房间已过期" : "房主已退出，房间已关闭",
				});
			},
			onReconnectCancelled: () => {
				this.handleDisconnect({ type: "warning", content: "已停止恢复连接，已离开房间" });
			},
		});
	}

	public async joinRoom(roomId: string) {
		connectionDiagnostics.reset();
		connectionDiagnostics.stageStart("joinRoom_Total");
		try {
			const response = await joinRoomApi(roomId);
			const data = response.data;
			// 202：房间在，但房主还没把 peerId 报上来，此时响应体里没有 data
			if (!data) throw new Error("房主尚未就绪，请稍后重试");
			this.session.setIceServers(data.iceServers || []);
			let hostPeerId = data.hostPeerId;
			let hostEpoch = data.hostEpoch;
			if (data.needCreate) {
				useLoading().showLoading("正在创建主机...");
				hostPeerId = await this.session.createHost(roomId, data.deleteIntervalMs, {
					hostLeaseToken: data.hostLeaseToken,
					hostEpoch: data.hostEpoch,
				});
				const user = useUserInfo();
				// emit-host 会把 epoch 推进一格，重连时要拿这个新值去比对
				const emitRes = await emitHostPeerId(roomId, hostPeerId, user.username, user.userId, data.hostLeaseToken);
				hostEpoch = emitRes.data.hostEpoch;
			}
			if (!hostPeerId) throw new Error("房主尚未就绪，请稍后重试");
			useLoading().showLoading("正在建立连接...");
			await this.session.connect(roomId, hostPeerId, hostEpoch, () => useRoomInfo().isReady);
			connectionDiagnostics.stageEnd("joinRoom_Total");
		} catch (error: any) {
			connectionDiagnostics.stageFail("joinRoom_Total", error?.message || "服务器连接失败");
			FPMessage({ type: "error", message: error?.message || "服务器连接失败" });
		}
	}

	public cancelReconnection(): void { this.session.cancelReconnection(); }
	public isReconnecting(): boolean { return this.session.isReconnecting(); }
	public handleHeartReply(): void { this.session.handleHeartbeatReply(); }
	public initHeartBeat(): void {}
	public pauseHeartBeat(): void { this.session.pauseHeartbeat(); }
	public resumeHeartBeat(): void { this.session.resumeHeartbeat(); }
	public sendLoadingStarted(): void {
		void this.sendMsg({ type: SocketMsgType.Operation, source: SocketMsgSource.Client, data: { operateType: OperateType.LoadingStarted, data: undefined } });
	}
	public registerGameInitSession(initSessionId?: string): void { this.currentInitSessionId = initSessionId || null; }
	private handleDisconnect(notification: { type: "info" | "success" | "warning" | "error"; content: string }): void {
		useGameData().$reset(); useRoomInfo().$reset(); useChat().$reset(); useGameLog().$reset();
		this.destory();
		void router.replace({ name: "room-router" }).finally(() => {
			FPMessage({ type: notification.type, message: notification.content });
		});
	}

	public sendRoomChatMessage(message: string, roomId: string) {
		this.sendMsg({ type: SocketMsgType.RoomChat, source: SocketMsgSource.Client, data: message });
	}

	public async leaveRoom() {
		await this.sendMsg({ type: SocketMsgType.LeaveRoom, source: SocketMsgSource.Client, data: undefined });
		this.session.pauseHeartbeat();
	}

	public readyToggle() {
		this.sendMsg({ type: SocketMsgType.ReadyToggle, source: SocketMsgSource.Client, data: undefined });
	}

	public changeColor(newColor: string) {
		this.sendMsg({ type: SocketMsgType.ChangeColor, source: SocketMsgSource.Client, data: newColor });
	}

	public changeColorForUser(userId: string, newColor: string): { success: boolean; error?: string } {
		if (this.session.isAiPlayer(userId)) return this.session.changeColorForUser(userId, newColor);
		if (userId === useUserInfo().userId) { this.changeColor(newColor); return { success: true }; }
		return { success: false, error: "当前只支持房主修改 AI 玩家颜色" };
	}

	public kickOut(playerId: string) {
		if (this.session.isAiPlayer(playerId)) { this.session.removeAIPlayer(playerId); return; }
		void this.sendMsg({ type: SocketMsgType.KickOut, source: SocketMsgSource.Client, data: playerId });
	}

	public addAIPlayer(): { success: boolean; error?: string } { return this.session.addAIPlayer(); }

	public randomizeAIRoles(): { success: boolean; error?: string } {
		return this.session.randomizeAIRoles() ? { success: true } : { success: false, error: "当前没有可随机分配的 AI 玩家或地图没有角色" };
	}

	public setSpectatorMode(enabled: boolean): { success: boolean; error?: string } { return this.session.setSpectatorMode(enabled); }

	public changeRoleForUser(userId: string, roleId: string): { success: boolean; error?: string } {
		if (this.session.isAiPlayer(userId)) return this.session.changeRoleForUser(userId, roleId);
		if (userId === useUserInfo().userId) { this.changeRole(roleId); return { success: true }; }
		return { success: false, error: "当前只支持房主修改 AI 玩家角色" };
	}

	public changeRole(roleId: string) {
		this.sendMsg({ type: SocketMsgType.ChangeRole, source: SocketMsgSource.Client, data: roleId });
	}

	public updateAIPlayerName(userId: string, username: string): { success: boolean; error?: string } {
		return this.session.updateAIPlayerName(userId, username);
	}

	public changeGameMap(msg: RoomMapInfo) {
		if (this.session.changeGameMap(msg)) return;
		void this.sendMsg({ type: SocketMsgType.ChangeMap, source: SocketMsgSource.Client, data: msg });
	}

	public changeGameSetting(gameSetting: GameSetting) {
		this.sendMsg({ type: SocketMsgType.ChangeGameSetting, source: SocketMsgSource.Client, data: gameSetting });
	}

	public updateAIDecisionConfig(config: AIDecisionConfig): { success: boolean; error?: string } {
		this.session.updateAIDecisionConfig(config);
		return { success: true };
	}

	public startGame() {
		this.sendMsg({ type: SocketMsgType.GameStart, source: SocketMsgSource.Client, data: undefined });
	}

	public requestSave(): void { this.session.requestSave(); }
	public async loadSave(record: any, usePrevious: boolean = false): Promise<{ success: boolean; error?: string }> { return this.session.loadSave(record, usePrevious); }
	public gameInitFinished() {
		return this.sendMsg({ type: SocketMsgType.Operation, source: SocketMsgSource.Client, data: { operateType: OperateType.GameInitFinished, data: undefined }, extra: { initSessionId: this.currentInitSessionId, initStatus: "ready", messageId: randomUUID() } });
	}
	public gameInitFailed(reason: string) {
		return this.sendMsg({ type: SocketMsgType.Operation, source: SocketMsgSource.Client, data: { operateType: OperateType.GameInitFinished, data: undefined }, extra: { initSessionId: this.currentInitSessionId, initStatus: "failed", reason, messageId: randomUUID() } });
	}

	public rollDice() {
		// 客户端立即锁定，防止重复点击
		const utilStore = useUtil();
		utilStore.startAnimation();

		this.sendMsg({
			type: SocketMsgType.Operation,
			source: SocketMsgSource.Client,
			data: { operateType: OperateType.RollDice, data: undefined },
		});
	}

	public useChanceCard(chanceCardId: string, targetIdList: string[]) {
		// 客户端立即锁定，防止重复点击
		const utilStore = useUtil();
		utilStore.startAnimation();

		this.sendMsg({
			type: SocketMsgType.Operation,
			source: SocketMsgSource.Client,
			data: {
				operateType: OperateType.UseChanceCard,
				data: { chanceCardId, targetIdList },
			},
		});
	}

	public sendDynamicButtonClick(buttonId: string) {
		this.sendMsg({
			type: SocketMsgType.Operation,
			source: SocketMsgSource.Client,
			data: {
				operateType: OperateType.DynamicButtonClick,
				data: { buttonId, success: true },
			},
		});
	}

	public AnimationComplete(animationId: string) {
		this.sendMsg({
			type: SocketMsgType.Operation,
			source: SocketMsgSource.Client,
			data: {
				operateType: OperateType.Animation,
				data: animationId,
			},
		});

		// 动画完成后解锁状态
		const utilStore = useUtil();
		utilStore.endAnimation();
	}

	public async sendMsg(msg: ClientSocketMessage): Promise<SessionSendResult> {
		const result = this.session.send(msg);
		if (!result.ok) console.warn("[MonopolyClient] 消息未发送", msg.type, result.reason);
		return result;
	}

	public destory() { void this.session.close(); }

	public static destoryInstance() {
		if (this.instance) {
			this.instance.destory();
			this.instance = null;
		}
		// 移除 beforeunload 事件监听器
		window.removeEventListener("beforeunload", destoryMonopolyClient);
	}
}

function useMonopolyClient(): MonopolyClient;
function useMonopolyClient(options: MonopolyClientOptions): Promise<MonopolyClient>;
function useMonopolyClient(options?: MonopolyClientOptions) {
	window.addEventListener("beforeunload", destoryMonopolyClient, { once: true });
	return options ? MonopolyClient.getInstance(options) : MonopolyClient.getInstance();
}

function destoryMonopolyClient() {
	try {
		MonopolyClient.getInstance() && MonopolyClient.destoryInstance();
	} catch (e) {
		console.log(e);
	}
}

export { useMonopolyClient, destoryMonopolyClient };
