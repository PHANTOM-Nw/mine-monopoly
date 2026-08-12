<script setup lang="ts">
	import {
		onMounted,
		computed,
		onUnmounted,
		ref,
		onBeforeMount,
		onBeforeUnmount,
		h,
		VNode,
		isVNode,
		render,
		Fragment,
	} from "vue";
	import { GameRenderer } from "@src/core/renderer/GameRenderer";
	import { useLoading, useRoomInfo, useUtil } from "@src/store";
	import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
	import router from "@src/router/index";
	import { MonopolyClient, useMonopolyClient, destoryMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";
	import Dices from "./components/dices.vue";
	import ChanceCardContainer from "./components/chance-card-container.vue";
	import CountdownTimer from "./components/countdown-timer.vue";
	import scoreboard from "./components/scoreboard.vue";
	import PlayerContainer from "./components/player-container.vue";
	import RoundInfo from "./components/round-info.vue";
	import GameButtonsPanel from "./components/game-buttons-panel.vue";
	import { useGameData, useMapData } from "@src/store/game";
	import { useUserInfo } from "@src/store";
	import { CustomUI, GameMap, UISchema, MapEventChangedData } from "@mine-monopoly/types";
	import { compileTsToJs } from "@src/utils";
	import { useAudioManager } from "@src/utils/audio/AudioManager";
	import { SoundName } from "@src/utils/audio/types";
	import useEventBus from "@src/utils/event-bus";
	import { FPMessageBox } from "@src/components/utils/fp-message-box";
	import { buildGameInitDiagnostics, wrapGameInitError } from "@src/utils/game-init-diagnostics";
	import { ErrorCategory, logErrorWithOptions } from "@src/utils/log";
	import { storeToRefs } from "pinia";
	import UiRenderer from "@src/components/utils/ui-renderer/ui-renderer.vue";
	import FpErrorBoundary from "@src/components/utils/fp-error-boundary/index.vue";
	//pinia仓库
	const mapDataStore = useMapData();
	const userInfoStore = useUserInfo();
	const roomInfoStore = useRoomInfo();
	const gameDataStore = useGameData();

	const windowWidth = computed(() => window.innerWidth);
	const windowHeight = computed(() => window.innerHeight);
	const amISpectator = computed(() => roomInfoStore.amISpectator);

	const currentPlayerId = computed(() => userInfoStore.userId);
	const gameDataState = computed(() => gameDataStore.$state);

	let socketClient: MonopolyClient;
	let gameRenderer: GameRenderer | null;
	const islockingCamera = ref(true);
	const lockCameraIcon = computed(() => (islockingCamera.value ? "fa-video" : "fa-video-slash"));

	function handleToggleLockCamera() {
		if (gameRenderer) islockingCamera.value = gameRenderer.toggleLockCamera();
	}

	const isOverview = ref(false);
	const overviewIcon = computed(() => (isOverview.value ? "fa-compress" : "fa-expand"));

	function handleToggleOverview() {
		if (gameRenderer) isOverview.value = gameRenderer.toggleOverview();
	}

	function handleRollDice() {
		if (socketClient) {
			socketClient.rollDice();
		}
	}

	function renderInitFailureDialog(lines: string[]) {
		return h("div", { style: "max-width: 44rem;" }, [
			h(
				"div",
				{
					style: "margin-bottom: 0.75rem; font-weight: 600; color: var(--fp-color-primary, #333);",
				},
				"初始化失败。请截图下面完整内容发给开发者。",
			),
			h(
				"pre",
				{
					style: [
						"margin: 0",
						"padding: 0.9rem 1rem",
						"border-radius: 0.5rem",
						"background: rgba(0, 0, 0, 0.06)",
						"white-space: pre-wrap",
						"word-break: break-word",
						"overflow-wrap: anywhere",
						"font-size: 0.92rem",
						"line-height: 1.55",
					].join("; "),
				},
				lines.join("\n"),
			),
		]);
	}

	onMounted(async () => {
		try {
			socketClient = useMonopolyClient();
			useLoading().showLoading("加载数据中...");

			// 暂停心跳检测，避免加载期间误判断连
			socketClient.sendLoadingStarted();
			socketClient.pauseHeartBeat();

			const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
			const container = document.getElementsByClassName("game-page")[0] as HTMLDivElement;
			if (!canvas || !container) {
				throw wrapGameInitError("game-page-mounted", new Error("游戏画布元素未找到"));
			}
			const mapData = JSON.parse(JSON.stringify(mapDataStore.$state)) as GameMap;
			console.log("🚀 ~ mapData:", mapData);
			gameRenderer = new GameRenderer(canvas, container, mapData);
			await gameRenderer.init();

				// 注册金钱粒子系统
			// 恢复心跳检测
			socketClient.resumeHeartBeat();

			useEventBus().on("game:init", () => {
				if (!amISpectator.value) void socketClient.gameInitFinished();
			});

			if (amISpectator.value) {
				useLoading().hideLoading();
			} else {
				useLoading().showLoading("数据加载完成，等待其他玩家加载...");
				socketClient.gameInitFinished();
			}

			// 监听玩家金钱变化事件
			const audioManager = useAudioManager();
			const eventBus = useEventBus();
			eventBus.on("player-money", (playerId: string, oldMoney: number, newMoney: number) => {
				if (newMoney > oldMoney) {
					audioManager.playSound(SoundName.GAIN_MONEY);
				} else if (newMoney < oldMoney) {
					audioManager.playSound(SoundName.LOSE_MONEY);
				}
			});

			// 监听动态地图事件变更
			eventBus.on("map-event-changed", (data: MapEventChangedData) => {
				if (!gameRenderer) return;
				switch (data.action) {
					case "link":
						if (data.mapEvent && data.mapItemId) {
							gameRenderer.addEventIcon(data.mapItemId, data.mapEvent);
							gameRenderer.setMapItemEventUserData(data.mapItemId, data.mapEvent);
						}
						break;
					case "add":
						if (data.mapEvent) {
							const linkedItem = mapDataStore.mapItems.find((m) => m.mapEventId === data.mapEvent!.id);
							if (linkedItem) {
								gameRenderer.addEventIcon(linkedItem.id, data.mapEvent);
								gameRenderer.setMapItemEventUserData(linkedItem.id, data.mapEvent);
							}
						}
						break;
					case "remove":
						if (data.mapEventId) {
							// 移除所有关联此事件的地块上的图标
							for (const item of mapDataStore.mapItems) {
								if (item.mapEventId === data.mapEventId) {
									gameRenderer.removeEventIcon(item.id);
									gameRenderer.setMapItemEventUserData(item.id, null);
								}
							}
						}
						break;
					case "unlink":
						if (data.mapItemId) {
							gameRenderer.removeEventIcon(data.mapItemId);
							gameRenderer.setMapItemEventUserData(data.mapItemId, null);
						}
						break;
				}
			});
		} catch (e: any) {
			// 异常时也要恢复心跳，防止永久暂停
			socketClient?.resumeHeartBeat();
			const diagnostics = buildGameInitDiagnostics(e, {
				mapName: mapDataStore.info?.name || "unknown",
				route: window.location.pathname,
			});
			void socketClient?.gameInitFailed(diagnostics.rawMessage);
			console.error("[GameInitFailure]", diagnostics, e);
			logErrorWithOptions({
				category: ErrorCategory.UI_RENDER,
				type: diagnostics.errorCode,
				message: diagnostics.logMessage,
				error:
					e instanceof Error
						? e
						: diagnostics.logStack
							? ({ message: diagnostics.rawMessage, stack: diagnostics.logStack } as Error)
							: undefined,
				extraInfo: diagnostics.extraInfo,
				context: diagnostics.context,
			});
			useLoading().hideLoading();
			await FPMessageBox({
				title: "游戏初始化失败",
				content: renderInitFailureDialog(diagnostics.lines),
				confirmText: "返回房间",
				showCancel: false,
			}).catch(() => {});
			router.replace({ name: "room-router" });
		}
	});

	onBeforeUnmount(() => {
		if (gameRenderer) gameRenderer.destroy();
		gameRenderer = null;
		// 只有在真正离开房间时才销毁 MonopolyClient（安全模式回房间时不销毁）
		const nextRoute = router.currentRoute.value.name;
		if (nextRoute !== "room") {
			destoryMonopolyClient();
		}
	});

	function getUiTemplateById(id: string) {
		return (
			useMapData().getUITempolateById(id)?.template || { id: "404", type: "text", content: `找不到ID为: ${id} 的UI组件` }
		);
	}
</script>

<template>
	<FpErrorBoundary>
		<div class="game-page">
			<canvas id="game-canvas" :width="windowWidth" :height="windowHeight"></canvas>
			<div class="ui-container">
				<UiRenderer
					v-for="ui in mapDataStore.customUIs"
					:schema="getUiTemplateById(ui.uiSchema)"
					:context="{
							...gameDataState,
							currentPlayer: gameDataStore.myGameInfo
						}"
					:style="{
						gridArea: `${ui.layout.y + 1} / ${ui.layout.x + 1} / span ${ui.layout.height} / span ${ui.layout.width}`,
						zIndex: `var(--z-ui)`,
					}"
				/>

				<PlayerContainer />

				<!-- 顶部居中的「第 N 回合 / 当前倍率」。组件早就写好了，只是一直没挂上来 -->
				<RoundInfo />

				<div class="tool-bar ui-item">
					<button
						class="border-button lock-camera"
						:title="islockingCamera ? '解除相机锁定' : '锁定相机跟随'"
						@click="handleToggleLockCamera"
					>
						<FontAwesomeIcon :icon="lockCameraIcon" />
					</button>
					<button
						class="border-button lock-camera"
						:title="isOverview ? '回到跟随视角' : '全局俯视（整盘居中）'"
						@click="handleToggleOverview"
					>
						<FontAwesomeIcon :icon="overviewIcon" />
					</button>
				</div>

				<ChanceCardContainer />

				<!-- 游戏按钮面板：包含骰子按钮和动态按钮 -->
				<GameButtonsPanel
					:player-id="currentPlayerId"
					title="操作面板"
					:spectator-message="amISpectator ? '你正在旁观本局，游戏操作将完全由 AI 自行完成。' : ''"
					@rollDice="handleRollDice"
				/>

				<teleport to="body">
					<CountdownTimer />
				</teleport>
			</div>

			<!-- 金钱粒子系统：放在 ui-container 外部，避免 pointer-events 冲突 -->

			<scoreboard />
		</div>
	</FpErrorBoundary>
