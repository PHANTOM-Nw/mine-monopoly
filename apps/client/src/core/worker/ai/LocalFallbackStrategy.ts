import { AIDecisionOption, AIDecisionRequest, AIDecisionSelection, PropertyInfo } from "@mine-monopoly/types";

/**
 * 远程模型给不出结果时的本地兜底策略。
 *
 * 没有它的话，托管 = 啥也不干：LLM 没配置、请求失败、桥接超时、模型答非所问，
 * 最终都会落到 defaultValue（确认框是 confirm:false），于是 AI 玩家骰子照掷、
 * 路照走，但地不买、卡不用、表单不交 —— 一个纯路人。这里至少让它按常识出手。
 *
 * 只管四种弹窗场景。掷骰子、动态按钮、掷骰前的用卡决策不在此列：
 * 那几处「不出手」本身就是安全且合理的默认（照常掷骰进入下一步），
 * 乱按按钮、乱打牌的破坏性远大于收益。
 */

/** 选择里到底有没有落子 —— 和远程侧 normalizeSelection 的判定口径保持一致 */
export function hasUsableAISelection(selection: AIDecisionSelection | undefined | null): boolean {
	if (!selection) return false;
	return Boolean(
		selection.optionId ||
			(selection.optionIds && selection.optionIds.length > 0) ||
			selection.submitted !== undefined ||
			selection.fieldValues,
	);
}

export function buildLocalFallbackSelection(request: AIDecisionRequest): AIDecisionSelection | undefined {
	switch (request.scene) {
		case "confirm-dialog":
			return buildConfirmFallback(request);
		case "form-dialog":
			return pickOptionById(request, "__submit__")
				? { optionId: "__submit__", submitted: true, reason: "local_fallback_submit" }
				: undefined;
		case "target-select":
			return buildTargetFallback(request);
		case "item-select":
			return buildItemFallback(request);
		default:
			return undefined;
	}
}

function selectableOptions(request: AIDecisionRequest): AIDecisionOption[] {
	return request.options.filter(
		(option) => !option.hidden && !option.disabled && option.id !== "__cancel__" && option.actionType !== "cancel",
	);
}

function pickOptionById(request: AIDecisionRequest, id: string): AIDecisionOption | undefined {
	return request.options.find((option) => option.id === id && !option.hidden && !option.disabled);
}

/**
 * 确认框：默认答应。
 *
 * 唯一会拒绝的情况是钱不够 —— 引擎买地和升级都按 sellCost 收，而且要求
 * money > sellCost（handlePlayerBuyProperty / handlePlayerBuildUp），
 * 答应了也只会换来一句「不够钱啊穷鬼」，白白把弹窗流程走一遍。
 */
function buildConfirmFallback(request: AIDecisionRequest): AIDecisionSelection | undefined {
	if (!pickOptionById(request, "__confirm__")) return undefined;

	const price = findStandingPropertyPrice(request);
	if (price !== undefined && request.context.player.money <= price) {
		return pickOptionById(request, "__cancel__")
			? { optionId: "__cancel__", reason: "local_fallback_cannot_afford" }
			: undefined;
	}
	return { optionId: "__confirm__", reason: "local_fallback_confirm" };
}

/**
 * 找出「这个确认框问的是不是脚下这块地」，是的话返回它的成交价。
 *
 * 判断方式跟引擎的 handleArriveEvent 一致：脚下的格子 linkto 到建筑格，
 * 建筑格上挂着 property。再要求标题/正文点名了这块地的名字，免得把地图脚本
 * 自己弹的无关确认框（机场、事件二选一之类）也套上地价判断。
 */
function findStandingPropertyPrice(request: AIDecisionRequest): number | undefined {
	const { player, mapIndex, mapItems, properties } = request.context;
	const standingItemId = mapIndex?.[player.positionIndex];
	if (!standingItemId) return undefined;

	const standingItem = mapItems?.find((item) => item.id === standingItemId);
	if (!standingItem?.linkto) return undefined;

	const linkedItem = mapItems?.find((item) => item.id === standingItem.linkto);
	const propertyId = linkedItem?.property?.id;
	if (!propertyId) return undefined;

	// 地图快照里的地产是开局那一份，价格以当前局内的为准
	const property: PropertyInfo | undefined =
		properties?.find((item) => item.id === propertyId) ?? linkedItem?.property;
	if (!property) return undefined;

	const haystack = `${request.title ?? ""} ${request.summary ?? ""}`;
	if (property.name && !haystack.includes(property.name)) return undefined;

	return property.sellCost;
}

/**
 * 选目标：挑现金最多的那个。
 * 卡牌多半是往人身上招呼的，打给最富的人期望收益最高；
 * 选地皮/地块时 payload 里没有玩家信息，自然退化成「选第一个」。
 */
function buildTargetFallback(request: AIDecisionRequest): AIDecisionSelection | undefined {
	const options = selectableOptions(request);
	if (!options.length) return undefined;

	const playerById = new Map(request.context.players.map((item) => [item.id, item]));
	const alive = options.filter((option) => !playerById.get(option.id)?.isBankrupted);
	const pool = alive.length ? alive : options;

	const best = pool.reduce((acc, cur) => {
		const accMoney = playerById.get(acc.id)?.money ?? Number.NEGATIVE_INFINITY;
		const curMoney = playerById.get(cur.id)?.money ?? Number.NEGATIVE_INFINITY;
		return curMoney > accMoney ? cur : acc;
	});

	return { optionId: best.id, reason: "local_fallback_target" };
}

/** 选物品：拿第一个能选的。只剩「取消」可点时就别硬选了 */
function buildItemFallback(request: AIDecisionRequest): AIDecisionSelection | undefined {
	const options = selectableOptions(request);
	if (!options.length) return undefined;
	return { optionIds: [options[0].id], reason: "local_fallback_item" };
}
