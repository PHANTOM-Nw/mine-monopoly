// utils/item-selector/index.ts
import { createVNode, render, getCurrentInstance, type AppContext } from "vue";
import SelectorModal from "./selector-modal.vue";
import { GameEventType } from "@mine-monopoly/types";
import useEventBus from "@src/utils/event-bus";
import { onDialogDismiss, DialogDismissedError } from "../dialog-session";

interface SelectorOptions<T = any> {
	title?: string;
	itemList: Array<T>;
	keyName?: keyof T;
	multiple?: number | boolean;
	column?: number;
	selectedKey?: string[];
	appContext?: AppContext;
	confirmText?: string;
	cancelText?: string;
	content?: string | object;
	/** 弹窗会话 ID，服务端靠它把这个弹窗收掉 */
	dialogId?: string;
	/** 这次由 AI 托管作答，弹窗只做展示 */
	aiControlled?: boolean;
	/** 玩家在弹窗里点了「收回控制权」 */
	onTakeover?: () => void;
	/** 玩家在弹窗里点了「交还给 AI」 */
	onResumeai?: () => void;
}

export function showItemSelector(options: SelectorOptions): Promise<string[]> {
	return new Promise((resolve, reject) => {
		// 1. 创建容器
		const container = document.createElement("div");

		// 2. 超时处理
		const handleTimeout = () => {
			reject([]);
			destroy();
		};

		// 2.1 服务端收掉这次弹窗（例如托管中的 AI 已经替玩家作答）
		const handleDismiss = () => {
			reject(new DialogDismissedError());
			destroy();
		};

		// 3. 准备 Props
		const props = {
			...options,
			// 监听组件抛出的 confirm 事件
			onConfirm: (result: string[]) => {
				resolve(result);
				destroy();
			},
			// 监听组件抛出的 cancel 事件
			onCancel: () => {
				reject("cancel");
				destroy();
			},
		};

		// 4. 创建虚拟节点
		const vnode = createVNode(SelectorModal, props);

		// 5. 关键步骤：继承应用上下文
		if (options.appContext) {
			vnode.appContext = options.appContext;
		} else {
			// 尝试自动获取（仅在 setup 期间调用有效）
			const currentInstance = getCurrentInstance();
			if (currentInstance) {
				vnode.appContext = currentInstance.appContext;
			}
		}

		// 6. 渲染
		render(vnode, container);
		document.body.appendChild(container);

		// 7. 打开弹窗
		if (vnode.component && vnode.component.exposed) {
			(vnode.component.exposed as any).init();
		}

		// 8. 注册超时事件监听
		useEventBus().once(GameEventType.TimeOut, handleTimeout);
		const offDialogDismiss = onDialogDismiss(options.dialogId, handleDismiss);

		// 9. 销毁逻辑
		function destroy() {
			useEventBus().remove(GameEventType.TimeOut, handleTimeout);
			offDialogDismiss();
			setTimeout(() => {
				render(null, container);
				document.body.removeChild(container);
			}, 350);
		}
	});
}
