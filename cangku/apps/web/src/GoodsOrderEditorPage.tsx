import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Check, Clipboard, FileSpreadsheet, LoaderCircle, Plus, RotateCcw, Save, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, jsonBody } from "./api";
import { flattenQuantities, groupInventoryMatrix, mergeRecognizedRows, parseClipboardTable, type MergeConflict } from "./goods-order-domain";
import type { ImportJob, InventoryRow, StockDocument, Warehouse } from "./types";

type OrderType = "INBOUND" | "OUTBOUND";
type SaveState = "clean" | "dirty" | "saving" | "error";
type PreviewResult = {
  warehouse: Warehouse;
  type: OrderType;
  rows: Array<{
    skuId: string;
    skuCode: string;
    styleNo: string;
    name: string;
    color: string;
    size: string;
    stockStatus: string;
    quantity: number;
    currentOnHand: number;
    currentReserved: number;
    available: number;
    delta: number;
    projectedOnHand: number;
    errors: string[];
    warnings: string[];
  }>;
  totals: { quantity: number; delta: number };
  valid: boolean;
  previewToken: string;
  expiresAt: string;
};

function notify(message: string, tone: "success" | "error" = "success") {
  window.dispatchEvent(new CustomEvent("cangku:toast", { detail: { message, tone } }));
}

function sizeRank(size: string) {
  const order = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL", "6XL", "7XL"];
  const index = order.indexOf(size.toUpperCase());
  return index < 0 ? order.length + size.charCodeAt(0) : index;
}

function documentPayload(type: OrderType, warehouseId: string, sourceRef: string, counterparty: string, reason: string, quantities: Record<string, number>) {
  return {
    warehouseId,
    type,
    sourceRef: sourceRef.trim() || null,
    counterparty: counterparty.trim() || null,
    reason: reason.trim() || null,
    lines: flattenQuantities(quantities),
  };
}

