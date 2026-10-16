import { useCallback, useEffect, useState } from "react";
import { calendarRequest } from "./calendar-api";

type Delivery = { id: string; kind: "task" | "reminder"; state: string; fireAt?: string; text?: string; acceptedAt?: string; error?: string };
const labels: Record<string, string> = { pending: "待发送", paused: "等待微信恢复", sending: "发送中", accepted: "平台已接受", unknown: "发送结果不明，已停止重发", expired: "已过时，不再发送", invalidated: "原提醒已作废" };
export function CalendarDeliveries() {
  const [items, setItems] = useState<Delivery[]>([]);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try { const result = await calendarRequest<{ deliveries: Delivery[] }>("/deliveries"); setItems(result.deliveries); setError(""); }
    catch { setError("暂时无法读取发送记录。"); }
  }, []);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 15_000); return () => clearInterval(timer); }, [reload]);
  return <details className="calendar-deliveries"><summary>提醒与微信回复记录（{items.length}）</summary>
    <p>平台接受后仍需在手机核对。发送结果不明时暂停重发；离线过久的旧提醒不会补发刷屏。</p>
    <button type="button" onClick={() => void reload()}>刷新发送记录</button>
    {error && <p role="alert">{error}</p>}
    {!items.length && <p>还没有发送任务。可选中活动设置提醒。</p>}
    <ul>{[...items].reverse().slice(0, 30).map(item => <li key={item.id}>
      <strong>{item.kind === "reminder" ? "日程提醒" : "微信回复"} · {labels[item.state] ?? item.state}</strong>
      {item.fireAt && <time> · {new Date(item.fireAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>}
      {item.text && <p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>}
      {item.error && <small>{item.state === "unknown" ? "渠道没有返回确定结果；请先核对手机。" : item.state === "paused" ? "渠道恢复后会重新检查是否仍需发送。" : "任务状态已记录。"}</small>}
    </li>)}</ul>
  </details>;
}
