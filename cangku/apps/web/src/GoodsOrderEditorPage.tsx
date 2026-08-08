import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Boxes, Check, Clipboard, FileSpreadsheet, LoaderCircle, Plus, RotateCcw, Save, Shirt, Sparkles, Trash2, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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

function colorCodeFromSku(sku: InventoryRow) {
  const parts = sku.skuCode.split("-").map((part) => part.trim()).filter(Boolean);
  let sizeIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) if (parts[index].toLowerCase() === sku.size.toLowerCase()) { sizeIndex = index; break; }
  return sizeIndex > 0 ? parts[sizeIndex - 1] : "";
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

export function GoodsOrderEditorPage({ canUseAi, defaultType = "INBOUND", lockedType = false }: { canUseAi: boolean; defaultType?: OrderType; lockedType?: boolean }) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEditing = Boolean(id);
  const [type, setType] = useState<OrderType>(searchParams.get("type") === "OUTBOUND" ? "OUTBOUND" : defaultType);
  const [warehouseId, setWarehouseId] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [reason, setReason] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [saveState, setSaveState] = useState<SaveState>("dirty");
  const [search, setSearch] = useState("");
  const [showOnlyFilled, setShowOnlyFilled] = useState(false);
  const [selectedStyleKey, setSelectedStyleKey] = useState("");
  const [directColor, setDirectColor] = useState("");
  const [directSize, setDirectSize] = useState("");
  const [directQuantity, setDirectQuantity] = useState("");
  const [bulkScope, setBulkScope] = useState<"row" | "col" | "all">("row");
  const [bulkCartons, setBulkCartons] = useState("");
  const [bulkPerCarton, setBulkPerCarton] = useState("");
  const [bulkLoose, setBulkLoose] = useState("");
  const [bulkQuantity, setBulkQuantity] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [aiJobId, setAiJobId] = useState<string | null>(null);
  const [aiAcceptedRowIds, setAiAcceptedRowIds] = useState<string[]>([]);
  const [aiReviewRows, setAiReviewRows] = useState<NonNullable<ImportJob["rows"]>>([]);
  const [aiInvalidRows, setAiInvalidRows] = useState<NonNullable<ImportJob["rows"]>>([]);
  const [aiConflicts, setAiConflicts] = useState<MergeConflict[]>([]);
  const [aiReviewRequired, setAiReviewRequired] = useState(false);
  const [aiApplyStatus, setAiApplyStatus] = useState<"idle" | "pending" | "applied" | "error">("idle");
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
    if (!hydrated.current) return;
    resetAiState();
  }, [type, warehouseId]);

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
  const styleOptions = useMemo(() => {
    const options = new Map<string, { key: string; styleNo: string; name: string; skuCount: number }>();
    for (const sku of inventory.data ?? []) {
      const key = sku.style.id;
      const current = options.get(key);
      options.set(key, { key, styleNo: sku.style.styleNo, name: sku.style.name, skuCount: (current?.skuCount ?? 0) + 1 });
    }
    return [...options.values()].sort((left, right) => `${left.styleNo}\u0000${left.name}`.localeCompare(`${right.styleNo}\u0000${right.name}`));
  }, [inventory.data]);
  const selectedStyle = styleOptions.find((item) => item.key === selectedStyleKey) ?? styleOptions[0];

  useEffect(() => {
    if (!selectedStyleKey && styleOptions.length) setSelectedStyleKey(styleOptions[0].key);
    else if (selectedStyleKey && styleOptions.length && !styleOptions.some((item) => item.key === selectedStyleKey)) setSelectedStyleKey(styleOptions[0].key);
  }, [selectedStyleKey, styleOptions]);

  const selectedSkus = useMemo(() => (inventory.data ?? []).filter((sku) => sku.style.id === selectedStyle?.key), [inventory.data, selectedStyle?.key]);
  const colors = useMemo(() => {
    const groups = new Map<string, { color: string; code: string }>();
    for (const sku of selectedSkus) if (!groups.has(sku.color)) groups.set(sku.color, { color: sku.color, code: colorCodeFromSku(sku) });
    return [...groups.values()].sort((left, right) => `${left.code}\u0000${left.color}`.localeCompare(`${right.code}\u0000${right.color}`));
  }, [selectedSkus]);
  const sizes = useMemo(() => [...new Set(selectedSkus.map((sku) => sku.size))].sort((left, right) => sizeRank(left) - sizeRank(right) || left.localeCompare(right)), [selectedSkus]);
  const filteredColors = useMemo(() => colors.filter((item) => !showOnlyFilled || selectedSkus.some((sku) => sku.color === item.color && (quantities[sku.id] ?? 0) > 0)), [colors, quantities, selectedSkus, showOnlyFilled]);
  useEffect(() => { if (!directColor && colors.length) setDirectColor(colors[0].color); else if (directColor && colors.length && !colors.some((item) => item.color === directColor)) setDirectColor(colors[0].color); }, [colors, directColor]);
  useEffect(() => { if (!directSize && sizes.length) setDirectSize(sizes[0]); else if (directSize && sizes.length && !sizes.includes(directSize)) setDirectSize(sizes[0]); }, [sizes, directSize]);
  const selectedStyleMatchesSearch = !search.trim() || `${selectedStyle?.styleNo ?? ""} ${selectedStyle?.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
  const totalQuantity = Object.values(quantities).reduce((sum, quantity) => sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0), 0);
  const activeWarehouses = warehouses.data?.filter((item) => item.active) ?? [];
  const selectedWarehouse = activeWarehouses.find((item) => item.id === warehouseId);
  const hasSkuRows = matrix.length > 0;
  const validLines = payload.lines.length > 0;
  const shortageRows = type === "OUTBOUND" ? (inventory.data ?? []).filter((sku) => (quantities[sku.id] ?? 0) > sku.available) : [];

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
    onSuccess: (result) => { setAiJobId(result.job_id); setAiReviewRows([]); setAiInvalidRows([]); setAiAcceptedRowIds([]); setAiApplyStatus("idle"); mergedJobId.current = null; notify("文件已进入 AI 解析队列"); },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "AI 文件上传失败"),
  });
  const aiFile = useRef<File | null>(null);
  const applyAi = useMutation({
    mutationFn: (jobId: string) => api<{ applied: number; documentId: string }>(`/imports/${jobId}/apply-to-draft`, { method: "POST", body: jsonBody({ documentId: draftId.current, acceptedRowIds: aiAcceptedRowIds }) }),
    onSuccess: (result) => { setAiApplyStatus("applied"); notify(`AI 识别结果已记录到草稿，共 ${result.applied} 行`); },
    onError: (reason) => { setAiApplyStatus("error"); setError(reason instanceof Error ? reason.message : "AI 识别结果记录失败"); },
  });

  useEffect(() => {
    const job = aiJob.data;
    if (!job || job.status !== "REVIEW" || mergedJobId.current === job.id || !job.rows) return;
    mergedJobId.current = job.id;
    const result = mergeRecognizedRows(quantities, job.rows);
    const invalidRows = job.rows.filter((row) => row.validationErrors.length > 0 || !row.skuId);
    setQuantities(result.quantities);
    setAiConflicts(result.conflicts);
    setAiReviewRows(result.reviewRows);
    setAiInvalidRows(invalidRows);
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
    setAiApplyStatus(invalidRows.length || result.conflicts.length || result.reviewRows.length ? "idle" : "pending");
    notify(result.conflicts.length ? "AI 识别完成，发现单元格冲突" : "AI 识别完成，结果已填入空白单元格");
  }, [aiJob.data, quantities]);

  useEffect(() => {
    if (!draftId.current || !pendingApplyJob.current || !aiAcceptedRowIds.length || applyAi.isPending || aiInvalidRows.length || aiConflicts.length || aiReviewRequired) return;
    const jobId = pendingApplyJob.current;
    pendingApplyJob.current = null;
    applyAi.mutate(jobId);
  }, [draftId.current, aiAcceptedRowIds, aiConflicts.length, aiInvalidRows.length, aiReviewRequired, applyAi.isPending]);

  const resetAiState = () => {
    setAiJobId(null);
    setAiAcceptedRowIds([]);
    setAiReviewRows([]);
    setAiInvalidRows([]);
    setAiConflicts([]);
    setAiReviewRequired(false);
    setAiApplyStatus("idle");
    mergedJobId.current = null;
    pendingApplyJob.current = null;
  };

  const updateQuantity = (skuId: string, value: string) => {
    const quantity = value === "" ? 0 : Number(value);
    setQuantities((current) => ({ ...current, [skuId]: Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : 0 }));
    setPreview(null);
    setStep("edit");
  };

  const fillOutboundMax = (skuId: string, available: number) => updateQuantity(skuId, String(Math.max(available, 0)));
  const fixAllShortages = () => {
    setQuantities((current) => ({ ...current, ...Object.fromEntries(shortageRows.map((sku) => [sku.id, Math.max(sku.available, 0)])) }));
    setPreview(null);
    setStep("edit");
  };

  const applyDirectEntry = () => {
    const quantity = Number(directQuantity);
    const sku = selectedSkus.find((item) => item.color === directColor && item.size === directSize);
    if (!sku || !Number.isInteger(quantity) || quantity < 0) return;
    setQuantities((current) => ({ ...current, [sku.id]: quantity }));
    setDirectQuantity("");
    setPreview(null);
    setStep("edit");
  };

  const bulkTargetSkus = (scope: "row" | "col" | "all"): InventoryRow[] => {
    if (scope === "row") return selectedSkus.filter((item) => item.size === directSize);
    if (scope === "col") return selectedSkus.filter((item) => item.color === directColor);
    return selectedSkus;
  };

  const bulkScopeCount = (scope: "row" | "col" | "all") => bulkTargetSkus(scope).length;

  const bulkPerCell = useMemo(() => {
    if (!bulkCartons.trim() && !bulkPerCarton.trim() && !bulkLoose.trim()) return null;
    const cartons = Number(bulkCartons);
    const perCarton = Number(bulkPerCarton);
    const loose = Number(bulkLoose);
    if (!Number.isInteger(cartons) || cartons < 0 || !Number.isInteger(perCarton) || perCarton < 0 || !Number.isInteger(loose) || loose < 0) return null;
    const perCell = cartons * perCarton + loose;
    return perCell > 0 ? perCell : null;
  }, [bulkCartons, bulkPerCarton, bulkLoose]);

  const applyBulkQuantity = (scope: "row" | "col" | "all", quantity: number) => {
    if (!Number.isInteger(quantity) || quantity < 0) return;
    const targets = bulkTargetSkus(scope);
    if (!targets.length) return;
    setQuantities((current) => {
      const next = { ...current };
      for (const sku of targets) next[sku.id] = quantity;
      return next;
    });
    setPreview(null);
    setStep("edit");
  };

  const applyBulkCartons = (scope: "row" | "col" | "all", cartons: number, perCarton: number, loose: number) => {
    if (!Number.isInteger(cartons) || cartons < 0 || !Number.isInteger(perCarton) || perCarton < 0 || !Number.isInteger(loose) || loose < 0) return;
    const perCell = cartons * perCarton + loose;
    if (perCell <= 0) return;
    applyBulkQuantity(scope, perCell);
  };

  const bulkFillFromCartons = (scope: "row" | "col" | "all") => {
    const cartons = Number(bulkCartons);
    const perCarton = Number(bulkPerCarton);
    const loose = Number(bulkLoose);
    if (!Number.isInteger(cartons) || cartons < 0 || !Number.isInteger(perCarton) || perCarton < 0 || !Number.isInteger(loose) || loose < 0) {
      notify("箱数、每箱件数、散件必须是非负整数", "error");
      return;
    }
    const perCell = cartons * perCarton + loose;
    if (perCell <= 0) {
      notify("箱数 × 每箱件数 + 散件 必须大于 0", "error");
      return;
    }
    const targets = bulkTargetSkus(scope);
    if (!targets.length) {
      notify("选定范围内没有可选规格", "error");
      return;
    }
    applyBulkQuantity(scope, perCell);
    notify(`已按箱装入库 ${targets.length} 个规格，每格 ${perCell} 件`);
  };

  const bulkFillFromQuantity = (scope: "row" | "col" | "all") => {
    const quantity = Number(bulkQuantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      notify("数量必须是非负整数", "error");
      return;
    }
    const targets = bulkTargetSkus(scope);
    if (!targets.length) {
      notify("选定范围内没有可选规格", "error");
      return;
    }
    applyBulkQuantity(scope, quantity);
    setBulkQuantity("");
    notify(`已填入 ${targets.length} 个规格，每格 ${quantity} 件`);
  };

  const clearBulkScope = (scope: "row" | "col" | "all") => {
    const targets = bulkTargetSkus(scope);
    if (!targets.length) return;
    setQuantities((current) => {
      const next = { ...current };
      for (const sku of targets) delete next[sku.id];
      return next;
    });
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

  const clearSkus = (skus: InventoryRow[]) => {
    setQuantities((current) => {
      const next = { ...current };
      for (const sku of skus) delete next[sku.id];
      return next;
    });
    setPreview(null);
    setStep("edit");
  };

  const moveMatrixFocus = (sizeIndex: number, colorIndex: number, key: string) => {
    const sizeStep = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    const colorStep = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!sizeStep && !colorStep) return;
    let nextSize = sizeIndex;
    let nextColor = colorIndex;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      nextSize += sizeStep;
      nextColor += colorStep;
      if (nextSize < 0 || nextSize >= sizes.length || nextColor < 0 || nextColor >= filteredColors.length) return;
      const sku = selectedSkus.find((item) => item.size === sizes[nextSize] && item.color === filteredColors[nextColor].color);
      if (sku) {
        window.requestAnimationFrame(() => matrixInputRefs.current[sku.id]?.focus());
        return;
      }
      if (sizeStep) nextColor = colorIndex;
      if (colorStep) nextSize = sizeIndex;
    }
  };

  const handleMatrixKeyDown = (event: KeyboardEvent<HTMLInputElement>, sizeIndex: number, colorIndex: number) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    moveMatrixFocus(sizeIndex, colorIndex, event.key);
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
          <div><p className="eyebrow">库存货单工作台</p><h1>{isEditing ? "编辑货单" : `新建${type === "INBOUND" ? "入库" : "出库"}单`}</h1><p>{step === "edit" ? type === "INBOUND" ? "录入到货数量或上传单据识别，预览无误后直接增加库存。" : "录入发货数量或上传订单识别，预览无误后直接扣减可用库存。" : "确认每一行的预计库存后提交，提交会立即写入库存流水。"}</p></div>
        </div>
        <div className="goods-order-stepper" aria-label="货单步骤"><span className={step === "edit" ? "active" : "done"}>01 编辑</span><i /><span className={step === "preview" ? "active" : ""}>02 预览并提交</span></div>
      </header>

      <section className="goods-order-meta">
        {!lockedType && <div className="goods-order-type" role="group" aria-label="货单类型">
          <button className={type === "INBOUND" ? "active inbound" : ""} onClick={() => { setType("INBOUND"); setPreview(null); }}><ArrowDownToLine size={16} />入库</button>
          <button className={type === "OUTBOUND" ? "active outbound" : ""} onClick={() => { setType("OUTBOUND"); setPreview(null); }}><ArrowUpFromLine size={16} />出库</button>
        </div>}
        <label>仓库<select aria-label="仓库" value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setPreview(null); }}><option value="">选择仓库</option>{activeWarehouses.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.code}</option>)}</select></label>
        <label>来源单号<input aria-label="来源单号" value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="可选" /></label>
        <label>往来方<input aria-label="往来方" value={counterparty} onChange={(event) => setCounterparty(event.target.value)} placeholder={type === "OUTBOUND" ? "客户或平台" : "供应商或往来单位"} /></label>
        <label className="goods-order-reason">备注<input aria-label="货单备注" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可选，写入审计记录" /></label>
      </section>

      {step === "edit" ? (
        <>
          <section className="goods-order-guide">
            <div><span>1</span><strong>{type === "INBOUND" ? "入库方向" : "出库方向"}</strong><small>{type === "INBOUND" ? "提交后增加对应 SKU 库存" : "提交后扣减对应 SKU 可用库存"}</small></div>
            <div className={selectedWarehouse ? "ready" : "blocked"}><span>2</span><strong>{selectedWarehouse ? selectedWarehouse.name : "选择仓库"}</strong><small>{selectedWarehouse ? selectedWarehouse.code : "没有启用仓库时不能建货单"}</small></div>
            <div className={totalQuantity > 0 ? "ready" : ""}><span>3</span><strong>{totalQuantity.toLocaleString()} 件</strong><small>填写矩阵、粘贴表格或使用 AI 识别</small></div>
          </section>
          <section className="goods-order-tools">
            <div className="goods-order-search"><input aria-label="搜索商品" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索款号或品名" /><span>{styleOptions.length} 个商品</span></div>
            <div className="goods-order-tool-actions"><label className="check-toggle"><input type="checkbox" checked={showOnlyFilled} onChange={(event) => setShowOnlyFilled(event.target.checked)} />仅看已填写颜色</label><button className="button" onClick={() => clearSkus(inventory.data ?? [])} disabled={!totalQuantity}><Trash2 size={15} />批量清空</button><button className="button" onClick={() => setPasteOpen((value) => !value)}><Clipboard size={15} />粘贴表格</button>{canUseAi && <label className="button ai-upload"><Sparkles size={15} />AI 识别<input type="file" accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => { aiFile.current = event.target.files?.[0] ?? null; if (aiFile.current) aiUpload.mutate(); }} /></label>}</div>
          </section>
          {pasteOpen && <section className="goods-order-paste"><div><strong>粘贴货单数据</strong><small>支持“款号/颜色/尺码/数量”明细，或左上角商品、首行尺码、首列颜色编号的矩阵。</small></div><textarea aria-label="粘贴货单数据" value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="保暖衬衫\tM\tL\tXL\n901\t225\t413\t535" /><div className="goods-order-paste-actions"><button className="button" onClick={() => setPasteText("")}>清空</button><button className="button primary" disabled={!pasteText.trim()} onClick={parsePaste}><Clipboard size={14} />解析并填入</button></div>{pasteErrors.length > 0 && <div className="error-banner"><AlertTriangle size={15} />{pasteErrors.join("；")}</div>}</section>}
          {aiJob.data && <section className={`goods-order-ai-status ${aiApplyStatus === "applied" ? "applied" : aiApplyStatus === "error" ? "failed" : ""}`}><Sparkles size={17} /><div><strong>{aiJob.data.status === "REVIEW" ? aiApplyStatus === "applied" ? "AI 识别已记录到草稿" : aiApplyStatus === "error" ? "AI 识别结果记录失败" : "AI 识别已完成" : aiJob.data.status === "FAILED" ? "AI 识别失败" : "AI 正在识别文件"}</strong><small>{aiJob.data.fileName} · {aiJob.data.status === "REVIEW" ? aiApplyStatus === "applied" ? `${aiAcceptedRowIds.length} 行已关联当前草稿` : aiApplyStatus === "pending" || applyAi.isPending ? `${aiJob.data.rows?.length ?? 0} 行已填入，正在记录草稿` : `${aiJob.data.rows?.length ?? 0} 行待确认` : `${aiJob.data.progress}%`}</small></div>{(["QUEUED", "PROCESSING"].includes(aiJob.data.status) || applyAi.isPending) && <LoaderCircle className="spin" size={17} />}</section>}
          {aiInvalidRows.length > 0 && <section className="goods-order-ai-errors"><AlertTriangle size={16} /><div><strong>{aiInvalidRows.length} 行无法自动填入</strong><small>不会创建新商品，请先在矩阵中人工修正或明确忽略。</small><ul>{aiInvalidRows.map((row) => <li key={row.id}>第 {row.rowNumber} 行：{row.validationErrors.join("；") || "SKU 不存在"}</li>)}</ul></div><button className="button" onClick={() => setAiInvalidRows([])}>忽略无效行</button></section>}
          {aiConflicts.length > 0 && <section className="goods-order-conflicts"><div><strong>AI 与手工输入存在冲突</strong><small>请选择每组冲突的处理方式，未选择前不能预览。</small><ul>{aiConflicts.map((conflict) => <li key={conflict.skuId}>{conflict.styleNo} / {conflict.color} / {conflict.size}：手工 {conflict.current}，AI {conflict.incoming}</li>)}</ul></div><div className="goods-order-conflict-actions"><button className="button" onClick={keepConflicts}>保留手工值</button><button className="button" onClick={acceptConflicts}>覆盖 {aiConflicts.length} 项</button></div></section>}
          {aiReviewRequired && <section className="goods-order-review"><AlertTriangle size={16} /><span>有 {aiReviewRows.length} 行识别置信度较低，请人工核对后再预览。</span><button className="button small" onClick={() => setAiReviewRequired(false)}>我已核对</button></section>}
          {shortageRows.length > 0 && <section className="goods-order-ai-errors"><AlertTriangle size={16} /><div><strong>{shortageRows.length} 个 SKU 出库数量超过可用库存</strong><small>{shortageRows.slice(0, 3).map((sku) => `${sku.style.styleNo}/${sku.color}/${sku.size} 可用 ${sku.available}`).join("；")}</small></div><button className="button" onClick={fixAllShortages}>一键改为最大可出</button></section>}
          <section className="goods-order-matrix-wrap">
            <div className="goods-order-matrix-head"><div><strong>货单明细</strong><span>{totalQuantity.toLocaleString()} 件 · 选择商品后填写颜色尺码矩阵</span></div><div className="goods-order-matrix-head-actions"><select aria-label="选择商品" value={selectedStyle?.key ?? ""} onChange={(event) => setSelectedStyleKey(event.target.value)}><option value="">选择商品</option>{styleOptions.filter((item) => !search.trim() || `${item.styleNo} ${item.name}`.toLowerCase().includes(search.trim().toLowerCase())).map((item) => <option key={item.key} value={item.key}>{item.styleNo} · {item.name}</option>)}</select><button className="button small" disabled={!selectedSkus.length} onClick={() => clearSkus(selectedSkus)}><Trash2 size={14} />清空当前商品</button><span className="save-indicator">{saveState === "saving" || save.isPending ? <><LoaderCircle className="spin" size={14} />保存中</> : saveState === "clean" ? <><Check size={14} />已保存</> : saveState === "error" ? <><AlertTriangle size={14} />保存失败</> : <><Save size={14} />待保存</>}</span></div></div>
            <div className="direct-entry-bar"><label>颜色<select value={directColor} onChange={(event) => setDirectColor(event.target.value)}>{colors.map((item) => <option key={item.color} value={item.color}>{item.code ? `${item.code}-${item.color}` : item.color}</option>)}</select></label><label>尺码<select value={directSize} onChange={(event) => setDirectSize(event.target.value)}>{sizes.map((size) => <option key={size} value={size}>{size}</option>)}</select></label><label>数量<input type="number" min="0" inputMode="numeric" value={directQuantity} onChange={(event) => setDirectQuantity(event.target.value)} placeholder="0" /></label><button className="button" disabled={!selectedSkus.some((item) => item.color === directColor && item.size === directSize) || !Number.isInteger(Number(directQuantity)) || Number(directQuantity) < 0} onClick={applyDirectEntry}>填入</button></div>
            <div className="bulk-entry-bar"><label>范围<select aria-label="批量填充范围" value={bulkScope} onChange={(event) => setBulkScope(event.target.value as "row" | "col" | "all")}><option value="row">当前尺码 {directSize || "—"} 整行</option><option value="col">当前颜色 {directColor ? `${directColor} 整列` : "整列"}</option><option value="all">当前商品全部</option></select></label><label>箱数<input type="number" min="0" inputMode="numeric" aria-label="箱数" value={bulkCartons} onChange={(event) => setBulkCartons(event.target.value)} placeholder="5" /></label><label>每箱件数<input type="number" min="0" inputMode="numeric" aria-label="每箱件数" value={bulkPerCarton} onChange={(event) => setBulkPerCarton(event.target.value)} placeholder="40" /></label><label>散件<input type="number" min="0" inputMode="numeric" aria-label="散件" value={bulkLoose} onChange={(event) => setBulkLoose(event.target.value)} placeholder="0" /></label><span className="bulk-cell-preview">每格 {bulkPerCell ?? "—"} 件 · {bulkScopeCount(bulkScope)} 格</span><button className="button" disabled={!selectedSkus.length || bulkPerCell === null || bulkScopeCount(bulkScope) === 0} onClick={() => bulkFillFromCartons(bulkScope)}><Boxes size={14} />按箱装入库</button><i className="bulk-divider" /><label>每格数量<input type="number" min="0" inputMode="numeric" aria-label="每格数量" value={bulkQuantity} onChange={(event) => setBulkQuantity(event.target.value)} placeholder="200" /></label><button className="button" disabled={!selectedSkus.length || !Number.isInteger(Number(bulkQuantity)) || Number(bulkQuantity) < 0 || bulkScopeCount(bulkScope) === 0} onClick={() => bulkFillFromQuantity(bulkScope)}>填入选定范围</button><button className="button danger-text" disabled={!selectedSkus.length || bulkScopeCount(bulkScope) === 0} onClick={() => clearBulkScope(bulkScope)}><Trash2 size={14} />清空范围</button></div>
            <div className="goods-order-matrix-scroll">{selectedStyle && selectedStyleMatchesSearch && filteredColors.length ? <table className="goods-order-matrix style-entry-matrix"><thead><tr><th className="sticky-col size-col">尺码</th>{filteredColors.map((item, index) => <th key={item.color}><i className={`swatch swatch-${index % 4}`} />{item.code ? `${item.code}-${item.color}` : item.color}</th>)}</tr></thead><tbody>{sizes.map((size, sizeIndex) => <tr key={size}><th className="sticky-col size-col">{size}</th>{filteredColors.map((colorItem, colorIndex) => { const sku = selectedSkus.find((item) => item.size === size && item.color === colorItem.color); const quantity = sku ? quantities[sku.id] ?? 0 : 0; const delta = type === "INBOUND" ? quantity : -quantity; const short = Boolean(sku && type === "OUTBOUND" && quantity > sku.available); return <td key={colorItem.color} className={short ? "shortage" : ""}>{sku ? <><input ref={(element) => { matrixInputRefs.current[sku.id] = element; }} aria-label={`${selectedStyle.styleNo} ${colorItem.color} ${size} 数量`} title={`当前库存 ${sku.onHand}，可用 ${sku.available}，预计变更 ${delta > 0 ? "+" : ""}${delta}`} type="number" min="0" inputMode="numeric" value={quantity || ""} onKeyDown={(event) => handleMatrixKeyDown(event, sizeIndex, colorIndex)} onChange={(event) => updateQuantity(sku.id, event.target.value)} /><small className="matrix-cell-meta">库 {sku.onHand} · 可 {sku.available}{quantity > 0 ? ` · 变 ${delta > 0 ? "+" : ""}${delta}` : ""}</small>{short && <button className="matrix-max-button" type="button" onClick={() => fillOutboundMax(sku.id, sku.available)}>最大 {sku.available}</button>}</> : <span className="matrix-empty">—</span>}</td>; })}</tr>)}</tbody></table> : <GoodsOrderEmptyState hasWarehouse={Boolean(selectedWarehouse)} hasSkuRows={hasSkuRows} showOnlyFilled={showOnlyFilled} search={search} onClearFilter={() => { setSearch(""); setShowOnlyFilled(false); }} />}</div>
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

function GoodsOrderEmptyState({ hasWarehouse, hasSkuRows, showOnlyFilled, search, onClearFilter }: { hasWarehouse: boolean; hasSkuRows: boolean; showOnlyFilled: boolean; search: string; onClearFilter: () => void }) {
  if (!hasWarehouse) return <div className="goods-order-empty"><Boxes size={20} /><strong>还没有可用仓库</strong><span>先在系统里启用一个仓库，再回来新建入库或出库单。</span><Link className="button primary" to="/settings">去设置检查仓库</Link></div>;
  if (!hasSkuRows) return <div className="goods-order-empty"><Shirt size={20} /><strong>还没有可选商品规格</strong><span>先创建款式和颜色尺码 SKU，表单会自动生成颜色和尺码矩阵。</span><Link className="button primary" to="/catalog"><Plus size={15} />新建款式 SKU</Link></div>;
  return <div className="goods-order-empty"><FileSpreadsheet size={20} /><strong>{showOnlyFilled || search.trim() ? "当前筛选没有商品" : "没有匹配的商品"}</strong><span>{showOnlyFilled ? "关闭“仅看已填写颜色”或清空搜索词后再录入。" : "换一个搜索词，或从商品页确认 SKU 是否启用。"}</span><button className="button" onClick={onClearFilter}>清除筛选</button></div>;
}

function PreviewPanel({ preview, onBack, onCommit, pending, error }: { preview: PreviewResult | null; onBack: () => void; onCommit: () => void; pending: boolean; error: string | null }) {
  if (!preview) return <div className="goods-order-empty"><AlertTriangle size={22} /><strong>预览已失效</strong><button className="button" onClick={onBack}><RotateCcw size={15} />重新编辑</button></div>;
  const errorRows = preview.rows.filter((row) => row.errors.length > 0);
  const warningRows = preview.rows.filter((row) => !row.errors.length && row.warnings.length > 0);
  return <>
    <section className="goods-order-preview-summary"><div><p className="eyebrow">预览快照 · {new Date(preview.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</p><h2>{preview.type === "INBOUND" ? "入库预览" : "出库预览"}</h2><p>{preview.warehouse.name} · 共 {preview.totals.quantity.toLocaleString()} 件 · 预计库存 {preview.totals.delta > 0 ? "+" : ""}{preview.totals.delta.toLocaleString()} 件</p></div><span className={`preview-verdict ${preview.valid ? "valid" : "invalid"}`}>{preview.valid ? <><Check size={16} />可以提交</> : <><AlertTriangle size={16} />存在库存问题</>}</span></section>
    {(errorRows.length > 0 || warningRows.length > 0) && <section className={`goods-order-preview-issues ${errorRows.length ? "invalid" : "warning"}`}><AlertTriangle size={17} /><div><strong>{errorRows.length ? `${errorRows.length} 行必须返回编辑后修正` : `${warningRows.length} 行需要提交前复核`}</strong><small>{errorRows[0]?.errors.join("；") || warningRows[0]?.warnings.join("；")}</small></div></section>}
    <section className="goods-order-preview-table"><table><thead><tr><th>款号 / SKU</th><th>颜色 / 尺码</th><th>当前库存</th><th>变更</th><th>预计库存</th><th>校验</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={`${row.skuId}-${row.stockStatus}`}><td><strong>{row.styleNo}</strong><small>{row.skuCode}</small></td><td>{row.color} / {row.size}</td><td>{row.currentOnHand} <small>可用 {row.available}</small></td><td className={row.delta < 0 ? "negative" : "positive"}>{row.delta > 0 ? "+" : ""}{row.delta}</td><td className="strong-number">{row.projectedOnHand}</td><td>{row.errors.length ? <span className="alert-label"><AlertTriangle size={14} />{row.errors.join("；")}</span> : row.warnings.length ? <span className="warning-label"><AlertTriangle size={14} />{row.warnings.join("；")}</span> : <span className="ok-label"><Check size={14} />通过</span>}</td></tr>)}</tbody></table></section>
    {error && <div className="error-banner"><AlertTriangle size={15} />{error}</div>}
    <div className="goods-order-footer"><button className="button" onClick={onBack}><ArrowLeft size={15} />返回编辑</button><button className="button primary" disabled={!preview.valid || pending} onClick={onCommit}>{pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending ? "正在提交" : `确认提交${preview.type === "INBOUND" ? "入库" : "出库"}`}</button></div>
  </>;
}