</template>

<style lang="scss" scoped>
.game-page {
	position: relative;
	width: 100%;
	height: 100%;
	background-color: #ffffff;
	user-select: none;
}

.border-button {
	border-style: solid;
	border-color: rgba($color: #ffffff, $alpha: 0.5);
	border-radius: 0.8rem;

	&.lock-camera {
		border-width: 0.25rem;
		font-size: 1.1em;
		// 3rem：工具栏挪到右上角后要塞进玩家卡片列表（top: 4.2rem）上方那条带子里
		width: 3rem;
		height: 3rem;
	}
}

.ui-container,
#game-canvas {
	position: absolute;
	width: 100%;
	height: 100%;
	left: 0;
	top: 0;
}

#game-canvas {
	z-index: var(--z-game);
	display: block;
}

.ui-container {
	pointer-events: none;
	display: grid;
	grid-template-columns: repeat(32, 1fr);
	grid-template-rows: repeat(20, 1fr);

	.ui-item {
		position: absolute;

		// 右上角、玩家卡片列表(top:4.2rem)正上方那条带子：
		// 0.6rem 上边距 + 3rem 按钮 = 3.6rem，刚好不压到卡片。
		// 横排是因为这里高度只有 4.2rem，竖排放不下第二个。
		// 放左上角：右上从 4.2rem 起是玩家卡片列表（挨得太近，卡片的圆角和阴影会压上来），
		// 顶部居中留给回合信息，底部是卡牌和按钮面板 —— 只有这里是完全空的。
		&.tool-bar {
			position: absolute;
			left: 0.8rem;
			top: 0.6rem;
			// 必须显式给层级：.ui-container 是 z-index:auto，不创建层叠上下文，
			// 里面的东西是提升到 .game-page 里和 #game-canvas(--z-game:10) 一起排序的。
			// 玩家卡片、按钮面板、自定义 UI 都带了 --z-ui:20，只有这条工具栏漏了，
			// 结果一直被画布盖着 —— 按钮其实一直在，只是看不见也点不到。
			z-index: var(--z-ui);
			display: flex;
			flex-direction: row;
			gap: 0.5rem;
			pointer-events: none;
		}
	}

	& * {
		pointer-events: initial;
	}
}

</style>
