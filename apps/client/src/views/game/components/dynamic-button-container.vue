<template>
	<div class="dynamic-button-container" :class="layoutClass" v-show="visibleButtonsList.length > 0">
		<DynamicButton v-for="button in visibleButtonsList" :key="button.id" :config="button" @click="handleButtonClick" />
	</div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import {
	ButtonConfig,
	ButtonRegisterMessage,
	ButtonStateChangedMessage,
	ButtonRemoveMessage,
} from "@mine-monopoly/types";
import useEventBus from "@src/utils/event-bus";
import DynamicButton from "./dynamic-button.vue";
import { useMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";
import { useUtil } from "@src/store";
import { useGameData } from "@src/store/game";

interface Props {
	playerId: string;
	layout?: "horizontal" | "vertical";
}

const props = withDefaults(defineProps<Props>(), {
	layout: "horizontal",
});

const buttons = ref<ButtonConfig[]>([]);
/** 服务器对每个按钮的 enabled 意见，跟回合状态分开记，否则回合一变就把它冲掉了 */
const serverEnabledMap = new Map<string, boolean>();
const eventBus = useEventBus();
const utilStore = useUtil();
const gameDataStore = useGameData();

// 托管期间这些按钮由 AI 来按，本人置灰，免得两边同时出手
const isAutoPlay = computed(() => Boolean(gameDataStore.myGameInfo?.isAI));

const visibleButtonsList = computed(() => {
	return buttons.value.filter((b) => b.visible);
});

const layoutClass = computed(() => {
	return `layout-${props.layout}`;
});

// 按钮最终可不可点：服务器说了算 + 得是自己的回合 + 没在托管
const resolveButtonEnabled = (buttonId: string) => {
	return (serverEnabledMap.get(buttonId) ?? true) && utilStore.canRoll && !isAutoPlay.value;
};

// 根据回合状态调整按钮启用状态
const updateButtonsEnabledState = () => {
	buttons.value.forEach((button) => {
		button.enabled = resolveButtonEnabled(button.id);
	});

	// 触发响应式更新
	buttons.value = [...buttons.value];
};

// 监听回合状态和托管状态变化
watch([() => utilStore.canRoll, isAutoPlay], () => {
	updateButtonsEnabledState();
});

// 事件处理器
const handleButtonRegister = (message: ButtonRegisterMessage) => {
	serverEnabledMap.set(message.buttonId, message.enabled);
	const button: ButtonConfig = {
		id: message.buttonId,
		playerId: props.playerId,
		text: message.text,
		enabled: resolveButtonEnabled(message.buttonId), // 结合服务器状态、回合状态和托管状态
		visible: message.visible,
		callback: () => {},
	};

	buttons.value.push(button);
};

const handleButtonStateChanged = (message: ButtonStateChangedMessage) => {
	const button = buttons.value.find((b) => b.id === message.buttonId);
	if (button) {
		if (message.enabled !== undefined) {
			serverEnabledMap.set(message.buttonId, message.enabled);
			button.enabled = resolveButtonEnabled(message.buttonId);
		}
		if (message.visible !== undefined) {
			button.visible = message.visible;
		}
		if (message.text !== undefined) {
			button.text = message.text;
		}
		buttons.value = [...buttons.value];
	}
};

const handleButtonRemove = (message: ButtonRemoveMessage) => {
	serverEnabledMap.delete(message.buttonId);
	const index = buttons.value.findIndex((b) => b.id === message.buttonId);
	if (index !== -1) {
		buttons.value.splice(index, 1);
	}
};

const handleButtonClick = (buttonId: string) => {
	// 托管中这一手归 AI，本人点了不算
	if (isAutoPlay.value) return;
	const socketClient = useMonopolyClient();
	if (socketClient) {
		socketClient.sendDynamicButtonClick(buttonId);
	}
};

// 生命周期
onMounted(async () => {
	// 注册事件监听器
	eventBus.on("button:register", handleButtonRegister);
	eventBus.on("button:state-changed", handleButtonStateChanged);
	eventBus.on("button:remove", handleButtonRemove);

	// 初始化按钮状态
	updateButtonsEnabledState();

	// 监听游戏初始化完成事件后再请求同步
	eventBus.once("game:init-finished", async () => {
		try {
			const socketClient = useMonopolyClient();
			socketClient.sendDynamicButtonClick("__sync__");
			// 同步完成后再次更新按钮状态
			updateButtonsEnabledState();
		} catch (error) {
			console.error("[DynamicButtonContainer] 同步按钮失败:", error);
		}
	});
});

onUnmounted(() => {
	eventBus.remove("button:register", handleButtonRegister);
	eventBus.remove("button:state-changed", handleButtonStateChanged);
	eventBus.remove("button:remove", handleButtonRemove);
	buttons.value = [];
});
</script>

<style scoped>
.dynamic-button-container {
  max-width: 10rem;
	display: flex;
	gap: 0.5rem;
	z-index: var(--z-ui);
}

.dynamic-button-container.layout-horizontal {
	flex-direction: row;
	justify-content: flex-end;
	align-items: center;
}

.dynamic-button-container.layout-vertical {
	flex-direction: column;
	justify-content: flex-start;
	align-items: flex-end;
	max-height: 8.2rem;
	overflow-y: auto;
	overflow-x: hidden;
	padding-right: 0.4rem; /* 给滚动条留一点空间 */
  padding-bottom: 0.2rem;
}

/* 自定义滚动条样式 */
.dynamic-button-container.layout-vertical::-webkit-scrollbar {
	width: 0.25rem;
}

.dynamic-button-container.layout-vertical::-webkit-scrollbar-track {
	background: var(--fp-color-bg-light);
	border-radius: 0.125rem;
}

.dynamic-button-container.layout-vertical::-webkit-scrollbar-thumb {
	background: var(--fp-color-tertiary);
	border-radius: 0.125rem;
}

.dynamic-button-container.layout-vertical::-webkit-scrollbar-thumb:hover {
	background: var(--fp-color-secondary);
}
</style>
