import { invokeTool } from "../bridge.js";
import { errorResult, successResult } from "../utils.js";
import { z } from "zod";

const ValidateMapSchema = z.object({
	checkLevel: z.enum(["basic", "strict"]).default("basic").describe("校验级别"),
});

export async function validateMapTool(args: unknown) {
	try {
		const result = await invokeTool("validate_map", args);
		return successResult(result);
	} catch (error: any) {
		return errorResult(error.message || "Failed to validate map", "MAP_VALIDATION_FAILED");
	}
}

export const validateMapTools = [
	{
		name: "validate_map",
		description: "校验地图索引、重复坐标与无效关联。参数：checkLevel（basic 或 strict，默认 basic）。",
		inputSchema: ValidateMapSchema,
		handler: validateMapTool,
	},
];