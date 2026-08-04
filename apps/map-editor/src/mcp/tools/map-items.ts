/**
 * MCP Tools for MapItem Query
 *
 * This module provides read-only query operations for map items through the IPC Bridge.
 */

import { invokeTool } from "../bridge.js";
import { successResult, errorResult } from "../utils.js";
import { z } from "zod";

const ListMapItemsToolSchema = z.object({});

const GetMapItemToolSchema = z.object({
	mapItemId: z.string().describe("地图项ID"),
});

const QueryMapItemsToolSchema = z.object({
	typeId: z.string().optional().describe("地图项类型ID"),
	hasProperty: z.boolean().optional().describe("是否仅返回有地皮的地图项"),
	minX: z.number().optional(),
	maxX: z.number().optional(),
	minY: z.number().optional(),
	maxY: z.number().optional(),
	offset: z.number().int().min(0).default(0),
	limit: z.number().int().min(1).max(200).default(50),
});

/**
 * List all map items with summary info
 */
export async function listMapItems(args: unknown) {
	try {
		const result = await invokeTool("list_map_items", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to list map items");
	}
}

/**
 * Get a single map item with full details
 */
export async function getMapItem(args: unknown) {
	try {
		const result = await invokeTool("get_map_item", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to get map item");
	}
}

export async function queryMapItems(args: unknown) {
	try {
		return successResult(await invokeTool("query_map_items", QueryMapItemsToolSchema.parse(args)));
	} catch (error: any) {
		return errorResult(error.message || "Failed to query map items");
	}
}

/**
 * Export tool definitions for MCP server
 */
export const mapItemTools = [
	{
		name: "list_map_items",
		description: "列出地图中所有地图项的摘要信息。返回每个地图项的 id、类型名称、坐标、是否已有地皮等信息。",
		inputSchema: ListMapItemsToolSchema,
		handler: listMapItems,
	},
	{
		name: "get_map_item",
		description: "根据ID获取单个地图项的完整信息，包含类型详情、地皮属性、关联的地图事件等。",
		inputSchema: GetMapItemToolSchema,
		handler: getMapItem,
	},
	{
		name: "query_map_items",
		description: "按类型、地皮状态和坐标范围筛选地图项摘要，并分页返回。",
		inputSchema: QueryMapItemsToolSchema,
		handler: queryMapItems,
	},
];