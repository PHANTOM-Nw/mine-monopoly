import { DataConnection } from "peerjs";
import {
	AIDecisionConfig,
	ClientSocketMessage,
	ServerSocketMessage,
	SocketMsgSource,
	SocketMsgType,
} from "@mine-monopoly/types";
import { PeerClient } from "@src/core/monopoly-client/PeerClient";
import { ReconnectionManager } from "@src/core/monopoly-client/ReconnectionManager";
import { MonopolyHost } from "@src/core/monopoly-host/MonopolyHost";
import { getRoomSessionStatus } from "@src/utils/api/room-router";
import { useUserInfo } from "@src/store";

export type WebRtcSessionState =
	| "idle"
	| "hosting"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "closing"
	| "closed"
	| "failed";
export type ConnectionStrategy = "prefer-p2p" | "force-relay";
export type SessionSendResult =
	| { ok: true; generation: number }
	| { ok: false; reason: "not-connected" | "send-failed"; error?: unknown };
export interface HostSessionRegistration {
	hostLeaseToken: string;
	hostEpoch: number;
}
export interface WebRtcSessionManagerOptions {
	iceServer: { host: string; port: number };
	onMessage: (message: ServerSocketMessage) => void;
	onStateChange?: (state: WebRtcSessionState, detail?: string) => void;
	onHeartbeat?: (ping: number) => void;
	onReconnectAttempt?: (attempt: number, strategy: ConnectionStrategy) => void;
	onHostClosed?: (status: "closed" | "expired") => void;
	onReconnectCancelled?: () => void;
}

type ReconnectContext = { roomId: string; hostPeerId: string; hostEpoch: number; isReady: () => boolean };
export type WebRtcSessionEvent = "state" | "message" | "heartbeat" | "reconnect-attempt" | "host-closed";
class HostRoomClosedError extends Error {
	public constructor(public readonly status: "closed" | "expired") {
		super(status === "closed" ? "房主已退出，房间已关闭" : "房间已过期");
	}
}

export class WebRtcSessionManager {
	private peerClient: PeerClient | null = null;
	private connection: DataConnection | null = null;
	private host: MonopolyHost | null = null;
	private state: WebRtcSessionState = "idle";
	private connectionGeneration = 0;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
	private lastHeartbeatSentAt = 0;
	private heartbeatPaused = false;
	private reconnectManager: ReconnectionManager | null = null;
	private reconnectContext: ReconnectContext | null = null;
	private iceServers: RTCIceServer[] = [];
	private strategy: ConnectionStrategy = "prefer-p2p";
	private peerStrategy: ConnectionStrategy | null = null;
	private explicitClose = false;
	private listeners = new Map<WebRtcSessionEvent, Set<(payload: unknown) => void>>();

