import { _axios } from "@/utils/axios";
import type { ApiResponse, GameMapInDb, GameMapStatus } from "@mine-monopoly/types";

export const createGameMap = async (formData: FormData) => {
	const res = await _axios.post<ApiResponse<string>>("/game-map/create", formData);
	return res.data.data;
};

export const updateGameMap = async (formData: FormData) => {
	const res = await _axios.post<ApiResponse<string>>("/game-map/update", formData);
	return res.data.data;
};

export const setGameMapUse = async (id: string, use: boolean) => {
	const res = await _axios.post<ApiResponse<string>>("/game-map/set-use", { id, use });
	return res.data.data;
};

export const getGameMapList = async (page: number, size: number) => {
	const res = await _axios.get<ApiResponse<{ total: number; gameMapList: GameMapInDb[]; current: number }>>(
		"/game-map/list",
		{ params: { page, size } }
	);
	return res.data.data;
};

export const getAdminGameMapList = async (params: {
	page: number;
	size: number;
	creatorId?: string;
	status?: GameMapStatus | "all";
}) => {
	const res = await _axios.get<ApiResponse<{ total: number; gameMapList: GameMapInDb[]; current: number }>>(
		"/game-map/admin-list",
		{ params: { ...params, status: params.status === "all" ? undefined : params.status } }
	);
	return res.data.data;
};

export const reviewGameMap = async (params: {
	mapId: string;
	action: "approve" | "reject" | "offline" | "online" | "delete";
	reason?: string;
}) => {
	const res = await _axios.post<ApiResponse<GameMapInDb>>("/game-map/review", params);
	return res.data.data;
};

export const bindGameMapCreator = async (mapId: string, creatorId: string) => {
	const res = await _axios.post<ApiResponse<GameMapInDb>>("/game-map/bind-creator", { mapId, creatorId });
	return res.data.data;
};

export const deleteGameMap = async (id: string) => {
	const res = await _axios.delete<ApiResponse<string>>("/game-map/delete", { params: { id } });
	return res.data.data;
};

export const getGameMapInfo = async (id: string) => {
	const res = await _axios.get<ApiResponse<GameMapInDb>>("/game-map/info", { params: { id } });
	return res.data.data;
};