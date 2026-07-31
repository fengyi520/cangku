import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock3, FileUp, History, Plus, RefreshCw, RotateCcw, Save, Trash2, X } from "lucide-react";
import { api, jsonBody } from "./api";
import { SimpleImportDialog } from "./SimpleImportDialog";
import type { DailyOutboundBatch, DailyOutboundDay, InventoryRow } from "./types";

type EditableLine = { skuId: string; quantity: number; note: string };

const statusLabels: Record<string, string> = {
  OPEN: "待登记",
  PROCESSING: "结算中",
  POSTED: "已结算",
  FAILED: "结算失败",
  REVERSED: "已回退",
};

function todayInWarehouse() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function linesFromBatch(batch?: DailyOutboundBatch | null): EditableLine[] {
  const lines = batch?.lines.map((line) => ({ skuId: line.skuId, quantity: line.quantity, note: line.note ?? "" })) ?? [];
  return lines.length ? lines : [{ skuId: "", quantity: 1, note: "" }];
}

function toast(message: string, tone: "success" | "error" = "success") {
  window.dispatchEvent(new CustomEvent("cangku:toast", { detail: { message, tone } }));
}

export function DailyOutboundPage({ canReverse }: { canReverse: boolean }) {
  const queryClient = useQueryClient();
  const date = todayInWarehouse();
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState<EditableLine[]>([{ skuId: "", quantity: 1, note: "" }]);
  const [importOpen, setImportOpen] = useState(false);
  const [supplementOpen, setSupplementOpen] = useState(false);
  const daily = useQuery({
    queryKey: ["daily-outbound", date],
    queryFn: () => api<DailyOutboundDay>(`/daily-outbound?date=${date}`),
    refetchInterval: 15_000,
  });
  const history = useQuery({ queryKey: ["daily-outbound-history"], queryFn: () => api<DailyOutboundBatch[]>("/daily-outbound/history") });
  const inventory = useQuery({ queryKey: ["inventory", "daily-outbound"], queryFn: () => api<InventoryRow[]>("/inventory/balances") });
  const automatic = daily.data?.automaticBatch;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => setDraft(linesFromBatch(automatic)), [automatic?.id, automatic?.version]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["daily-outbound"] });
    queryClient.invalidateQueries({ queryKey: ["daily-outbound-history"] });
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["documents"] });
  };
  const save = useMutation({
    mutationFn: () => api(`/daily-outbound/${automatic!.id}`, { method: "PUT", body: jsonBody({ version: automatic!.version, lines: cleanLines(draft) }) }),
    onSuccess: () => { toast("今日登记已保存"); refresh(); },
    onError: (error) => toast(error instanceof Error ? error.message : "保存失败", "error"),
  });
  const settle = useMutation({
    mutationFn: (id: string) => api(`/daily-outbound/${id}/settle`, { method: "POST" }),
    onSuccess: () => { toast("出库批次已结算"); refresh(); },
    onError: (error) => { toast(error instanceof Error ? error.message : "结算失败", "error"); refresh(); },
  });
  const reverse = useMutation({
    mutationFn: (id: string) => api(`/daily-outbound/${id}/reverse`, { method: "POST" }),
    onSuccess: () => { toast("该批次库存已恢复"); refresh(); },
    onError: (error) => toast(error instanceof Error ? error.message : "回退失败", "error"),
  });

  const remaining = Math.max(0, new Date(daily.data?.scheduledAt ?? 0).getTime() - now);
  const countdown = daily.data?.beforeCutoff && remaining > 0 ? formatDuration(remaining) : "已到结算时间";
  const editable = automatic && (automatic.status === "OPEN" || automatic.status === "FAILED");
  const total = cleanLines(draft).reduce((sum, line) => sum + line.quantity, 0);

  if (daily.isLoading || inventory.isLoading) return <div className="page-loading"><span /><span /><span /></div>;
  if (daily.error || !daily.data) return <div className="fatal-state"><AlertTriangle size={28} /><h2>无法读取今日出库</h2><p>{daily.error instanceof Error ? daily.error.message : "请稍后重试"}</p><button className="button" onClick={() => daily.refetch()}><RefreshCw size={16} />重试</button></div>;

  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">每日登记与自动结算</p><h1>今日出库</h1><p>白天持续登记，到设定时间后整批校验并扣减库存。</p></div>
        <div className="page-actions daily-page-actions">
          <button className="button" onClick={() => setImportOpen(true)}><FileUp size={16} />导入登记</button>
          {!daily.data.beforeCutoff && <button className="button primary" onClick={() => setSupplementOpen(true)}><Plus size={16} />补充出库</button>}
        </div>
      </header>

      <section className="cutoff-rail" aria-label="今日自动结算时间">
        <div className="cutoff-clock"><Clock3 size={24} /><span>自动出库时间</span><strong>{daily.data.autoOutboundTime}</strong></div>
        <div className="cutoff-track"><i className={!daily.data.beforeCutoff ? "done" : ""} /><span>北京时间 · {date}</span></div>
        <div className="cutoff-countdown"><span>{daily.data.beforeCutoff ? "距离锁表" : "当前状态"}</span><strong>{countdown}</strong></div>
      </section>

      {automatic ? (
        <section className="daily-editor-band">
          <div className="daily-editor-heading">
            <div><span className={`status-badge ${automatic.status.toLowerCase()}`}>{statusLabels[automatic.status]}</span><h2>自动结算批次</h2><small>共 {total} 件 · 最后编辑 {automatic.updatedBy.name}</small></div>
            <div>
              {automatic.status === "FAILED" && <button className="button" disabled={settle.isPending} onClick={() => settle.mutate(automatic.id)}><RefreshCw size={15} />重新结算</button>}
              {editable && <button className="button primary" disabled={save.isPending} onClick={() => save.mutate()}><Save size={15} />保存登记</button>}
              {automatic.status === "POSTED" && canReverse && <button className="button danger-text" disabled={reverse.isPending} onClick={() => window.confirm("回退后将恢复该批次全部库存，确定继续吗？") && reverse.mutate(automatic.id)}><RotateCcw size={15} />整批回退</button>}
            </div>
          </div>
          {automatic.error && <div className="batch-error"><AlertTriangle size={16} /><span>{automatic.error}</span></div>}
          {editable ? <BatchLinesEditor lines={draft} inventory={inventory.data ?? []} onChange={setDraft} /> : <BatchReadOnly batch={automatic} />}
        </section>
      ) : (
        <div className="empty-state"><Clock3 /><h3>今天没有自动批次</h3><p>结算时间后新增内容将作为独立补充批次立即扣库。</p></div>
      )}

      <section className="daily-history">
        <div className="section-heading"><div><h2>最近结算记录</h2><span>{history.data?.length ?? 0} 批</span></div><History size={16} /></div>
        {!history.data?.length ? <div className="empty-state compact"><History /><h3>暂无记录</h3><p>完成首个批次后会显示在这里。</p></div> : (
          <div className="table-wrap"><table><thead><tr><th>日期 / 批次</th><th>类型</th><th>数量</th><th>状态</th><th>正式单号</th><th>操作人</th><th>操作</th></tr></thead><tbody>
            {history.data.slice(0, 20).map((batch) => <tr key={batch.id}>
              <td><strong className="mono">{String(batch.businessDate).slice(0, 10)} · {batch.sequence + 1}</strong><small>{batch.postedAt ? formatDate(batch.postedAt) : "尚未过账"}</small></td>
              <td>{batch.kind === "AUTOMATIC" ? "自动批次" : "补充批次"}</td>
              <td className="number strong">{batch.lines.reduce((sum, line) => sum + line.quantity, 0)}</td>
              <td><span className={`status-badge ${batch.status.toLowerCase()}`}>{statusLabels[batch.status]}</span></td>
              <td className="mono">{batch.document?.documentNo ?? "-"}</td><td>{batch.createdBy.name}</td>
              <td>{batch.status === "POSTED" && canReverse && <button className="icon-button danger" title="整批回退" onClick={() => window.confirm("回退后将恢复该批次全部库存，确定继续吗？") && reverse.mutate(batch.id)}><RotateCcw size={15} /></button>}</td>
            </tr>)}</tbody></table></div>
        )}
      </section>

      {importOpen && <SimpleImportDialog kind="OUTBOUND" onClose={() => setImportOpen(false)} onConfirmed={refresh} />}
      {supplementOpen && <SupplementDialog inventory={inventory.data ?? []} onClose={() => setSupplementOpen(false)} onCreated={() => { setSupplementOpen(false); refresh(); }} />}
    </>
  );
}