	public constructor(private readonly options: WebRtcSessionManagerOptions) {}
	public on(event: WebRtcSessionEvent, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) || new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}

	public getState(): WebRtcSessionState {
		return this.state;
	}
	public getConnectionGeneration(): number {
		return this.connectionGeneration;
	}
	public getConnectionStrategy(): ConnectionStrategy {
		return this.strategy;
	}
	public setIceServers(iceServers: RTCIceServer[]): void {
		this.iceServers = iceServers;
	}

	public async createHost(
		roomId: string,
		deleteIntervalMs: number,
		registration: HostSessionRegistration,
	): Promise<string> {
		this.transition("hosting");
		this.explicitClose = false;
		this.host = await MonopolyHost.create(
			roomId,
			this.options.iceServer.host,
			this.options.iceServer.port,
			deleteIntervalMs,
			this.iceServers,
			registration,
		);
		this.host.addDestoryListener(() => {
			this.host = null;
		});
		return this.host.getPeerId();
	}

	public async connect(roomId: string, hostPeerId: string, hostEpoch: number, isReady: () => boolean): Promise<void> {
		this.stopReconnection();
		this.explicitClose = false;
		this.reconnectContext = { roomId, hostPeerId, hostEpoch, isReady };
		this.transition("connecting");
		await this.openConnection(hostPeerId);
		const result = this.sendJoinRoom(isReady());
		if (!result.ok) throw new Error("加入房间消息发送失败");
		this.transition("connected");
	}

	public send(message: ClientSocketMessage): SessionSendResult {
		if (!this.connection?.open || this.state === "closing" || this.state === "closed")
			return { ok: false, reason: "not-connected" };
		try {
			this.connection.send(
				JSON.stringify(message, (_key, value) =>
					value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value,
				),
			);
			return { ok: true, generation: this.connectionGeneration };
		} catch (error) {
			return { ok: false, reason: "send-failed", error };
		}
	}

	public pauseHeartbeat(): void {
		this.heartbeatPaused = true;
		this.clearHeartbeatTimeout();
	}
	public resumeHeartbeat(): void {
		this.heartbeatPaused = false;
		this.scheduleHeartbeatTimeout();
	}
	public handleHeartbeatReply(): void {
		if (this.lastHeartbeatSentAt) {
			const ping = Math.round((Date.now() - this.lastHeartbeatSentAt) / 2);
			this.options.onHeartbeat?.(ping);
			this.emit("heartbeat", ping);
		}
		this.scheduleHeartbeatTimeout();
	}
	public cancelReconnection(): void {
		this.reconnectManager?.cancel();
		this.reconnectManager = null;
	}
	public isReconnecting(): boolean {
		return this.state === "reconnecting";
	}

	public requestSave(): void {
		this.host?.getRoom().requestSave();
	}
	public loadSave(record: any, usePrevious: boolean): Promise<{ success: boolean; error?: string }> {
		return (
			this.host?.getRoom().loadSave(record, usePrevious) ?? Promise.resolve({ success: false, error: "未连接到主机" })
		);
	}
	public changeColorForUser(userId: string, color: string) {
		return this.host?.getRoom().changeColor(userId, color) ?? { success: false, error: "只有房主可以执行此操作" };
	}
	public addAIPlayer() {
		return this.host?.getRoom().addAiPlayer() ?? { success: false, error: "只有房主可以添加 AI" };
	}
	public randomizeAIRoles(): boolean {
		return this.host?.getRoom().randomizeAiRoles() ?? false;
	}
	public setSpectatorMode(enabled: boolean) {
		return this.host?.getRoom().setOwnerSpectatorMode(enabled) ?? { success: false, error: "只有房主可以切换旁观模式" };
	}
	public setMaxPlayers(value: number) {
		return this.host?.getRoom().setMaxPlayers(value) ?? { success: false, error: "只有房主可以修改人数上限" };
	}
	public changeRoleForUser(userId: string, roleId: string) {
		return this.host?.getRoom().changeRole(userId, roleId) ?? { success: false, error: "只有房主可以修改角色" };
	}
	public updateAIPlayerName(userId: string, username: string) {
		return (
			this.host?.getRoom().updateAIPlayerName(userId, username) ?? { success: false, error: "只有房主可以修改 AI 名称" }
		);
	}
	public updateAIDecisionConfig(config: AIDecisionConfig): void {
		this.host?.getRoom().updateAIDecisionConfig(config);
	}
	public isAiPlayer(userId: string): boolean {
		return this.host?.getRoom().isAiPlayer(userId) ?? false;
	}
	public removeAIPlayer(userId: string): boolean {
		return this.host?.getRoom().removeAiPlayer(userId) ?? false;
	}
	public changeGameMap(mapInfo: import("@mine-monopoly/types").RoomMapInfo): boolean {
		if (!this.host) return false;
		void this.host.getRoom().changeMap(mapInfo);
		return true;
	}

	public async close(): Promise<void> {
		if (this.state === "closing") return;
		if (this.state === "closed" && !this.connection && !this.peerClient && !this.host && !this.reconnectContext) return;
		this.explicitClose = true;
		this.transition("closing");
		this.stopReconnection();
		this.stopHeartbeat();
		this.disposeConnection();
		this.peerClient?.destory();
		this.peerClient = null;
		this.peerStrategy = null;
		this.host?.destory();
		this.host = null;
		this.reconnectContext = null;
		this.transition("closed");
	}

	private async reconnectNow(): Promise<void> {
		const context = this.reconnectContext;
		if (!context) throw new Error("缺少重连上下文");
		await this.assertRoomStillActive(context.roomId, context.hostEpoch);
		await this.openConnection(context.hostPeerId);
		const result = this.sendJoinRoom(context.isReady());
		if (!result.ok) throw new Error("重连加入消息发送失败");
	}

	private async openConnection(hostPeerId: string): Promise<void> {
		this.disposeConnection();
		await this.ensurePeerClient();
		const { conn } = await this.peerClient!.linkToHost(hostPeerId);
		this.bindConnection(conn);
	}

	private async ensurePeerClient(): Promise<void> {
		if (this.peerClient && this.peerStrategy === this.strategy) return;
		this.peerClient?.destory();
		this.peerClient = await PeerClient.create(
			this.options.iceServer.host,
			this.options.iceServer.port,
			this.buildRtcConfig(),
		);
		this.peerStrategy = this.strategy;
	}
	private buildRtcConfig(): RTCConfiguration {
		return { iceServers: this.iceServers, ...(this.strategy === "force-relay" ? { iceTransportPolicy: "relay" } : {}) };
	}

	private bindConnection(connection: DataConnection): void {
		this.connection = connection;
		const generation = ++this.connectionGeneration;
		this.startHeartbeat();
		connection.on("data", (payload: unknown) => {
			if (!this.isCurrentConnection(connection, generation)) return;
			try {
				const message = JSON.parse(String(payload), (_key, value) =>
					value === "Infinity" ? Infinity : value === "-Infinity" ? -Infinity : value,
				) as ServerSocketMessage;
				this.options.onMessage(message);
				this.emit("message", message);
			} catch (error) {
				console.error("[WebRtcSessionManager] 无法解析主机消息", error);
			}
		});
		connection.on("close", () => this.handleConnectionLoss(connection, generation, "连接已关闭"));
		connection.on("error", (error) =>
			this.handleConnectionLoss(connection, generation, "连接异常: " + (error.message || error)),
		);
	}

	private handleConnectionLoss(connection: DataConnection, generation: number, detail: string): void {
		if (!this.isCurrentConnection(connection, generation) || this.explicitClose) return;
		this.connection = null;
		this.stopHeartbeat();
		this.startReconnection(detail);
	}
	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.heartbeatPaused || this.state !== "connected") return;
			this.lastHeartbeatSentAt = Date.now();
			if (this.send({ type: SocketMsgType.Heart, source: SocketMsgSource.Client, data: undefined }).ok)
				this.scheduleHeartbeatTimeout();
		}, 3000);
	}
	private scheduleHeartbeatTimeout(): void {
		this.clearHeartbeatTimeout();
		if (this.heartbeatPaused || this.state !== "connected") return;
		this.heartbeatTimeout = setTimeout(() => {
			if (this.state === "connected") this.startReconnection("心跳超时");
		}, 5000);
	}
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.clearHeartbeatTimeout();
	}
	private clearHeartbeatTimeout(): void {
		if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
		this.heartbeatTimeout = null;
	}

	private startReconnection(detail: string): void {
		if (!this.reconnectContext || this.state === "reconnecting" || this.explicitClose) return;
		this.transition("reconnecting", detail);
		this.reconnectManager = new ReconnectionManager(async () => this.reconnectNow(), {
			retryInterval: 3000,
			maxRetries: Number.POSITIVE_INFINITY,
			showCountdown: true,
			getDisplayState: (attempt) => ({
				title: "正在恢复连接",
				message: "正在第 " + attempt + " 次恢复房间连接",
				actionLabel: "离开房间",
			}),
			onRetry: (attempt) => {
				if (attempt >= 4) this.strategy = "force-relay";
				this.options.onReconnectAttempt?.(attempt, this.strategy);
				this.emit("reconnect-attempt", { attempt, strategy: this.strategy });
			},
			onSuccess: () => this.transition("connected"),
			onFail: (error) => {
				this.reconnectManager = null;
				if (error instanceof HostRoomClosedError) {
					this.transition("closed", error.message);
					this.options.onHostClosed?.(error.status);
					this.emit("host-closed", error.status);
					return;
				}
				this.transition("failed", error.message);
			},
			onCancel: () => {
				this.transition("closed", "用户取消重连");
				this.options.onReconnectCancelled?.();
			},
			shouldRetry: (error) => !(error instanceof HostRoomClosedError),
		});
		this.reconnectManager.start();
	}
	private stopReconnection(): void {
		this.reconnectManager?.destroy();
		this.reconnectManager = null;
	}
	private async assertRoomStillActive(roomId: string, hostEpoch: number): Promise<void> {
		const response = await getRoomSessionStatus(roomId);
		const status = response.data.status;
		if (status === "closed" || status === "expired") throw new HostRoomClosedError(status);
		if (status !== "active") throw new Error("房间会话不可用");
		// 同一个房间号可能已经被别人重新开了一局：状态是 active，但换了房主。
		// 不比对 epoch 的话，这里会一直去连早就不存在的旧 peerId，无限重连。
		if (response.data.hostEpoch !== hostEpoch) throw new HostRoomClosedError("closed");
	}
	private sendJoinRoom(isReady: boolean): SessionSendResult {
		const user = useUserInfo();
		return this.send({
			type: SocketMsgType.JoinRoom,
			source: SocketMsgSource.Client,
			data: { userId: user.userId, username: user.username, color: user.color, avatar: user.avatar, isReady },
		});
	}
	private disposeConnection(): void {
		if (!this.connection) return;
		this.connectionGeneration++;
		this.connection.removeAllListeners();
		this.connection.close();
		this.connection = null;
	}
	private isCurrentConnection(connection: DataConnection, generation: number): boolean {
		return this.connection === connection && this.connectionGeneration === generation;
	}
	private emit(event: WebRtcSessionEvent, payload: unknown): void {
		this.listeners.get(event)?.forEach((listener) => listener(payload));
	}
	private transition(state: WebRtcSessionState, detail?: string): void {
		this.state = state;
		this.options.onStateChange?.(state, detail);
		this.emit("state", { state, detail });
	}
}
