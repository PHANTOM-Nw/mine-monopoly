import { TargetSelectType } from "@mine-monopoly/types";
import { App, createApp, h, render } from "vue";
import TargetSelector from "./index.vue";
import { FPMessageBox } from "@src/components/utils/fp-message-box";

export async function showTargetSelector(
	type: TargetSelectType,
	option?: {
		title?: string;
		confirmText?: string;
		cancelText?: string;
		/** 弹窗会话 ID，服务端靠它把这个弹窗收掉 */
		dialogId?: string;
		/** 这次由 AI 托管作答，弹窗只做展示 */
		aiControlled?: boolean;
		/** 玩家在弹窗里点了「收回控制权」 */
		onTakeover?: () => void;
		/** 玩家在弹窗里点了「交还给 AI」 */
		onResumeai?: () => void;
	},
) {
	return new Promise<string[]>((resolve, reject) => {
		let targetSelectedIdList: string[] = [];
		FPMessageBox({
			title: option ? option.title : "选择目标",
			content: h(TargetSelector, {
				targetType: type,
				onTargetSelected: (newValue: string[]) => {
					targetSelectedIdList = newValue;
				},
			}),
			cancelText: option?.cancelText,
			confirmText: option?.confirmText,
			dialogId: option?.dialogId,
			aiControlled: option?.aiControlled,
			onTakeover: option?.onTakeover,
			onResumeai: option?.onResumeai,
		})
			.then(() => {
				console.log("🚀 ~ showTargetSelector ~ targetSelectedIdList:", targetSelectedIdList);
				resolve(targetSelectedIdList);
			})
			.catch((error) => {
				// 用户取消操作；服务端主动收掉弹窗时把原因带出去，调用方不要当成「取消」再回一次结果
				reject(error ?? null);
			});
	});
}