function BatchLinesEditor({ lines, inventory, onChange }: { lines: EditableLine[]; inventory: InventoryRow[]; onChange: (lines: EditableLine[]) => void }) {
  const patch = (index: number, value: Partial<EditableLine>) => onChange(lines.map((line, lineIndex) => lineIndex === index ? { ...line, ...value } : line));
  return <div className="daily-lines-editor">
    <div className="daily-line-head"><span>商品规格</span><span>当前可用</span><span>出库数量</span><span>备注</span><span /></div>
    {lines.map((line, index) => {
      const sku = inventory.find((item) => item.id === line.skuId);
      return <div className="daily-line" key={index}>
        <label><span className="sr-only">商品规格</span><select aria-label={`第 ${index + 1} 行商品规格`} value={line.skuId} onChange={(event) => patch(index, { skuId: event.target.value })}><option value="">选择款号 / 颜色 / 尺码</option>{inventory.map((item) => <option key={item.id} value={item.id}>{item.style.styleNo} · {item.color}/{item.size}</option>)}</select></label>
        <strong className={sku && sku.available < line.quantity ? "negative" : ""}>{sku?.available ?? "-"}</strong>
        <label><span className="sr-only">出库数量</span><input aria-label={`第 ${index + 1} 行出库数量`} type="number" min="1" value={line.quantity} onChange={(event) => patch(index, { quantity: Number(event.target.value) })} /></label>
        <label><span className="sr-only">备注</span><input aria-label={`第 ${index + 1} 行备注`} value={line.note} onChange={(event) => patch(index, { note: event.target.value })} placeholder="可选" /></label>
        <button className="icon-button danger" aria-label={`删除第 ${index + 1} 行`} disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, lineIndex) => lineIndex !== index))}><Trash2 size={15} /></button>
      </div>;
    })}
    <button className="add-daily-line" type="button" onClick={() => onChange([...lines, { skuId: "", quantity: 1, note: "" }])}><Plus size={15} />添加商品</button>
  </div>;
}

