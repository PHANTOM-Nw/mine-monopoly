<script setup lang="ts">
import { ref, PropType, computed } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import FpDialog from "../fp-dialog/fp-dialog.vue";
import ItemSelector from "./item-selector.vue";
import HtmlRenderer from "../ui-renderer/ui-renderer.vue";
import type { UISchema } from "@mine-monopoly/types";
import { parseRichText } from "@mine-monopoly/utils";
import { useGameData } from "@src/store/game";

// 定义接收的参数
const props = defineProps({
	// ItemSelector 需要的参数
	itemList: { type: Array as PropType<any[]>, default: () => [] },
	column: { type: Number, default: 3 },
	keyName: { type: String, default: "id" },
	multiple: { type: [Number, Boolean] as PropType<number | boolean>, default: 1 },
	selectedKey: { type: [String, Array] as PropType<string | string[]>, default: "" },
	// 弹窗参数
	title: { type: String, default: "请选择" },
	// 用于自定义 item 显示的渲染函数 (可选)
	renderItem: { type: Function, default: undefined },
	// 对话框内容（字符串或 UI Schema），显示在物品列表之前（可选）
	content: { type: [String, Object] as PropType<string | UISchema>, default: undefined },
	// 按钮文本
	confirmText: { type: String, default: "确认" },
	cancelText: { type: String, default: undefined },
	// 这次弹窗由 AI 托管作答，本人只能看
	aiControlled: { type: Boolean, default: false },
});

const emit = defineEmits(["confirm", "cancel", "takeover", "resumeai"]);

const gameDataStore = useGameData();
// 跟着 isAI 走：玩家中途收回控制权，这个弹窗要就地变回可点的
const aiActing = computed(() => props.aiControlled && Boolean(gameDataStore.myGameInfo?.isAI));

const visible = ref(false);
const currentSelected = ref<string | string[]>(props.multiple ? [] : "");

// 解析富文本内容
const parsedContent = computed(() => {
	if (typeof props.content === "string") {
		return parseRichText(props.content);
	}
	return props.content;
});

// 规范化为数组，用于传递给 ItemSelector
const normalizedSelectedKey = computed(() => {
	if (Array.isArray(currentSelected.value)) {
		return currentSelected.value;
	}
	return currentSelected.value ? [currentSelected.value] : [];
});

// 规范化 multiple 参数
const normalizedMaxSelect = computed(() => {
	if (props.multiple === true) return 999;
	if (props.multiple === false || props.multiple === undefined) return 1;
	return typeof props.multiple === 'number' ? Math.max(1, props.multiple) : 1;
});

const isMultiple = computed(() => normalizedMaxSelect.value > 1);

// 初始化数据
const init = () => {
	if (isMultiple.value) {
		currentSelected.value = Array.isArray(props.selectedKey) ? [...props.selectedKey] : [];
	} else {
		currentSelected.value = props.selectedKey;
	}
	visible.value = true;
};

// 暴露给函数式调用
defineExpose({ init });

const handleSubmit = () => {
	// 始终返回数组格式，单选时返回包含单个元素的数组
	const result = isMultiple.value
		? (currentSelected.value as string[])
		: [currentSelected.value as string].filter(Boolean);
	emit("confirm", result);
	visible.value = false;
};

const handleSelectedKeyUpdate = (value: string[]) => {
	currentSelected.value = isMultiple.value ? value : (value[0] || "");
};

const handleCancel = () => {
	emit("cancel");
	visible.value = false;
};

const handleTakeOver = () => {
	emit("takeover");
};

const handleResumeAI = () => {
	emit("resumeai");
};
</script>

<template>
	<FpDialog
		v-model:visible="visible"
		:append-to-body="false"
		:confirm-text="confirmText"
		:cancel-text="cancelText"
		:closable="!aiActing"
		:hidden-footer="aiActing"
		@submit="handleSubmit"
		@cancel="handleCancel"
	>
		<template #title>{{ title }}</template>

		<div class="selector-container">
			<!-- 内容区域 -->
			<div v-if="parsedContent" class="dialog-content">
				<html-renderer v-if="typeof parsedContent === 'object'" :schema="parsedContent" :context="{}" />
				<div v-else class="text-content">{{ parsedContent }}</div>
			</div>

			<!-- 物品选择器 -->
			<ItemSelector
				:class="{ 'ai-locked': aiActing }"
				:column="column"
				:item-list="itemList"
				:key-name="keyName"
				:multiple="multiple"
				:selected-key="normalizedSelectedKey"
				@update:selected-key="handleSelectedKeyUpdate"
			>
				<template #item="itemProps">
					<component v-if="renderItem" :is="renderItem(itemProps)" />
					<div v-else class="default-item-content">
						{{ itemProps.name || itemProps[keyName] }}
					</div>
				</template>
			</ItemSelector>

			<!-- 托管中：东西照样摆出来给人看，只是这一手由 AI 出 -->
			<div v-if="aiActing" class="ai-footer">
				<span class="ai-hint">
					<FontAwesomeIcon class="ai-icon" icon="robot" />
					AI 托管中，正在替你决定…
				</span>
				<button class="btn-takeover" @click="handleTakeOver">收回控制权</button>
			</div>

			<!-- 刚从 AI 手里收回来：留个口子，想接着托管就再交回去 -->
			<div v-else-if="aiControlled" class="ai-footer">
				<span class="ai-hint">已收回控制权，这一手由你自己决定</span>
				<button class="btn-takeover" @click="handleResumeAI">交还给 AI</button>
			</div>
		</div>
	</FpDialog>
</template>

<style scoped>
.selector-container {
	/* 限制高度，防止弹窗过长 */
	max-height: 60vh;
	overflow-y: auto;
	padding: 0.625rem;
}

.dialog-content {
	margin-bottom: 1rem;
	color: var(--fp-color-primary);
	text-align: center;
}

.dialog-content .text-content {
	white-space: pre-wrap;
	word-wrap: break-word;
	line-height: 1.6;
}

.default-item-content {
	padding: 1.25rem;
	text-align: center;
	font-weight: bold;
}

/* 托管期间物品只给看不给点，滚动还留给外层容器 */
.ai-locked {
	pointer-events: none;
}

.ai-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	margin-top: 0.9rem;
	padding-top: 0.7rem;
	border-top: 0.0625rem dashed var(--fp-color-border-light);
}

.ai-footer .ai-hint {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	color: var(--fp-color-text-secondary);
	font-size: 0.9rem;
}

.ai-footer .ai-icon {
	animation: ai-thinking-pulse 1.6s ease-in-out infinite;
}

.ai-footer .btn-takeover {
	flex-shrink: 0;
	padding: 0.5em 1.2em;
	border: 0.0625rem solid var(--fp-color-tertiary);
	border-radius: 0.375rem;
	background-color: #ffffff;
	color: var(--fp-color-tertiary);
	font-size: 0.95rem;
	cursor: pointer;
}

@keyframes ai-thinking-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.4;
	}
}
</style>