export function GoodsOrderEditorPage({ canUseAi }: { canUseAi: boolean }) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEditing = Boolean(id);
  const [type, setType] = useState<OrderType>(searchParams.get("type") === "OUTBOUND" ? "OUTBOUND" : "INBOUND");
  const [warehouseId, setWarehouseId] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [saveState, setSaveState] = useState<SaveState>("dirty");
  const [search, setSearch] = useState("");
  const [showOnlyFilled, setShowOnlyFilled] = useState(false);
  const [hiddenRows, setHiddenRows] = useState<Set<string>>(() => new Set());
  const [rowToAdd, setRowToAdd] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [aiJobId, setAiJobId] = useState<string | null>(null);
  const [aiAcceptedRowIds, setAiAcceptedRowIds] = useState<string[]>([]);
  const [aiReviewRows, setAiReviewRows] = useState<NonNullable<ImportJob["rows"]>>([]);
  const [aiInvalidRows, setAiInvalidRows] = useState<NonNullable<ImportJob["rows"]>>([]);
  const [aiConflicts, setAiConflicts] = useState<MergeConflict[]>([]);
  const [aiReviewRequired, setAiReviewRequired] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useRef(false);
  const lastSavedFingerprint = useRef("");
  const draftId = useRef<string | null>(id ?? null);
  const draftVersion = useRef(1);
  const createKey = useRef(`goods-draft-${crypto.randomUUID()}`);
  const mergedJobId = useRef<string | null>(null);
  const pendingApplyJob = useRef<string | null>(null);
  const matrixInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const warehouses = useQuery({ queryKey: ["warehouses"], queryFn: () => api<Warehouse[]>("/warehouses") });
  const document = useQuery({ queryKey: ["document", id], queryFn: () => api<StockDocument>(`/documents/${id}`), enabled: isEditing });
  const inventory = useQuery({ queryKey: ["goods-order-inventory", warehouseId], queryFn: () => api<InventoryRow[]>(`/inventory/balances?warehouseId=${encodeURIComponent(warehouseId)}`), enabled: Boolean(warehouseId) });
  const aiJob = useQuery({ queryKey: ["goods-order-ai", aiJobId], queryFn: () => api<ImportJob>(`/imports/${aiJobId}`), enabled: Boolean(aiJobId), refetchInterval: (query) => ["QUEUED", "PROCESSING"].includes(query.state.data?.status ?? "") ? 1500 : false });

  useEffect(() => {
    if (!warehouseId && warehouses.data?.length) setWarehouseId(warehouses.data.find((item) => item.active)?.id ?? warehouses.data[0].id);
  }, [warehouseId, warehouses.data]);

  useEffect(() => {
    if (!document.data || hydrated.current) return;
    const current = document.data;
    setType(current.type === "OUTBOUND" ? "OUTBOUND" : "INBOUND");
    setWarehouseId(current.warehouseId);
    setSourceRef(current.sourceRef ?? "");
    setCounterparty(current.counterparty ?? "");
    setReason(current.reason ?? "");
    setQuantities(Object.fromEntries(current.lines.map((line) => [line.skuId, line.quantityPieces])));
    draftId.current = current.id;
    draftVersion.current = current.version;
    hydrated.current = true;
    lastSavedFingerprint.current = JSON.stringify(documentPayload(current.type === "OUTBOUND" ? "OUTBOUND" : "INBOUND", current.warehouseId, current.sourceRef ?? "", current.counterparty ?? "", current.reason ?? "", Object.fromEntries(current.lines.map((line) => [line.skuId, line.quantityPieces]))));
    setSaveState("clean");
  }, [document.data]);

  useEffect(() => {
    if (!isEditing && warehouses.data && !hydrated.current) hydrated.current = true;
  }, [isEditing, warehouses.data]);

  const payload = useMemo(() => documentPayload(type, warehouseId, sourceRef, counterparty, reason, quantities), [type, warehouseId, sourceRef, counterparty, reason, quantities]);
  const fingerprint = JSON.stringify(payload);
  const matrix = useMemo(() => groupInventoryMatrix(inventory.data ?? []), [inventory.data]);
  const sizes = useMemo(() => [...new Set((inventory.data ?? []).map((sku) => sku.size))].sort((left, right) => sizeRank(left) - sizeRank(right) || left.localeCompare(right)), [inventory.data]);
  const visibleMatrix = useMemo(() => matrix.filter((row) => !hiddenRows.has(row.key)), [hiddenRows, matrix]);
  const hiddenMatrix = useMemo(() => matrix.filter((row) => hiddenRows.has(row.key)), [hiddenRows, matrix]);
  const filteredMatrix = useMemo(() => visibleMatrix.filter((row) => {
    const matchesSearch = !search.trim() || `${row.styleNo} ${row.name} ${row.color}`.toLowerCase().includes(search.trim().toLowerCase());
    const filled = row.skus.some((sku) => (quantities[sku.id] ?? 0) > 0);
    return matchesSearch && (!showOnlyFilled || filled);
  }), [quantities, search, showOnlyFilled, visibleMatrix]);
  const totalQuantity = Object.values(quantities).reduce((sum, quantity) => sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0), 0);
  const validLines = payload.lines.length > 0;

  const save = useMutation({
    mutationFn: async (input: { fingerprint: string; draftId: string | null; version: number }) => {
      if (input.draftId) {
        return api<{ document: StockDocument; preview: PreviewResult }>(`/documents/${input.draftId}`, { method: "PUT", body: jsonBody({ ...payload, version: input.version }) });
      }
      return api<StockDocument>("/documents/drafts", { method: "POST", headers: { "Idempotency-Key": createKey.current }, body: jsonBody(payload) });
    },
    onSuccess: (result, variables) => {
      const saved = "document" in result ? result.document : result;
      draftId.current = saved.id;
      draftVersion.current = saved.version;
      lastSavedFingerprint.current = variables.fingerprint;
      setSaveState("clean");
      if (!id) navigate(`/documents/${saved.id}/edit`, { replace: true });
    },
    onError: (reason) => { setSaveState("error"); setError(reason instanceof Error ? reason.message : "草稿保存失败"); },
  });

  useEffect(() => {
    if (!hydrated.current || !validLines || step !== "edit" || fingerprint === lastSavedFingerprint.current || save.isPending) return;
    setSaveState("dirty");
    const timer = window.setTimeout(() => save.mutate({ fingerprint, draftId: draftId.current, version: draftVersion.current }), 800);
    return () => window.clearTimeout(timer);
  }, [fingerprint, validLines, step, save.isPending]);

  const previewRequest = useMutation({
    mutationFn: async () => {
      let currentDraftId = draftId.current;
      if (!validLines) throw new Error("至少填写一个数量后才能预览");
      if (fingerprint !== lastSavedFingerprint.current || !currentDraftId) {
        const result = await save.mutateAsync({ fingerprint, draftId: currentDraftId, version: draftVersion.current });
        const saved = "document" in result ? result.document : result;
        currentDraftId = saved.id;
        draftId.current = saved.id;
        draftVersion.current = saved.version;
        lastSavedFingerprint.current = fingerprint;
      }
      return api<PreviewResult>("/documents/preview", { method: "POST", body: jsonBody(payload) });
    },
    onSuccess: (result) => { setPreview(result); setStep("preview"); setError(null); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "预览失败"),
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!draftId.current || !preview) throw new Error("预览已失效，请重新预览");
      return api<StockDocument>(`/documents/${draftId.current}/commit`, { method: "POST", headers: { "Idempotency-Key": `goods-commit-${crypto.randomUUID()}` }, body: jsonBody({ previewToken: preview.previewToken }) });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      notify(`${result.type === "INBOUND" ? "入库" : "出库"}已提交，库存已更新`);
      navigate(`/documents/${result.type}`);
    },
    onError: (reason) => { setError(reason instanceof Error ? reason.message : "提交失败，请重新预览"); setStep("edit"); setPreview(null); },
  });

  const cancel = useMutation({
    mutationFn: () => draftId.current ? api(`/documents/${draftId.current}/cancel`, { method: "POST", body: jsonBody({ version: draftVersion.current }) }) : Promise.resolve(),
    onSuccess: () => navigate(`/documents/${type}`),
  });

  const aiUpload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set("file", aiFile.current!);
      form.set("kind", type);
      form.set("warehouseId", warehouseId);
      return api<{ job_id: string }>("/imports", { method: "POST", body: form });
    },
    onSuccess: (result) => { setAiJobId(result.job_id); setAiReviewRows([]); setAiInvalidRows([]); setAiAcceptedRowIds([]); mergedJobId.current = null; notify("文件已进入 AI 解析队列"); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "AI 文件上传失败"),
  });
  const aiFile = useRef<File | null>(null);
  const applyAi = useMutation({
    mutationFn: (jobId: string) => api(`/imports/${jobId}/apply-to-draft`, { method: "POST", body: jsonBody({ documentId: draftId.current, acceptedRowIds: aiAcceptedRowIds }) }),
    onError: (reason) => setError(reason instanceof Error ? reason.message : "AI 识别结果记录失败"),
  });

  useEffect(() => {
    const job = aiJob.data;
    if (!job || job.status !== "REVIEW" || mergedJobId.current === job.id || !job.rows) return;
    mergedJobId.current = job.id;
    const result = mergeRecognizedRows(quantities, job.rows);
    setQuantities(result.quantities);
    setAiConflicts(result.conflicts);
    setAiReviewRows(result.reviewRows);
    setAiInvalidRows(job.rows.filter((row) => row.validationErrors.length > 0 || !row.skuId));
    const metadata = job.rows.reduce<{ sourceRef?: string; counterparty?: string; note?: string }>((current, row) => {
      const normalized = row.normalized;
      return {
        sourceRef: current.sourceRef || (normalized.sourceRef ? String(normalized.sourceRef).trim() : undefined),
        counterparty: current.counterparty || (normalized.counterparty ? String(normalized.counterparty).trim() : undefined),
        note: current.note || (normalized.note ? String(normalized.note).trim() : undefined),
      };
    }, {});
    if (!sourceRef.trim() && metadata.sourceRef) setSourceRef(metadata.sourceRef);
    if (!counterparty.trim() && metadata.counterparty) setCounterparty(metadata.counterparty);
    if (!reason.trim() && metadata.note) setReason(metadata.note);
    setAiAcceptedRowIds(job.rows.filter((row) => !row.validationErrors.length && row.skuId).map((row) => row.id));
    setAiReviewRequired(result.reviewRows.length > 0);
    pendingApplyJob.current = job.id;
    notify(result.conflicts.length ? "AI 识别完成，发现单元格冲突" : "AI 识别完成，结果已填入空白单元格");
  }, [aiJob.data, quantities]);

  useEffect(() => {
    if (!draftId.current || !pendingApplyJob.current || !aiAcceptedRowIds.length || applyAi.isPending || aiInvalidRows.length || aiConflicts.length || aiReviewRequired) return;
    const jobId = pendingApplyJob.current;
    pendingApplyJob.current = null;
    applyAi.mutate(jobId);
  }, [draftId.current, aiAcceptedRowIds, aiConflicts.length, aiInvalidRows.length, aiReviewRequired, applyAi.isPending]);

  const updateQuantity = (skuId: string, value: string) => {
    const quantity = value === "" ? 0 : Number(value);
    setQuantities((current) => ({ ...current, [skuId]: Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : 0 }));
    setPreview(null);
    setStep("edit");
  };

  const parsePaste = () => {
    const result = parseClipboardTable(pasteText, inventory.data ?? []);
    setPasteErrors(result.errors);
    if (result.matches.length) {
      setQuantities((current) => {
        const next = { ...current };
        for (const match of result.matches) next[match.skuId] = (next[match.skuId] ?? 0) + match.quantity;
        return next;
      });
      setPasteText("");
      notify(`已导入 ${result.matches.length} 个规格`);
    }
  };

  const clearRows = (rows: typeof matrix, hide: boolean) => {
    setQuantities((current) => {
      const next = { ...current };
      for (const row of rows) for (const sku of row.skus) delete next[sku.id];
      return next;
    });
    if (hide) setHiddenRows((current) => new Set([...current, ...rows.map((row) => row.key)]));
    setPreview(null);
    setStep("edit");
  };

  const addRow = () => {
    if (!rowToAdd) return;
    setHiddenRows((current) => {
      const next = new Set(current);
      next.delete(rowToAdd);
      return next;
    });
    setRowToAdd("");
  };

  const moveMatrixFocus = (rowIndex: number, sizeIndex: number, key: string) => {
    const rowStep = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    const sizeStep = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!rowStep && !sizeStep) return;
    let nextRow = rowIndex;
    let nextSize = sizeIndex;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      nextRow += rowStep;
      nextSize += sizeStep;
      if (nextRow < 0 || nextRow >= filteredMatrix.length || nextSize < 0 || nextSize >= sizes.length) return;
      const sku = filteredMatrix[nextRow].skus.find((item) => item.size === sizes[nextSize]);
      if (sku) {
        window.requestAnimationFrame(() => matrixInputRefs.current[sku.id]?.focus());
        return;
      }
      if (rowStep) nextSize = sizeIndex;
      if (sizeStep) nextRow = rowIndex;
    }
  };

  const handleMatrixKeyDown = (event: KeyboardEvent<HTMLInputElement>, rowIndex: number, sizeIndex: number) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    moveMatrixFocus(rowIndex, sizeIndex, event.key);
  };

  const acceptConflicts = () => {
    setQuantities((current) => ({ ...current, ...Object.fromEntries(aiConflicts.map((conflict) => [conflict.skuId, conflict.incoming])) }));
    setAiConflicts([]);
  };

  const keepConflicts = () => setAiConflicts([]);

  const canPreview = validLines && Boolean(warehouseId) && !aiReviewRequired && !aiInvalidRows.length && !aiConflicts.length && !save.isPending && !previewRequest.isPending;

  return (
    <div className="goods-order-page">
      <header className="goods-order-header">
        <div className="goods-order-title">
          <button className="icon-button" aria-label="返回货单列表" onClick={() => navigate(`/documents/${type}`)}><ArrowLeft size={18} /></button>
          <div><p className="eyebrow">库存货单工作台</p><h1>{isEditing ? "编辑货单" : "新建货单"}</h1><p>{step === "edit" ? "先录入款号、颜色和尺码数量，再预览库存变化。" : "确认每一行的预计库存后提交，提交会立即写入库存流水。"}</p></div>
        </div>
        <div className="goods-order-stepper" aria-label="货单步骤"><span className={step === "edit" ? "active" : "done"}>01 编辑</span><i /><span className={step === "preview" ? "active" : ""}>02 预览并提交</span></div>
      </header>

      <section className="goods-order-meta">
        <div className="goods-order-type" role="group" aria-label="货单类型">
          <button className={type === "INBOUND" ? "active inbound" : ""} onClick={() => { setType("INBOUND"); setPreview(null); }}><ArrowDownToLine size={16} />入库</button>
          <button className={type === "OUTBOUND" ? "active outbound" : ""} onClick={() => { setType("OUTBOUND"); setPreview(null); }}><ArrowUpFromLine size={16} />出库</button>
        </div>
        <label>仓库<select aria-label="仓库" value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setPreview(null); }}>{warehouses.data?.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name} / {item.code}</option>)}</select></label>
        <label>来源单号<input aria-label="来源单号" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="可选" /></label>
        <label>往来方<input aria-label="往来方" value={counterparty} onChange={(event) => setCounterparty(event.target.value)} placeholder={type === "OUTBOUND" ? "客户或平台" : "供应商或往来单位"} /></label>
        <label className="goods-order-reason">备注<input aria-label="货单备注" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选，写入审计记录" /></label>
      </section>

      {step === "edit" ? (
        <>
          <section className="goods-order-tools">
            <div className="goods-order-search"><input aria-label="搜索款号或颜色" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索款号、品名或颜色" /><span>{filteredMatrix.length} 行规格</span></div>
            <div className="goods-order-tool-actions"><label className="check-toggle"><input type="checkbox" checked={showOnlyFilled} onChange={(event) => setShowOnlyFilled(event.target.checked)} />仅看已填写</label><button className="button" onClick={() => clearRows(matrix, false)} disabled={!totalQuantity}><Trash2 size={15} />批量清空</button><button className="button" onClick={() => setPasteOpen((value) => !value)}><Clipboard size={15} />粘贴表格</button>{canUseAi && <label className="button ai-upload"><Sparkles size={15} />AI 识别<input type="file" accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => { aiFile.current = event.target.files?.[0] ?? null; if (aiFile.current) aiUpload.mutate(); }} /></label>}</div>
          </section>
          {pasteOpen && <section className="goods-order-paste"><div><strong>粘贴货单数据</strong><small>支持“款号/颜色/尺码/数量”明细，或首行尺码、首列款号的矩阵。</small></div><textarea aria-label="粘贴货单数据" value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="款号\t颜色\t尺码\t数量\n901\t黑色\tM\t12" /><div className="goods-order-paste-actions"><button className="button" onClick={() => setPasteText("")}>清空</button><button className="button primary" disabled={!pasteText.trim()} onClick={parsePaste}><Clipboard size={14} />解析并填入</button></div>{pasteErrors.length > 0 && <div className="error-banner"><AlertTriangle size={15} />{pasteErrors.join("；")}</div>}</section>}
          {aiJob.data && <section className="goods-order-ai-status"><Sparkles size={17} /><div><strong>{aiJob.data.status === "REVIEW" ? "AI 识别已完成" : aiJob.data.status === "FAILED" ? "AI 识别失败" : "AI 正在识别文件"}</strong><small>{aiJob.data.fileName} · {aiJob.data.status === "REVIEW" ? `${aiJob.data.rows?.length ?? 0} 行待确认` : `${aiJob.data.progress}%`}</small></div>{["QUEUED", "PROCESSING"].includes(aiJob.data.status) && <LoaderCircle className="spin" size={17} />}</section>}
          {aiInvalidRows.length > 0 && <section className="goods-order-ai-errors"><AlertTriangle size={16} /><div><strong>{aiInvalidRows.length} 行无法自动填入</strong><small>不会创建新商品，请先在矩阵中人工修正或明确忽略。</small><ul>{aiInvalidRows.map((row) => <li key={row.id}>第 {row.rowNumber} 行：{row.validationErrors.join("；") || "SKU 不存在"}</li>)}</ul></div><button className="button" onClick={() => setAiInvalidRows([])}>忽略无效行</button></section>}
          {aiConflicts.length > 0 && <section className="goods-order-conflicts"><div><strong>AI 与手工输入存在冲突</strong><small>请选择每组冲突的处理方式，未选择前不能预览。</small><ul>{aiConflicts.map((conflict) => <li key={conflict.skuId}>{conflict.styleNo} / {conflict.color} / {conflict.size}：手工 {conflict.current}，AI {conflict.incoming}</li>)}</ul></div><div className="goods-order-conflict-actions"><button className="button" onClick={keepConflicts}>保留手工值</button><button className="button" onClick={acceptConflicts}>覆盖 {aiConflicts.length} 项</button></div></section>}
          {aiReviewRequired && <section className="goods-order-review"><AlertTriangle size={16} /><span>有 {aiReviewRows.length} 行识别置信度较低，请人工核对后再预览。</span><button className="button small" onClick={() => setAiReviewRequired(false)}>我已核对</button></section>}
          <section className="goods-order-matrix-wrap">
            <div className="goods-order-matrix-head"><div><strong>货单明细</strong><span>{totalQuantity.toLocaleString()} 件 · 单元格为件数</span></div><div className="goods-order-matrix-head-actions">{hiddenMatrix.length > 0 && <><select aria-label="添加款号颜色行" value={rowToAdd} onChange={(event) => setRowToAdd(event.target.value)}><option value="">添加款号 / 颜色行</option>{hiddenMatrix.map((row) => <option key={row.key} value={row.key}>{row.styleNo} / {row.color}</option>)}</select><button className="icon-button" aria-label="添加款号颜色行" title="添加款号颜色行" onClick={addRow} disabled={!rowToAdd}><Plus size={15} /></button></>}<span className="save-indicator">{saveState === "saving" || save.isPending ? <><LoaderCircle className="spin" size={14} />保存中</> : saveState === "clean" ? <><Check size={14} />已保存</> : saveState === "error" ? <><AlertTriangle size={14} />保存失败</> : <><Save size={14} />待保存</>}</span></div></div>
            <div className="goods-order-matrix-scroll"><table className="goods-order-matrix"><thead><tr><th className="sticky-col style-col">款号 / 品名</th><th className="sticky-col color-col">颜色</th>{sizes.map((size) => <th key={size}>{size}</th>)}<th className="matrix-action-col">操作</th></tr></thead><tbody>{filteredMatrix.map((row, rowIndex) => <tr key={row.key}><th className="sticky-col style-col"><strong>{row.styleNo}</strong><small>{row.name}</small></th><th className="sticky-col color-col"><i className="swatch swatch-0" />{row.color}</th>{sizes.map((size, sizeIndex) => { const sku = row.skus.find((item) => item.size === size); const quantity = sku ? quantities[sku.id] ?? 0 : 0; const delta = type === "INBOUND" ? quantity : -quantity; return <td key={size}>{sku ? <><input ref={(element) => { matrixInputRefs.current[sku.id] = element; }} aria-label={`${row.styleNo} ${row.color} ${size} 数量`} title={`当前库存 ${sku.onHand}，可用 ${sku.available}，预计变更 ${delta > 0 ? "+" : ""}${delta}`} type="number" min="0" inputMode="numeric" value={quantity || ""} onKeyDown={(event) => handleMatrixKeyDown(event, rowIndex, sizeIndex)} onChange={(event) => updateQuantity(sku.id, event.target.value)} /><small className="matrix-cell-meta">库 {sku.onHand} · 可 {sku.available}{quantity > 0 ? ` · 变 ${delta > 0 ? "+" : ""}${delta}` : ""}</small></> : <span className="matrix-empty">—</span>}</td>; })}<td className="matrix-row-action"><button className="icon-button danger" aria-label={`清空 ${row.styleNo} ${row.color} 行`} title="清空并移除行" onClick={() => clearRows([row], true)}><Trash2 size={14} /></button></td></tr>)}</tbody></table>{!filteredMatrix.length && <div className="goods-order-empty"><FileSpreadsheet size={20} /><strong>没有匹配的规格行</strong><span>换一个搜索词，或从商品页先建立 SKU。</span></div>}</div>
          </section>
          <div className="goods-order-footer"><button className="button danger-text" onClick={() => cancel.mutate()} disabled={cancel.isPending}><Trash2 size={15} />取消草稿</button><div><button className="button" onClick={() => navigate(`/documents/${type}`)}>稍后处理</button><button className="button primary" disabled={!canPreview} onClick={() => previewRequest.mutate()}>{previewRequest.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}进入预览</button></div></div>
        </>
      ) : (
        <PreviewPanel preview={preview} onBack={() => setStep("edit")} onCommit={() => commit.mutate()} pending={commit.isPending} error={error} />
      )}
      {error && step === "edit" && <div className="error-banner goods-order-error"><AlertTriangle size={15} />{error}<button className="icon-button" aria-label="关闭错误" onClick={() => setError(null)}><X size={14} /></button></div>}
    </div>
  );
}

