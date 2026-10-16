const BASE = import.meta.env.VITE_API_BASE_URL ?? (window.location.port === "5173" ? "http://127.0.0.1:8787" : "");

export async function calendarRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}/api/calendar${path}`, {
    method, credentials: "include", headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) {
    const messages: Record<string, string> = {
      INVALID_TIME: "日期或时间不正确，请检查开始、结束、教学周和日期。",
      INVALID_INPUT: "填写的信息不完整或不正确，请检查后再试。",
      VERSION_CONFLICT: "活动已被修改，请刷新后重新打开，避免覆盖新内容。",
      IDEMPOTENCY_CONFLICT: "这次提交的内容已改变，请重新打开后保存。",
      NOT_FOUND: "条目已不存在或不可访问，请刷新。",
      FORBIDDEN: "没有权限执行此操作。", STORAGE_FAILED: "保存暂时失败，请稍后重试。"
    };
    throw new Error(messages[result.error] ?? (typeof result.error === "string" ? result.error : "日程操作失败，请重试。"));
  }
  return result as T;
}
