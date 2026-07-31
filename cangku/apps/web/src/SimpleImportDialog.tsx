import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, FileSpreadsheet, Upload, X } from "lucide-react";
import { api } from "./api";
import type { SimpleImportPreview } from "./types";

export function SimpleImportDialog({
  kind,
  onClose,
  onConfirmed,
}: {
  kind: "INBOUND" | "OUTBOUND";
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SimpleImportPreview | null>(null);
  const upload = useMutation({
    mutationFn: async () => {
      const body = new FormData();
      body.set("kind", kind);
      body.set("file", file!);
      return api<SimpleImportPreview>("/simple-imports/preview", { method: "POST", body });
    },
    onSuccess: setPreview,
  });
  const confirm = useMutation({
    mutationFn: () => api(`/simple-imports/${preview!.id}/confirm`, { method: "POST" }),
    onSuccess: () => {
      window.dispatchEvent(new CustomEvent("cangku:toast", { detail: { message: kind === "INBOUND" ? "库存已整批增加" : "出库登记已导入", tone: "success" } }));
      onConfirmed();
      onClose();
    },
  });
  const error = upload.error ?? confirm.error;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="simple-import-title">
        <header>
          <div>
            <p className="eyebrow">固定模板导入</p>
            <h2 id="simple-import-title">{kind === "INBOUND" ? "导入并增加库存" : "导入今日出库"}</h2>
            <p>按款号、颜色、尺码匹配商品；确认前不会修改库存。</p>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={19} /></button>
        </header>
        <div className="modal-body simple-import-body">
          {!preview ? (
            <div className="simple-import-start">
              <div className="template-strip">
                <FileSpreadsheet size={22} />
                <div><strong>款号、颜色、尺码、数量</strong><span>备注列可选；相同规格会自动合并。</span></div>
                <button className="button" type="button" onClick={() => window.location.assign(`/api/v1/simple-imports/template?kind=${kind}`)}><Download size={15} />下载模板</button>
              </div>
              <label className={`file-drop ${file ? "has-file" : ""}`}>
                <input aria-label="选择导入文件" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                <Upload size={22} />
                <span>{file?.name ?? "选择 Excel 或 CSV 文件"}</span>
                <small>单文件不超过 5 MB，最多 10,000 行</small>
              </label>
              {error && <div className="error-banner"><AlertTriangle size={16} />{error instanceof Error ? error.message : "解析失败"}</div>}
              <div className="modal-actions">
                <button className="button" type="button" onClick={onClose}>取消</button>
                <button className="button primary" type="button" disabled={!file || upload.isPending} onClick={() => upload.mutate()}><Upload size={15} />{upload.isPending ? "正在解析" : "预览数据"}</button>
              </div>
            </div>
          ) : (
            <>
              <div className={`import-verdict ${preview.valid ? "valid" : "invalid"}`}>
                {preview.valid ? <Check size={18} /> : <AlertTriangle size={18} />}
                <strong>{preview.valid ? `已匹配 ${preview.rows.length} 个商品规格` : "存在未通过的数据，请修正文件后重新上传"}</strong>
                <span>{preview.fileName}</span>
              </div>
              <div className="review-table simple-review-table">
                <table>
                  <thead><tr><th>来源行</th><th>款号</th><th>颜色</th><th>尺码</th><th>数量</th><th>匹配结果</th></tr></thead>
                  <tbody>{preview.rows.map((row) => (
                    <tr key={`${row.styleNo}-${row.color}-${row.size}`} className={row.error ? "invalid" : ""}>
                      <td className="mono">{row.sourceRows.join(", ")}</td><td><strong>{row.styleNo || "-"}</strong></td><td>{row.color || "-"}</td><td>{row.size || "-"}</td><td className="number strong">{Number.isFinite(row.quantity) ? row.quantity : "-"}</td>
                      <td>{row.error ? <span className="alert-label"><AlertTriangle size={13} />{row.error}</span> : <span className="ok-label"><Check size={13} />{row.skuCode}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {error && <div className="error-banner"><AlertTriangle size={16} />{error instanceof Error ? error.message : "确认失败"}</div>}
              <div className="modal-actions">
                <button className="button" type="button" onClick={() => { setPreview(null); setFile(null); }}>重新选择</button>
                <button className="button primary" type="button" disabled={!preview.valid || confirm.isPending} onClick={() => confirm.mutate()}><Check size={15} />{confirm.isPending ? "正在确认" : kind === "INBOUND" ? "确认并立即入库" : "确认导入登记"}</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