function BatchReadOnly({ batch }: { batch: DailyOutboundBatch }) {
  return <div className="batch-readonly">{batch.lines.map((line) => <div key={line.id}><span><strong>{line.sku.style.styleNo}</strong>{line.sku.style.name}</span><span>{line.sku.color} / {line.sku.size}</span><strong>{line.quantity} 件</strong><small>{line.note || "-"}</small></div>)}</div>;
}

function SupplementDialog({ inventory, onClose, onCreated }: { inventory: InventoryRow[]; onClose: () => void; onCreated: () => void }) {
  const [lines, setLines] = useState<EditableLine[]>([{ skuId: "", quantity: 1, note: "" }]);
  const create = useMutation({
    mutationFn: () => api("/daily-outbound/supplements", { method: "POST", body: jsonBody({ lines: cleanLines(lines) }) }),
    onSuccess: () => { toast("补充批次已扣减库存"); onCreated(); },
  });
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="supplement-title"><header><div><p className="eyebrow">结算时间后追加</p><h2 id="supplement-title">补充出库</h2><p>保存时将立即校验并整批扣减库存。</p></div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={19} /></button></header><div className="modal-body"><BatchLinesEditor lines={lines} inventory={inventory} onChange={setLines} />{create.error && <div className="error-banner"><AlertTriangle size={16} />{create.error instanceof Error ? create.error.message : "结算失败"}</div>}<div className="modal-actions"><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!cleanLines(lines).length || create.isPending} onClick={() => create.mutate()}><Check size={15} />{create.isPending ? "正在结算" : "保存并立即扣库"}</button></div></div></section></div>;
}

function cleanLines(lines: EditableLine[]) {
  return lines.filter((line) => line.skuId && Number.isInteger(line.quantity) && line.quantity > 0).map((line) => ({ skuId: line.skuId, quantity: line.quantity, note: line.note || null }));
}

function formatDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