function PreviewPanel({ preview, onBack, onCommit, pending, error }: { preview: PreviewResult | null; onBack: () => void; onCommit: () => void; pending: boolean; error: string | null }) {
  if (!preview) return <div className="goods-order-empty"><AlertTriangle size={22} /><strong>预览已失效</strong><button className="button" onClick={onBack}><RotateCcw size={15} />重新编辑</button></div>;
  return <>
    <section className="goods-order-preview-summary"><div><p className="eyebrow">预览快照 · {new Date(preview.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</p><h2>{preview.type === "INBOUND" ? "入库预览" : "出库预览"}</h2><p>{preview.warehouse.name} · 共 {preview.totals.quantity.toLocaleString()} 件 · 预计库存 {preview.totals.delta > 0 ? "+" : ""}{preview.totals.delta.toLocaleString()} 件</p></div><span className={`preview-verdict ${preview.valid ? "valid" : "invalid"}`}>{preview.valid ? <><Check size={16} />可以提交</> : <><AlertTriangle size={16} />存在库存问题</>}</span></section>
    <section className="goods-order-preview-table"><table><thead><tr><th>款号 / SKU</th><th>颜色 / 尺码</th><th>当前库存</th><th>变更</th><th>预计库存</th><th>校验</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={`${row.skuId}-${row.stockStatus}`}><td><strong>{row.styleNo}</strong><small>{row.skuCode}</small></td><td>{row.color} / {row.size}</td><td>{row.currentOnHand} <small>可用 {row.available}</small></td><td className={row.delta < 0 ? "negative" : "positive"}>{row.delta > 0 ? "+" : ""}{row.delta}</td><td className="strong-number">{row.projectedOnHand}</td><td>{row.errors.length ? <span className="alert-label"><AlertTriangle size={14} />{row.errors.join("；")}</span> : row.warnings.length ? <span className="warning-label"><AlertTriangle size={14} />{row.warnings.join("；")}</span> : <span className="ok-label"><Check size={14} />通过</span>}</td></tr>)}</tbody></table></section>
    {error && <div className="error-banner"><AlertTriangle size={15} />{error}</div>}
    <div className="goods-order-footer"><button className="button" onClick={onBack}><ArrowLeft size={15} />返回编辑</button><button className="button primary" disabled={!preview.valid || pending} onClick={onCommit}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending ? "正在提交" : `确认提交${preview.type === "INBOUND" ? "入库" : "出库"}`}</button></div>
  </>;
}
