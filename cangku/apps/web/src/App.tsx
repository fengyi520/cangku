import { ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Boxes,
  Check,
  ChevronDown,
  Clock3,
  ClipboardCheck,
  ClipboardList,
  Download,
  FileClock,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, downloadExport, jsonBody } from "./api";
import { GoodsOrderEditorPage } from "./GoodsOrderEditorPage";
import { colorSlot, signed, splitList } from "./domain";
import { SimpleImportDialog } from "./SimpleImportDialog";
import type { AiModelSettings, Approval, AuditEvent, AutomationSettings, ExportJob, ImportJob, InventoryRow, Notification, Role, Sku, StockDocument, StockStatus, Style, User } from "./types";
import { STOCK_STATUS_LABELS } from "./types";

const typeLabels: Record<string, string> = {
  INBOUND: "入库",
  OUTBOUND: "出库",
  RETURN: "退货",
  STOCKTAKE: "盘点",
  ADJUSTMENT: "库存调整",
};

const statusLabels: Record<string, string> = {
  DRAFT: "草稿",
  PENDING_APPROVAL: "待审批",
  CONFIRMED: "已确认",
  RESERVED: "已预留",
  POSTED: "已过账",
  CANCELLED: "已取消",
  REVERSED: "已冲销",
  QUEUED: "排队中",
  PROCESSING: "处理中",
  REVIEW: "待确认",
  COMPLETED: "已完成",
  FAILED: "失败",
  PENDING: "待审批",
  APPROVED: "已通过",
  REJECTED: "已驳回",
};

function emitToast(message: string, tone: "success" | "error" = "success") {
  window.dispatchEvent(new CustomEvent("cangku:toast", { detail: { message, tone } }));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function colorCodeFromSkuCode(skuCode: string) {
  const parts = skuCode.split("-").map((part) => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 2] : parts[0] || "COLOR";
}

function can(user: User, permission: string) {
  if (user.role.permissions.includes("*") || user.role.permissions.includes(permission)) return true;
  const [resource, action] = permission.split(".");
  return action === "view" && user.role.permissions.includes(`${resource}.manage`);
}

const permissionOptions = [
  ["dashboard.view", "查看总览"], ["catalog.view", "查看商品"], ["catalog.manage", "管理商品"], ["inventory.view", "查看库存"], ["documents.view", "查看单据"], ["documents.manage", "管理单据"],
  ["imports.manage", "导入资料"], ["exports.manage", "导出报表"], ["approvals.view", "查看审批"], ["approvals.decide", "审批处理"], ["audit.view", "查看审计"], ["members.manage", "成员角色管理"], ["settings.manage", "系统设置"],
] as const;

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<{ user: User }>("/auth/me"), retry: false });
  if (me.isLoading) return <AppLoading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
  if (!me.data) return <FatalState message={errorText(me.error)} onRetry={() => me.refetch()} />;
  return (
    <ToastHost>
      <AppShell user={me.data.user} />
    </ToastHost>
  );
}

function AppLoading() {
  return (
    <div className="boot-screen">
      <div className="brand-mark"><Boxes size={24} /></div>
      <div className="boot-line" />
      <span>正在连接仓库账本</span>
    </div>
  );
}

function LoginPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api("/auth/login", { method: "POST", body: jsonBody({ email, password }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <main className="login-page">
      <section className="login-identity">
        <div className="brand-lockup"><span className="brand-mark"><Boxes size={25} /></span><span>云裳仓库</span></div>
        <div className="login-matrix" aria-hidden="true">
          {["S", "M", "L", "XL"].map((size, column) => (
            <div key={size} className="login-matrix-column">
              <span>{size}</span>
              {[62, 84, 41, 97].map((value, row) => <b key={row} style={{ opacity: 0.3 + ((value + column * 13 + row * 7) % 60) / 100 }}>{value + column * 3 - row}</b>)}
            </div>
          ))}
        </div>
        <div className="login-copy">
          <p className="eyebrow">单仓协作系统</p>
          <h1>每一件库存，<br />都有清楚来路。</h1>
          <p>款色尺码、收发盘退、审批审计与 AI 文件处理都回到同一本库存账。</p>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={(event) => { event.preventDefault(); login.mutate(); }}>
          <div>
            <p className="eyebrow">安全登录</p>
            <h2>进入主仓</h2>
          </div>
          <label>登录邮箱<input aria-label="登录邮箱" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
          <label>密码<input aria-label="密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {login.error && <ErrorBanner>{errorText(login.error)}</ErrorBanner>}
          <button className="button primary wide" disabled={login.isPending}><LogIn size={17} />{login.isPending ? "正在验证" : "登录系统"}</button>
          <p className="form-footnote">连续登录失败会触发请求限流。登录后所有库存操作都会写入审计记录。</p>
        </form>
      </section>
    </main>
  );
}

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; permission: string };

const navItems: NavItem[] = [
  { to: "/", label: "总览", icon: LayoutDashboard, permission: "dashboard.view" },
  { to: "/inventory", label: "库存", icon: Boxes, permission: "inventory.view" },
  { to: "/catalog", label: "商品", icon: Shirt, permission: "catalog.view" },
  { to: "/documents/new", label: "新建表单", icon: FileSpreadsheet, permission: "documents.manage" },
  { to: "/daily-outbound", label: "今日出库", icon: Clock3, permission: "documents.manage" },
  { to: "/imports", label: "AI 导入", icon: Sparkles, permission: "imports.manage" },
  { to: "/ai-chat", label: "AI 助手", icon: Sparkles, permission: "inventory.view" },
  { to: "/reports", label: "报表", icon: FileSpreadsheet, permission: "reports.export" },
  { to: "/approvals", label: "审批", icon: ShieldCheck, permission: "approvals.view" },
  { to: "/audit", label: "审计", icon: History, permission: "audit.view" },
  { to: "/members", label: "成员", icon: Users, permission: "members.manage" },
  { to: "/settings", label: "设置", icon: Settings, permission: "settings.manage" },
];

function AppShell({ user }: { user: User }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const notifications = useQuery({ queryKey: ["notifications"], queryFn: () => api<Notification[]>("/notifications"), refetchInterval: 30_000 });
  const unread = notifications.data?.filter((item) => !item.readAt).length ?? 0;
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => { queryClient.clear(); navigate("/"); window.location.reload(); },
  });
  const visibleNav = navItems.filter((item) => can(user, item.permission));

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand-lockup sidebar-brand"><span className="brand-mark"><Boxes size={21} /></span><span>云裳仓库</span></div>
        <div className="warehouse-chip"><span className="status-dot" />主仓在线</div>
        <nav aria-label="主导航">
          {visibleNav.map((item) => {
            const active = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return <Link key={item.to} to={item.to} className={active ? "active" : ""} onClick={() => setMenuOpen(false)}><item.icon size={18} /><span>{item.label}</span></Link>;
          })}
        </nav>
        <div className="sidebar-user">
          <span className="avatar">{user.name.slice(0, 1)}</span>
          <span><strong>{user.name}</strong><small>{user.role.name}</small></span>
          <button className="icon-button" title="退出登录" onClick={() => logout.mutate()}><LogOut size={17} /></button>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}
      <section className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" aria-label="打开菜单" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumb">主仓 <span>/</span> {visibleNav.find((item) => item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to))?.label ?? "工作台"}</div>
          <div className="topbar-actions">
            <time>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</time>
            <button className="icon-button notification-button" aria-label={`通知 ${unread} 条未读`} onClick={() => setNotificationsOpen((value) => !value)}><Bell size={19} />{unread > 0 && <b>{unread > 9 ? "9+" : unread}</b>}</button>
          </div>
        </header>
        <main className="page-canvas">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/catalog" element={<CatalogPage user={user} />} />
            <Route path="/daily-outbound" element={<GoodsOrderEditorPage canUseAi={can(user, "imports.manage")} defaultType="OUTBOUND" lockedType />} />
            <Route path="/documents/new" element={<GoodsOrderEditorPage canUseAi={can(user, "imports.manage")} />} />
            <Route path="/documents/:id/edit" element={<GoodsOrderEditorPage canUseAi={can(user, "imports.manage")} />} />
            <Route path="/documents/:type" element={<DocumentsPage user={user} />} />
            <Route path="/imports" element={<ImportsPage />} />
            <Route path="/ai-chat" element={<AiChatPage user={user} />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/members" element={<MembersPage user={user} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </section>
      <nav className="mobile-nav" aria-label="移动端主导航">
        {visibleNav.filter((item) => ["/", "/inventory", "/documents/new", "/daily-outbound", "/imports"].includes(item.to)).map((item) => {
          const active = item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
          return <Link key={item.to} to={item.to} className={active ? "active" : ""}><item.icon size={19} /><span>{item.label.replace("AI ", "")}</span></Link>;
        })}
      </nav>
      {notificationsOpen && <NotificationDrawer items={notifications.data ?? []} onClose={() => setNotificationsOpen(false)} />}
    </div>
  );
}

function NotificationDrawer({ items, onClose }: { items: Notification[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mark = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: "POST" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }) });
  return (
    <aside className="notification-drawer">
      <div className="drawer-header"><div><p className="eyebrow">协作动态</p><h2>通知</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
      <div className="notification-list">
        {items.length === 0 ? <EmptyState icon={<Bell />} title="暂无通知" description="审批、AI任务和库存预警会出现在这里。" /> : items.map((item) => (
          <button key={item.id} className={`notification-item ${item.readAt ? "read" : ""}`} onClick={() => !item.readAt && mark.mutate(item.id)}>
            <span className="notification-dot" /><span><strong>{item.title}</strong><small>{item.message}</small><time>{formatDate(item.createdAt)}</time></span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function DashboardPage() {
  const [lowStockOpen, setLowStockOpen] = useState(false);
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: () => api<any>("/dashboard") });
  const inventory = useQuery({ queryKey: ["inventory", ""], queryFn: () => api<InventoryRow[]>("/inventory/balances") });
  if (dashboard.isLoading || inventory.isLoading) return <PageLoading />;
  if (!dashboard.data) return <FatalState message={errorText(dashboard.error)} onRetry={() => dashboard.refetch()} />;
  const metrics = dashboard.data.metrics;
  const lowStockRows = (inventory.data ?? []).filter((row) => row.lowStock).sort((left, right) => left.available - right.available || left.style.styleNo.localeCompare(right.style.styleNo));
  return (
    <>
      <PageHeader eyebrow="今日仓况" title="库存总览" description={`${dashboard.data.warehouse.name}的实时可用量、预警和待处理事项。`} />
      <section className="metric-strip">
        <Metric label="可用库存" value={metrics.available.toLocaleString()} unit="件" tone="ink" />
        <Metric label="在库总量" value={metrics.onHand.toLocaleString()} unit="件" />
        <Metric label="已预留" value={metrics.reserved.toLocaleString()} unit="件" />
        <Metric label="可售" value={metrics.sellable.toLocaleString()} unit="件" tone="ok" />
        <Metric label="待检" value={metrics.inspection.toLocaleString()} unit="件" tone={metrics.inspection ? "warn" : "ink"} />
        <Metric label="残次" value={metrics.damaged.toLocaleString()} unit="件" tone={metrics.damaged ? "danger" : "ink"} />
        <Metric label="低库存 SKU" value={metrics.lowStock.toLocaleString()} unit="项" tone={metrics.lowStock ? "warn" : "ok"} onClick={() => setLowStockOpen(true)} />
        <Metric label="待审批" value={metrics.pendingApprovals.toLocaleString()} unit="单" tone={metrics.pendingApprovals ? "danger" : "ok"} />
      </section>
      <section className="dashboard-grid">
        <div className="section-block matrix-block">
          <SectionHeading title="各商品库存情况" meta="按商品汇总可用库存" action={<Link className="text-link" to="/inventory">查看全部</Link>} />
          <ProductStockSummary rows={inventory.data ?? []} />
        </div>
        <div className="section-block activity-block">
          <SectionHeading title="最近单据" meta="按更新时间" />
          <div className="activity-list">
            {dashboard.data.recentDocuments.map((document: any) => (
              <Link to={`/documents/${document.type}`} key={document.id} className="activity-row">
                <span className={`document-icon ${document.type.toLowerCase()}`}>{document.type === "INBOUND" ? <ArrowDownToLine size={17} /> : document.type === "OUTBOUND" ? <ArrowUpFromLine size={17} /> : <ClipboardList size={17} />}</span>
                <span><strong>{document.documentNo}</strong><small>{typeLabels[document.type]} · {document._count.lines} 行 · {document.createdBy.name}</small></span>
                <StatusBadge status={document.status} />
              </Link>
            ))}
          </div>
        </div>
      </section>
      {lowStockOpen && <LowStockModal rows={lowStockRows} onClose={() => setLowStockOpen(false)} />}
    </>
  );
}

function ProductStockSummary({ rows }: { rows: InventoryRow[] }) {
  if (!rows.length) return <EmptyState icon={<Boxes />} title="还没有库存" description="先创建商品并完成一张入库单。" />;
  const groups = new Map<string, { styleNo: string; name: string; skuCount: number; available: number; onHand: number; reserved: number; lowCount: number }>();
  for (const row of rows) {
    const current = groups.get(row.style.id) ?? { styleNo: row.style.styleNo, name: row.style.name, skuCount: 0, available: 0, onHand: 0, reserved: 0, lowCount: 0 };
    current.skuCount += 1;
    current.available += row.available;
    current.onHand += row.onHand;
    current.reserved += row.reserved;
    if (row.lowStock) current.lowCount += 1;
    groups.set(row.style.id, current);
  }
  return <div className="product-stock-list">{[...groups.values()].sort((left, right) => right.available - left.available).map((item) => <Link className="product-stock-card" to={`/inventory?search=${encodeURIComponent(item.styleNo)}`} key={item.styleNo}><span><strong>{item.styleNo}</strong><small>{item.name}</small></span><b>{item.available.toLocaleString()}<small>可用</small></b><em>{item.skuCount} SKU · 在库 {item.onHand.toLocaleString()} · 预留 {item.reserved.toLocaleString()}{item.lowCount ? ` · ${item.lowCount} 项低库存` : ""}</em></Link>)}</div>;
}

function LowStockModal({ rows, onClose }: { rows: InventoryRow[]; onClose: () => void }) {
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);
  return <Modal title="低库存提醒" subtitle="这些 SKU 的可用库存已低于商品页设置的库存预警值" onClose={onClose} wide>{!rows.length ? <EmptyState icon={<Check />} title="暂无低库存" description="所有商品都高于当前预警值。" /> : <><div className="modal-toolbar"><Link className="button primary" to="/documents/new?type=INBOUND" onClick={onClose}><Plus size={15} />新建入库补货单</Link><Link className="button" to="/reports" onClick={onClose}><Download size={15} />导出预警表</Link></div><DataTable headers={["商品", "颜色 / 尺码", "SKU", "状态构成", "可用", "预警值", "操作"]}>{rows.map((row) => <tr key={row.id}><td><strong>{row.style.styleNo}</strong><small>{row.style.name}</small></td><td>{row.color} / {row.size}</td><td className="mono">{row.skuCode}</td><td><StockBreakdown balances={row.balances} /></td><td className="number negative">{row.available}</td><td className="number">{row.minStock}</td><td><button className="button small" onClick={() => setAdjusting(row)}><SlidersHorizontal size={14} />调整</button></td></tr>)}</DataTable></>}{adjusting && <QuickAdjustModal row={adjusting} onClose={() => setAdjusting(null)} />}</Modal>;
}

function StockBreakdown({ balances }: { balances: InventoryRow["balances"] }) {
  const items = (["SELLABLE", "INSPECTION", "DAMAGED"] as StockStatus[]).map((status) => ({ status, onHand: balances.find((item) => item.status === status)?.onHand ?? 0 }));
  if (!items.some((item) => item.onHand > 0)) return <span className="muted">—</span>;
  return <span className="stock-breakdown">{items.filter((item) => item.onHand > 0).map((item) => <span key={item.status} className={`stock-breakdown-item ${item.status.toLowerCase()}`}><i className={`stock-state ${item.status.toLowerCase()}`} />{STOCK_STATUS_LABELS[item.status]} {item.onHand}</span>)}</span>;
}

function QuickAdjustModal({ row, onClose }: { row: InventoryRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StockStatus>("SELLABLE");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const current = row.balances.find((item) => item.status === status);
  const targetNumber = Number(target);
  const adjust = useMutation({
    mutationFn: () => api("/inventory/quick-adjust", { method: "POST", body: jsonBody({ lines: [{ skuId: row.id, stockStatus: status, targetOnHand: Math.floor(targetNumber), note: note.trim() || null }], reason: note.trim() || "低库存快捷调整" }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["goods-order-inventory"] });
      emitToast("库存已调整，生成已过账调整单");
      onClose();
    },
    onError: (error) => emitToast(errorText(error), "error"),
  });
  const submit = () => {
    if (!Number.isInteger(targetNumber) || targetNumber < 0) return;
    adjust.mutate();
  };
  return <Modal title="快捷调整库存" subtitle={`${row.style.styleNo} · ${row.color} / ${row.size} · ${row.skuCode}`} onClose={onClose}>
    <label>调整状态<select aria-label="调整状态" value={status} onChange={(event) => setStatus(event.target.value as StockStatus)}>{(["SELLABLE", "INSPECTION", "DAMAGED"] as StockStatus[]).map((item) => <option key={item} value={item}>{STOCK_STATUS_LABELS[item]}{current ? `（当前 ${current.onHand} 件）` : ""}</option>)}</select></label>
    <label>调整为<input aria-label="调整后数量" type="number" min="0" inputMode="numeric" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={String(current?.onHand ?? 0)} /></label>
    <p className="form-footnote">调整后数量是目标值，差异会立即写入库存流水并生成一张已过账的库存调整单（TZ 单号）。</p>
    <label>原因<input aria-label="调整原因" value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选，写入审计与单据备注" /></label>
    <div className="modal-actions"><button className="button" onClick={onClose}>取消</button><button className="button primary" disabled={!Number.isInteger(targetNumber) || targetNumber < 0 || adjust.isPending} onClick={submit}>{adjust.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}确认调整</button></div>
  </Modal>;
}

function QuickAdjustButton({ row }: { row: InventoryRow }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="button small" onClick={() => setOpen(true)}><SlidersHorizontal size={14} />调整</button>
    {open && <QuickAdjustModal row={row} onClose={() => setOpen(false)} />}
  </>;
}

function InventoryMatrix({ rows }: { rows: InventoryRow[] }) {
  const firstStyleId = rows[0]?.style.id;
  const selected = rows.filter((row) => row.style.id === firstStyleId);
  if (!selected.length) return <EmptyState icon={<Boxes />} title="还没有库存" description="先创建商品并完成一张入库单。" />;
  const colors = [...new Set(selected.map((row) => row.color))];
  const sizes = [...new Set(selected.map((row) => row.size))];
  const first = selected[0];
  return (
    <div className="matrix-wrap">
      <div className="matrix-title"><span>{first.style.styleNo}</span><strong>{first.style.name}</strong></div>
      <div className="stock-matrix" style={{ gridTemplateColumns: `minmax(92px, 1.2fr) repeat(${sizes.length}, minmax(58px, .7fr))` }}>
        <span className="matrix-corner">颜色 / 尺码</span>
        {sizes.map((size) => <span className="matrix-size" key={size}>{size}</span>)}
        {colors.flatMap((color) => [
          <span className="matrix-color" key={`${color}-label`}><i className={`swatch swatch-${colors.indexOf(color)}`} />{color}</span>,
          ...sizes.map((size) => {
            const item = selected.find((row) => row.color === color && row.size === size);
            const value = item?.available ?? 0;
            return <span key={`${color}-${size}`} className={`matrix-cell ${item?.lowStock ? "low" : value > 80 ? "full" : ""}`}><strong>{value}</strong><small>件</small></span>;
          }),
        ])}
      </div>
    </div>
  );
}

function InventoryPage() {
  const initialSearch = new URLSearchParams(useLocation().search).get("search") ?? "";
  const [search, setSearch] = useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = useState(initialSearch);
  const [view, setView] = useState<"balance" | "ledger">("balance");
  const inventory = useQuery({ queryKey: ["inventory", appliedSearch], queryFn: () => api<InventoryRow[]>(`/inventory/balances${appliedSearch ? `?search=${encodeURIComponent(appliedSearch)}` : ""}`) });
  const ledger = useQuery({ queryKey: ["ledger"], queryFn: () => api<any[]>("/inventory/ledger"), enabled: view === "ledger" });
  return (
    <>
      <PageHeader eyebrow="实时账本" title="库存" description="按款号、SKU、颜色和尺码查询主仓现存量。" />
      <Toolbar>
        <form className="search-box" onSubmit={(event) => { event.preventDefault(); setAppliedSearch(search); }}><Search size={17} /><input aria-label="搜索库存" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索款号、品名或 SKU" /><button className="icon-button" aria-label="搜索"><Search size={16} /></button></form>
        <Segmented value={view} options={[{ value: "balance", label: "库存余额" }, { value: "ledger", label: "库存流水" }]} onChange={(value) => setView(value as typeof view)} />
      </Toolbar>
      {view === "balance" ? (
        <DataTable loading={inventory.isLoading} empty={!(inventory.data?.length)} headers={["款式", "SKU", "颜色", "尺码", "状态构成", "在库", "预留", "可用", "预警", "操作"]}>
          {inventory.data?.map((row) => <tr key={row.id}><td><strong>{row.style.styleNo}</strong><small>{row.style.name}</small></td><td className="mono">{row.skuCode}</td><td><span className="color-label"><i className={`swatch swatch-${colorSlot(row.color)}`} />{row.color}</span></td><td><strong>{row.size}</strong></td><td><StockBreakdown balances={row.balances} /></td><td className="number">{row.onHand}</td><td className="number muted">{row.reserved}</td><td className="number strong">{row.available}</td><td>{row.lowStock ? <span className="alert-label"><AlertTriangle size={14} />低于 {row.minStock}</span> : <span className="ok-label"><Check size={14} />正常</span>}</td><td><QuickAdjustButton row={row} /></td></tr>)}
        </DataTable>
      ) : (
        <DataTable loading={ledger.isLoading} empty={!(ledger.data?.length)} headers={["时间", "单据", "款式 / SKU", "数量变化", "预留变化", "结存", "操作人"]}>
          {ledger.data?.slice(0, 100).map((row) => <tr key={row.id}><td>{formatDate(row.createdAt)}</td><td><strong>{row.document.documentNo}</strong><small>{ledgerSource(row.document)}</small></td><td><strong>{row.sku.style.styleNo}</strong><small className="mono">{row.sku.skuCode}</small></td><td className={`number ${row.quantityDelta > 0 ? "positive" : row.quantityDelta < 0 ? "negative" : ""}`}>{signed(row.quantityDelta)}</td><td className="number">{signed(row.reservedDelta)}</td><td className="number strong">{row.balanceAfter}</td><td>{row.actor.name}</td></tr>)}
        </DataTable>
      )}
    </>
  );
}

function CatalogPage({ user }: { user: User }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Style | null>(null);
  const queryClient = useQueryClient();
  const styles = useQuery({ queryKey: ["styles"], queryFn: () => api<Style[]>("/catalog/styles") });
  const remove = useMutation({
    mutationFn: (style: Style) => api(`/catalog/styles/${style.id}`, { method: "DELETE" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["styles"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); queryClient.invalidateQueries({ queryKey: ["goods-order-inventory"] }); emitToast("商品已删除或停用"); },
    onError: (error) => emitToast(errorText(error), "error"),
  });
  return (
    <>
      <PageHeader eyebrow="商品主数据" title="款式与 SKU" description="用颜色 × 尺码矩阵维护服装规格。" action={can(user, "catalog.manage") ? <button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={17} />新建款式</button> : undefined} />
      <div className="style-list">
        {styles.isLoading ? <PageLoading /> : !styles.data?.length ? <EmptyState icon={<Shirt />} title="还没有款式" description="创建第一个款式并批量生成颜色尺码 SKU。" action={<button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={17} />新建款式</button>} /> : styles.data.map((style) => <StyleRow key={style.id} style={style} onEdit={can(user, "catalog.manage") ? () => setEditing(style) : undefined} onDelete={can(user, "catalog.manage") ? () => window.confirm(`确定删除商品 ${style.styleNo} · ${style.name} 吗？有历史记录的商品会改为停用，历史单据仍保留。`) && remove.mutate(style) : undefined} deleting={remove.isPending} />)}
      </div>
      {createOpen && <CreateStyleModal onClose={() => setCreateOpen(false)} />}
      {editing && <EditStyleModal style={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function StyleRow({ style, onEdit, onDelete, deleting }: { style: Style; onEdit?: () => void; onDelete?: () => void; deleting?: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const activeSkus = style.skus.filter((sku) => sku.active);
  const colors = [...new Set(activeSkus.map((sku) => sku.color))].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  const sizeOrder = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"];
  const sizes = [...new Set(activeSkus.map((sku) => sku.size))].sort((left, right) => { const leftIndex = sizeOrder.indexOf(left.toUpperCase()); const rightIndex = sizeOrder.indexOf(right.toUpperCase()); return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex) || left.localeCompare(right, "zh-CN", { numeric: true }); });
  const totalAvailable = activeSkus.reduce((sum, sku) => sum + (sku.available ?? 0), 0);
  const lowCount = activeSkus.filter((sku) => sku.lowStock).length;
  return (
    <article className="style-row">
      <div className="style-summary"><span className="style-thumb"><Shirt size={24} /></span><div><span className="mono eyebrow">{style.styleNo}</span><h3>{style.name}</h3><p>{[style.brand, style.category, style.season, style.year].filter(Boolean).join(" · ") || "未填写扩展属性"}</p></div><div className="style-summary-actions"><strong className="sku-count">{activeSkus.length}<small>启用 SKU</small></strong>{onEdit && <button className="icon-button" title="编辑商品" onClick={onEdit}><Pencil size={15} /></button>}{onDelete && <button className="icon-button danger" title="删除商品" disabled={deleting} onClick={onDelete}><Trash2 size={15} /></button>}</div></div>
      <div className="variant-preview"><span>颜色</span>{colors.map((color, index) => <b key={color}><i className={`swatch swatch-${index % 4}`} />{color}</b>)}<span>尺码</span>{sizes.map((size) => <b key={size}>{size}</b>)}</div>
      <div className="stock-preview" aria-label="仅预览库存"><span>仅预览库存</span><strong>{totalAvailable.toLocaleString()}<small>可用</small></strong><em>{lowCount ? `${lowCount} 个 SKU 低于预警值` : "库存正常"}</em><button className="button small" type="button" onClick={() => setPreviewOpen(true)}>查看库存矩阵</button></div>
      <div className="stock-preview-grid">
        {activeSkus.map((sku) => <span key={sku.id} className={sku.lowStock ? "low" : ""}><b>{sku.color} / {sku.size}</b><strong>{(sku.available ?? 0).toLocaleString()}</strong><small>预警 {sku.minStock}</small></span>)}
      </div>
      {previewOpen && <Modal title={`库存预览 · ${style.styleNo}`} subtitle={`${style.name} · 仅查看，不会修改库存`} onClose={() => setPreviewOpen(false)} wide><div className="stock-preview-modal-summary"><strong>{totalAvailable.toLocaleString()}<small>可用库存</small></strong><span>{activeSkus.length} 个启用 SKU</span><em>{lowCount ? `${lowCount} 个 SKU 低于预警值` : "库存正常"}</em></div><ReadOnlyStockMatrix colors={colors} sizes={sizes} skus={activeSkus} /></Modal>}
    </article>
  );
}

function ReadOnlyStockMatrix({ colors, sizes, skus }: { colors: string[]; sizes: string[]; skus: Sku[] }) {
  return <div className="readonly-stock-matrix" style={{ gridTemplateColumns: `minmax(92px, 1fr) repeat(${colors.length}, minmax(74px, .8fr))` }}><span className="matrix-corner">尺码 / 颜色</span>{colors.map((color, index) => <span className="matrix-size" key={color}><i className={`swatch swatch-${index % 4}`} />{color}</span>)}{sizes.flatMap((size) => [<span className="matrix-color" key={`${size}-label`}>{size}</span>, ...colors.map((color) => { const sku = skus.find((item) => item.color === color && item.size === size); return <span className={`matrix-cell ${sku?.lowStock ? "low" : ""}`} key={`${size}-${color}`}><strong>{(sku?.available ?? 0).toLocaleString()}</strong><small>预警 {sku?.minStock ?? 0}</small></span>; })])}</div>;
}

type EditableVariant = { id?: string; skuCode: string; color: string; size: string; minStock: number; active: boolean };

function EditStyleModal({ style, onClose }: { style: Style; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(style.name);
  const [brand, setBrand] = useState(style.brand ?? "");
  const [category, setCategory] = useState(style.category ?? "");
  const [newColor, setNewColor] = useState("");
  const [newColorCode, setNewColorCode] = useState("");
  const [newSize, setNewSize] = useState("");
  const [variants, setVariants] = useState<EditableVariant[]>(style.skus.map((sku) => ({ ...sku })));
  const update = useMutation({
    mutationFn: () => api(`/catalog/styles/${style.id}`, {
      method: "PUT",
      body: jsonBody({
        name,
        brand: brand || null,
        category: category || null,
        activeSkuIds: variants.filter((variant) => variant.id && variant.active).map((variant) => variant.id),
        variants: variants.map(({ id, skuCode, color, size, minStock }) => ({ id, skuCode, color, size, minStock })),
      }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["styles"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      emitToast("商品规格已更新");
      onClose();
    },
  });
  const patchVariant = (index: number, patch: Partial<EditableVariant>) => setVariants((current) => current.map((variant, itemIndex) => itemIndex === index ? { ...variant, ...patch } : variant));
  const existingColors = [...new Set(variants.map((variant) => variant.color).filter(Boolean))];
  const existingSizes = [...new Set(variants.map((variant) => variant.size).filter(Boolean))];
  const addVariant = () => setVariants((current) => [...current, { skuCode: `${style.styleNo}-${String(current.length + 1).padStart(2, "0")}`.toUpperCase(), color: "", size: "", minStock: 0, active: true }]);
  const addColor = () => {
    const color = newColor.trim();
    const code = newColorCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    if (!color || !code) return;
    setVariants((current) => [...current, ...existingSizes.filter((size) => !current.some((variant) => variant.color === color && variant.size === size)).map((size) => ({ skuCode: `${style.styleNo}-${code}-${size}`.toUpperCase(), color, size, minStock: 0, active: true }))]);
    setNewColor(""); setNewColorCode("");
  };
  const addSize = () => {
    const size = newSize.trim().toUpperCase();
    if (!size) return;
    setVariants((current) => [...current, ...existingColors.filter((color) => !current.some((variant) => variant.color === color && variant.size === size)).map((color) => ({ skuCode: `${style.styleNo}-${colorCodeFromSkuCode(current.find((variant) => variant.color === color)?.skuCode ?? color)}-${size}`.toUpperCase(), color, size, minStock: 0, active: true }))]);
    setNewSize("");
  };
  const removeColor = (color: string) => setVariants((current) => current.map((variant) => variant.color === color && variant.id ? { ...variant, active: false } : variant).filter((variant) => variant.id || variant.color !== color));
  const removeSize = (size: string) => setVariants((current) => current.map((variant) => variant.size === size && variant.id ? { ...variant, active: false } : variant).filter((variant) => variant.id || variant.size !== size));
  return <Modal title={`维护商品 · ${style.styleNo}`} subtitle="有历史流水的规格会停用保留，不会删除记录" onClose={onClose} wide>
    <form className="edit-style-form" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
      <div className="form-grid compact"><label>款式名称<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>品牌<input value={brand} onChange={(event) => setBrand(event.target.value)} /></label><label>品类<input value={category} onChange={(event) => setCategory(event.target.value)} /></label><label>款号<input value={style.styleNo} disabled /></label></div>
      <div className="variant-editor">
        <div className="variant-editor-head"><strong>颜色尺码规格</strong><button className="button small" type="button" onClick={addVariant}><Plus size={14} />添加规格</button></div>
        <div className="variant-bulk-tools"><label>新增颜色<input value={newColor} onChange={(event) => setNewColor(event.target.value)} placeholder="颜色" /></label><label>颜色编号<input value={newColorCode} onChange={(event) => setNewColorCode(event.target.value)} placeholder="编号" /></label><button className="button small" type="button" disabled={!newColor.trim() || !newColorCode.trim() || !existingSizes.length} onClick={addColor}>增加颜色</button><label>新增尺码<input value={newSize} onChange={(event) => setNewSize(event.target.value)} placeholder="尺码" /></label><button className="button small" type="button" disabled={!newSize.trim() || !existingColors.length} onClick={addSize}>增加尺码</button></div>
        <div className="variant-chip-tools"><span>颜色</span>{existingColors.map((color) => <button className="button small" type="button" key={color} onClick={() => removeColor(color)}>{color} ×</button>)}<span>尺码</span>{existingSizes.map((size) => <button className="button small" type="button" key={size} onClick={() => removeSize(size)}>{size} ×</button>)}</div>
        <div className="variant-editor-columns"><span>启用</span><span>SKU 编码</span><span>颜色</span><span>尺码</span><span>库存预警值</span><span /></div>
        {variants.map((variant, index) => <div className={`variant-editor-row ${variant.active ? "" : "inactive"}`} key={variant.id ?? `new-${index}`}>
          <label className="toggle-cell"><input aria-label={`启用 ${variant.skuCode}`} type="checkbox" checked={variant.active} onChange={(event) => patchVariant(index, { active: event.target.checked })} /><span /></label>
          <input aria-label={`第 ${index + 1} 行 SKU 编码`} required value={variant.skuCode} onChange={(event) => patchVariant(index, { skuCode: event.target.value })} />
          <input aria-label={`第 ${index + 1} 行颜色`} required value={variant.color} onChange={(event) => patchVariant(index, { color: event.target.value })} />
          <input aria-label={`第 ${index + 1} 行尺码`} required value={variant.size} onChange={(event) => patchVariant(index, { size: event.target.value })} />
          <input aria-label={`第 ${index + 1} 行库存预警值`} type="number" min="0" value={variant.minStock} onChange={(event) => patchVariant(index, { minStock: Number(event.target.value) })} />
          {!variant.id ? <button className="icon-button danger" type="button" aria-label={`删除第 ${index + 1} 行规格`} onClick={() => setVariants((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button> : <span />}
        </div>)}
      </div>
      {update.error && <ErrorBanner>{errorText(update.error)}</ErrorBanner>}
      <ModalActions onClose={onClose} pending={update.isPending} submitLabel="保存商品" />
    </form>
  </Modal>;
}

function CreateStyleModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [styleNo, setStyleNo] = useState("");
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [colors, setColors] = useState([{ alias: "黑色", code: "BK" }, { alias: "白色", code: "WH" }]);
  const [sizes, setSizes] = useState("S,M,L,XL");
  const colorList = colors.map((color) => ({ alias: color.alias.trim(), code: color.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "") })).filter((color) => color.alias && color.code);
  const sizeList = splitList(sizes);
  const patchColor = (index: number, patch: Partial<{ alias: string; code: string }>) => setColors((current) => current.map((color, itemIndex) => itemIndex === index ? { ...color, ...patch } : color));
  const create = useMutation({
    mutationFn: () => api("/catalog/styles", { method: "POST", body: jsonBody({ styleNo, name, brand: brand || null, category: category || null, attributes: {}, variants: colorList.flatMap((color) => sizeList.map((size) => ({ skuCode: `${styleNo}-${color.code}-${size}`.toUpperCase(), color: color.alias, size, minStock: 0 }))) }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["styles"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); emitToast("款式及 SKU 已创建"); onClose(); },
  });
  return (
    <Modal title="新建服装款式" subtitle="颜色和尺码将组合生成 SKU" onClose={onClose}>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <label>款号<input required value={styleNo} onChange={(event) => setStyleNo(event.target.value)} placeholder="例如 SS-2601" /></label>
        <label>款式名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 宽松落肩卫衣" /></label>
        <label>品牌<input value={brand} onChange={(event) => setBrand(event.target.value)} /></label>
        <label>品类<input value={category} onChange={(event) => setCategory(event.target.value)} /></label>
        <div className="span-2 color-code-editor">
          <div className="color-code-head"><strong>颜色</strong><button className="button small" type="button" onClick={() => setColors((current) => [...current, { alias: "", code: "" }])}><Plus size={14} />添加颜色</button></div>
          {colors.map((color, index) => <div className="color-code-row" key={index}><label>颜色别称<input required value={color.alias} onChange={(event) => patchColor(index, { alias: event.target.value })} placeholder="例如 曜石黑" /></label><label>颜色编号<input required value={color.code} onChange={(event) => patchColor(index, { code: event.target.value })} placeholder="例如 BK" /></label><button className="icon-button danger" type="button" aria-label="删除颜色" disabled={colors.length === 1} onClick={() => setColors((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button></div>)}
        </div>
        <label className="span-2">尺码（逗号分隔）<input required value={sizes} onChange={(event) => setSizes(event.target.value)} /></label>
        <div className="span-2 variant-count"><SlidersHorizontal size={16} /><span>将生成 <strong>{colorList.length * sizeList.length}</strong> 个 SKU</span><div>{colorList.map((color, index) => <span key={color.code}><i className={`swatch swatch-${index % 4}`} />{color.alias}<small>{color.code}</small></span>)}</div></div>
        {create.error && <ErrorBanner>{errorText(create.error)}</ErrorBanner>}
        <ModalActions onClose={onClose} pending={create.isPending} submitLabel="创建款式" />
      </form>
    </Modal>
  );
}

function DocumentsPage({ user }: { user: User }) {
  const { type = "INBOUND" } = useParams();
  const normalizedType = typeLabels[type] ? type : "INBOUND";
  const [createOpen, setCreateOpen] = useState(false);
  const [simpleImportOpen, setSimpleImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: ["documents", normalizedType], queryFn: () => api<StockDocument[]>(`/documents?type=${normalizedType}`) });
  const action = useMutation({
    mutationFn: ({ document, name }: { document: StockDocument; name: string }) => api(`/documents/${document.id}/${name}`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: jsonBody({ version: document.version }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["documents"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); emitToast("单据状态已更新"); },
    onError: (error) => emitToast(errorText(error), "error"),
  });
  return (
    <>
      <PageHeader eyebrow="库存单据" title={typeLabels[normalizedType]} description={documentDescription(normalizedType)} action={<div className="page-actions">{normalizedType === "INBOUND" && <button className="button" onClick={() => setSimpleImportOpen(true)}><Upload size={16} />导入并入库</button>}{(normalizedType === "INBOUND" || normalizedType === "OUTBOUND") ? <Link className="button primary" to={`/documents/new?type=${normalizedType}`}><Plus size={17} />新建{typeLabels[normalizedType]}单</Link> : <button className="button primary" onClick={() => setCreateOpen(true)}><Plus size={17} />新建{typeLabels[normalizedType]}单</button>}</div>} />
      <div className="document-tabs">{[["INBOUND", "入库"], ["OUTBOUND", "出库"]].map(([value, label]) => <Link key={value} className={value === normalizedType ? "active" : ""} to={`/documents/${value}`}>{label}</Link>)}</div>
      <DataTable loading={documents.isLoading} empty={!(documents.data?.length)} emptyState={<DocumentEmptyState type={normalizedType} onSimpleImport={() => setSimpleImportOpen(true)} onCreateLegacy={() => setCreateOpen(true)} />} headers={["单号", "来源 / 往来方", "行数 / 数量", "状态", "制单人", "时间", "操作"]}>
        {documents.data?.map((document) => (
          <DocumentRows key={document.id} document={document} expanded={expanded === document.id} onToggle={() => setExpanded(expanded === document.id ? null : document.id)} onAction={(name) => action.mutate({ document, name })} canReverse={can(user, "inventory.adjust")} />
        ))}
      </DataTable>
      {createOpen && <CreateDocumentModal type={normalizedType} onClose={() => setCreateOpen(false)} />}
      {simpleImportOpen && <SimpleImportDialog kind="INBOUND" onClose={() => setSimpleImportOpen(false)} onConfirmed={() => { queryClient.invalidateQueries({ queryKey: ["documents"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); }} />}
    </>
  );
}

function DocumentEmptyState({ type, onSimpleImport, onCreateLegacy }: { type: string; onSimpleImport: () => void; onCreateLegacy: () => void }) {
  if (type === "INBOUND") return <EmptyState icon={<ArrowDownToLine />} title="还没有入库单" description="手工录入到货矩阵，或直接导入供应商表格并确认入库。" action={<div className="empty-actions"><button className="button" onClick={onSimpleImport}><Upload size={16} />导入并入库</button><Link className="button primary" to="/documents/new?type=INBOUND"><Plus size={17} />新建入库单</Link></div>} />;
  if (type === "OUTBOUND") return <EmptyState icon={<ArrowUpFromLine />} title="还没有出库单" description="从订单或发货明细新建出库单，预览通过后会扣减可用库存。" action={<Link className="button primary" to="/documents/new?type=OUTBOUND"><Plus size={17} />新建出库单</Link>} />;
  return <EmptyState icon={<ClipboardList />} title={`还没有${typeLabels[type]}单`} description="这类单据保存后会先进入草稿或审批流程，不会绕过库存校验。" action={<button className="button primary" onClick={onCreateLegacy}><Plus size={17} />新建{typeLabels[type]}单</button>} />;
}

function DocumentRows({ document, expanded, onToggle, onAction, canReverse }: { document: StockDocument; expanded: boolean; onToggle: () => void; onAction: (name: string) => void; canReverse: boolean }) {
  const quantity = document.lines.reduce((sum, line) => sum + (document.type === "STOCKTAKE" ? Number(line.countedPieces ?? 0) : document.type === "ADJUSTMENT" ? Math.abs(Number(line.adjustmentDelta ?? 0)) : line.quantityPieces), 0);
  return (
    <>
      <tr className="clickable-row" onClick={onToggle}><td><button className="row-disclosure" aria-label="展开单据"><ChevronDown className={expanded ? "rotated" : ""} size={16} /></button><strong className="mono">{document.documentNo}</strong></td><td>{document.sourceRef || document.counterparty || "-"}<small>{document.reason}</small></td><td><strong>{document.lines.length}</strong> 行 <span className="table-separator" /> <strong>{quantity}</strong> 件</td><td><StatusBadge status={document.status} /></td><td>{document.createdBy.name}</td><td>{formatDate(document.createdAt)}</td><td onClick={(event) => event.stopPropagation()}><div className="row-actions">{document.status === "DRAFT" && ["INBOUND", "OUTBOUND"].includes(document.type) ? <Link className="button small" to={`/documents/${document.id}/edit`}><Pencil size={14} />编辑</Link> : document.status === "DRAFT" ? <button className="button small" onClick={() => onAction("confirm")}><Check size={14} />确认</button> : null}{document.status === "CONFIRMED" && document.type === "OUTBOUND" && <button className="button small" onClick={() => onAction("reserve")}><Archive size={14} />预留</button>}{document.status === "CONFIRMED" && document.type !== "OUTBOUND" && <button className="button small primary" onClick={() => onAction("post")}><PackageCheck size={14} />过账</button>}{document.status === "RESERVED" && <button className="button small primary" onClick={() => onAction("post")}><PackageCheck size={14} />发货过账</button>}{document.status === "POSTED" && canReverse && <button className="icon-button danger" title="冲销" onClick={() => onAction("reverse")}><RotateCcw size={15} /></button>}</div></td></tr>
      {expanded && <tr className="detail-row"><td colSpan={7}><div className="document-lines">{document.lines.map((line) => <div key={line.id}><span><strong>{line.sku.style.styleNo}</strong> · {line.sku.style.name}</span><span>{line.sku.color} / {line.sku.size}</span><span className="mono">{line.sku.skuCode}</span><strong>{document.type === "STOCKTAKE" ? `${line.countedPieces} 件实盘` : document.type === "ADJUSTMENT" ? signed(line.adjustmentDelta ?? 0) : `${line.quantityPieces} 件`}</strong></div>)}</div></td></tr>}
    </>
  );
}

type DraftLine = { skuId: string; stockStatus: string; cartons: number; piecesPerCarton: number; loosePieces: number; countedPieces?: number; adjustmentDelta?: number };

function CreateDocumentModal({ type, onClose }: { type: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const inventory = useQuery({ queryKey: ["inventory", ""], queryFn: () => api<InventoryRow[]>("/inventory/balances") });
  const [sourceRef, setSourceRef] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ skuId: "", stockStatus: "SELLABLE", cartons: 0, piecesPerCarton: 0, loosePieces: type === "STOCKTAKE" || type === "ADJUSTMENT" ? 0 : 1, countedPieces: type === "STOCKTAKE" ? 0 : undefined, adjustmentDelta: type === "ADJUSTMENT" ? 1 : undefined }]);
  const create = useMutation({
    mutationFn: () => api("/documents", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: jsonBody({ type, sourceRef: sourceRef || null, counterparty: counterparty || null, reason: reason || null, lines }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["documents"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); emitToast(`${typeLabels[type]}单草稿已创建`); onClose(); },
  });
  const setLine = (index: number, patch: Partial<DraftLine>) => setLines((current) => current.map((line, itemIndex) => itemIndex === index ? { ...line, ...patch } : line));
  return (
    <Modal title={`新建${typeLabels[type]}单`} subtitle="保存后先生成草稿，不会立即改变库存" onClose={onClose} wide>
      <form className="document-form" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <div className="form-grid compact">
          <label>来源单号<input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} placeholder="可选" /></label>
          <label>{type === "OUTBOUND" ? "客户 / 平台" : "供应商 / 往来方"}<input value={counterparty} onChange={(event) => setCounterparty(event.target.value)} placeholder="可选" /></label>
          {(type === "ADJUSTMENT" || type === "STOCKTAKE") && <label className="span-2">原因<input required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="库存差异原因必须留痕" /></label>}
        </div>
        <div className="line-editor">
          <div className="line-editor-head"><strong>单据明细</strong><button type="button" className="button small" onClick={() => setLines((current) => [...current, { skuId: "", stockStatus: "SELLABLE", cartons: 0, piecesPerCarton: 0, loosePieces: type === "STOCKTAKE" || type === "ADJUSTMENT" ? 0 : 1, countedPieces: type === "STOCKTAKE" ? 0 : undefined, adjustmentDelta: type === "ADJUSTMENT" ? 1 : undefined }])}><Plus size={14} />添加一行</button></div>
          {lines.map((line, index) => <div className="line-grid" key={index}><label className="sku-field">SKU<select required value={line.skuId} onChange={(event) => setLine(index, { skuId: event.target.value })}><option value="">选择款色尺码</option>{inventory.data?.map((sku) => <option key={sku.id} value={sku.id}>{sku.style.styleNo} · {sku.color}/{sku.size} · 可用 {sku.available}</option>)}</select></label><label>库存状态<select value={line.stockStatus} onChange={(event) => setLine(index, { stockStatus: event.target.value })}><option value="SELLABLE">可售</option><option value="INSPECTION">待检</option><option value="DAMAGED">残次</option></select></label>{type === "STOCKTAKE" ? <label>实盘件数<input type="number" min="0" value={line.countedPieces} onChange={(event) => setLine(index, { countedPieces: Number(event.target.value) })} /></label> : type === "ADJUSTMENT" ? <label>调整数量<input type="number" value={line.adjustmentDelta} onChange={(event) => setLine(index, { adjustmentDelta: Number(event.target.value) })} /></label> : <><label>箱数<input type="number" min="0" value={line.cartons} onChange={(event) => setLine(index, { cartons: Number(event.target.value) })} /></label><label>箱规<input type="number" min="0" value={line.piecesPerCarton} onChange={(event) => setLine(index, { piecesPerCarton: Number(event.target.value) })} /></label><label>散件<input type="number" min="0" value={line.loosePieces} onChange={(event) => setLine(index, { loosePieces: Number(event.target.value) })} /></label></>}<button type="button" className="icon-button danger line-remove" aria-label="删除明细" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button></div>)}
        </div>
        {create.error && <ErrorBanner>{errorText(create.error)}</ErrorBanner>}
        <ModalActions onClose={onClose} pending={create.isPending} submitLabel="保存草稿" />
      </form>
    </Modal>
  );
}

type AiChatMovementDraftAction = { type: "create_inbound_draft" | "create_outbound_draft"; warehouseId: string; lines: Array<{ skuId: string; skuCode: string; styleNo: string; color: string; size: string; quantity: number }> };
type AiChatFixRowsAction = { type: "fix_import_rows"; jobId: string; fixes: Array<{ rowId: string; patch: Record<string, string | number> }> };
type AiChatMapRowsAction = { type: "map_rows_to_style"; jobId: string; styleNo: string; name?: string | null; rows: Array<{ row: number; color?: string; size?: string }> };
type AiChatCreateStyleAction = { type: "create_style"; styleNo: string; name: string; brand?: string | null; category?: string | null; variants: Array<{ skuCode: string; color: string; size: string; minStock?: number }> };
type AiChatReanalyzeAction = { type: "reanalyze_import"; jobId: string; instruction?: string };
type AiChatAction = AiChatMovementDraftAction | AiChatFixRowsAction | AiChatMapRowsAction | AiChatCreateStyleAction | AiChatReanalyzeAction;
type AiChatPreview = { action: AiChatMovementDraftAction; previewToken: string; rows: Array<{ skuId: string; skuCode: string; styleNo: string; color: string; size: string; quantity: number; currentOnHand: number; projectedOnHand: number; errors: string[]; warnings: string[] }>; totals: { quantity: number; delta: number }; valid: boolean; expiresAt: string };
type AiChatMessage = { role: "user" | "assistant"; text: string; action?: AiChatAction | null; preview?: AiChatPreview | null };

function AiChatPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("INBOUND");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [autoSelectedJob, setAutoSelectedJob] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<any | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([{ role: "assistant", text: "你好，我可以按你的账号权限查询库存。你也可以在下方上传截图、图片、PDF 或表格，我会识别内容并生成待确认草稿。" }]);
  const detail = useQuery({ queryKey: ["ai-chat-import", selectedJob], queryFn: () => api<ImportJob>(`/imports/${selectedJob}`), enabled: Boolean(selectedJob), refetchInterval: (query) => ["QUEUED", "PROCESSING"].includes(query.state.data?.status ?? "") ? 2000 : false });
  const send = useMutation({ mutationFn: (message: string) => { const history = messages.slice(-12).flatMap((item) => item.text ? [{ role: item.role, text: item.text.slice(0, 500) }] : []); return api<{ reply: string; action: AiChatAction | null; permissions: { canViewInventory: boolean; canCreateDraft: boolean; canManageCatalog: boolean } }>("/ai/chat", { method: "POST", body: jsonBody(selectedJob ? { message, jobId: selectedJob, history } : { message, history }) }); }, onSuccess: (result) => setMessages((current) => [...current, { role: "assistant", text: result.reply, action: result.action }]), onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const upload = useMutation({ mutationFn: () => { const body = new FormData(); body.set("file", file!); body.set("kind", kind); return api<{ job_id: string }>("/imports", { method: "POST", body }); }, onSuccess: (result) => { setSelectedJob(result.job_id); setAccepted([]); setImportPreview(null); setMessages((current) => [...current, { role: "user", text: `已上传文件：${file?.name ?? "附件"}` }, { role: "assistant", text: "文件已进入 AI 识别队列。识别完成后先调用系统工具预览，不会直接创建单据或修改库存。" }]); setFile(null); emitToast("附件已进入 AI 识别队列"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const setAcceptedRows = (next: string[]) => { setAccepted(next); setImportPreview(null); };
  const selectedImportRows = () => (detail.data?.rows ?? []).filter((row) => accepted.includes(row.id) && !row.validationErrors.length && row.skuId);
  const importPayload = () => ({ warehouseId: detail.data!.warehouseId, type: detail.data!.kind === "OUTBOUND" ? "OUTBOUND" : "INBOUND", sourceRef: `AI-${detail.data!.id}`, counterparty: null, reason: `AI 识别文件 ${detail.data!.fileName}`, lines: selectedImportRows().map((row) => ({ skuId: row.skuId!, stockStatus: "SELLABLE", quantity: Number(row.normalized.quantity ?? row.normalized.countedPieces), note: null })) });
  const previewImport = useMutation({ mutationFn: () => api<any>("/documents/preview", { method: "POST", body: jsonBody(importPayload()) }), onSuccess: (result) => { setImportPreview(result); setMessages((current) => [...current, { role: "assistant", text: `系统预览完成：${result.rows.length} 行，共 ${result.totals.quantity} 件。请检查当前库存和预览后库存，确认无误后再${result.type === "INBOUND" ? "入库" : "提交"}。` }]); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const confirmImport = useMutation({ mutationFn: async () => { if (!importPreview?.valid) throw new Error("预览未通过，不能提交"); const draft = await api<StockDocument>("/documents/drafts", { method: "POST", headers: { "Idempotency-Key": `ai-import-draft-${selectedJob}` }, body: jsonBody(importPayload()) }); return api<StockDocument>(`/documents/${draft.id}/commit`, { method: "POST", headers: { "Idempotency-Key": `ai-import-commit-${selectedJob}` }, body: jsonBody({ previewToken: importPreview.previewToken }) }); }, onSuccess: (document) => { queryClient.invalidateQueries({ queryKey: ["imports"] }); queryClient.invalidateQueries({ queryKey: ["documents"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); setSelectedJob(null); setAccepted([]); setImportPreview(null); setMessages((current) => [...current, { role: "assistant", text: `${document.documentNo} 已确认并完成${document.type === "INBOUND" ? "入库" : "提交"}，库存账已更新。` }]); emitToast("AI 识别单据已入库"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const previewAction = useMutation({ mutationFn: (action: AiChatMovementDraftAction) => api<AiChatPreview>("/ai/chat/preview", { method: "POST", body: jsonBody({ action }) }), onSuccess: (preview, action) => setMessages((current) => current.map((message) => message.action === action ? { ...message, action: null, preview } : message)), onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const applyFix = useMutation({ mutationFn: (action: AiChatFixRowsAction) => api<ImportJob>("/ai/chat/fix-import-rows", { method: "POST", body: jsonBody({ jobId: action.jobId, fixes: action.fixes }) }), onSuccess: (job) => { queryClient.setQueryData(["ai-chat-import", selectedJob], job); queryClient.invalidateQueries({ queryKey: ["ai-chat-import", selectedJob] }); setAccepted([]); setImportPreview(null); setMessages((current) => [...current, { role: "assistant", text: `已按对话修正 ${(job.rows ?? []).length} 行识别结果，校验已重新计算。请查看下方表格确认。` }]); emitToast("识别结果已修正"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const mapRowsAction = useMutation({ mutationFn: (action: AiChatMapRowsAction) => api<ImportJob>("/ai/chat/map-rows-to-style", { method: "POST", body: jsonBody({ jobId: action.jobId, styleNo: action.styleNo, name: action.name, rows: action.rows }) }), onSuccess: (job, action) => { queryClient.setQueryData(["ai-chat-import", selectedJob], job); queryClient.invalidateQueries({ queryKey: ["ai-chat-import", selectedJob] }); setAccepted([]); setImportPreview(null); setMessages((current) => [...current, { role: "assistant", text: `已将 ${action.rows.length} 行关联到款号 ${action.styleNo}，校验已重新计算。请查看下方表格确认。` }]); emitToast("识别行已关联商品"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const createStyleAction = useMutation({ mutationFn: (action: AiChatCreateStyleAction) => api<{ style: { styleNo: string; name: string; skus: Array<{ skuCode: string; color: string; size: string }> }; job: ImportJob | null }>("/ai/chat/create-style", { method: "POST", body: jsonBody({ styleNo: action.styleNo, name: action.name, brand: action.brand, category: action.category, variants: action.variants, matchJobId: selectedJob ?? undefined }) }), onSuccess: (result) => { queryClient.invalidateQueries({ queryKey: ["styles"] }); queryClient.invalidateQueries({ queryKey: ["inventory"] }); if (result.job) { queryClient.setQueryData(["ai-chat-import", selectedJob], result.job); queryClient.invalidateQueries({ queryKey: ["ai-chat-import", selectedJob] }); setAccepted([]); setImportPreview(null); } setMessages((current) => [...current, { role: "assistant", text: `已新建商品 ${result.style.styleNo} ${result.style.name}（${result.style.skus.length} 个规格）。${result.job ? "相关导入行已重新匹配到新 SKU，请查看下方表格。" : ""}` }]); emitToast("商品已新建"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const reanalyzeImport = useMutation({ mutationFn: (action: AiChatReanalyzeAction) => api<ImportJob>("/ai/chat/reanalyze-import", { method: "POST", body: jsonBody({ jobId: action.jobId, instruction: action.instruction }) }), onSuccess: (job) => { queryClient.setQueryData(["ai-chat-import", selectedJob], job); queryClient.invalidateQueries({ queryKey: ["ai-chat-import", selectedJob] }); setAccepted([]); setImportPreview(null); setMessages((current) => [...current, { role: "assistant", text: `已结合原图重新识别，共 ${(job.rows ?? []).length} 行，校验已重新计算。请查看下方表格确认。` }]); emitToast("已结合原图重新识别"); }, onError: (error) => setMessages((current) => [...current, { role: "assistant", text: errorText(error) }]) });
  const confirm = useMutation({ mutationFn: (preview: AiChatPreview) => api<StockDocument>("/ai/chat/confirm-draft", { method: "POST", body: jsonBody({ preview }) }), onSuccess: (document) => { queryClient.invalidateQueries({ queryKey: ["documents"] }); setMessages((current) => [...current, { role: "assistant", text: `已创建${document.type === "OUTBOUND" ? "出库" : "入库"}草稿 ${document.documentNo}，库存尚未改变，请到单据页预览并提交。` }]); emitToast(`AI ${document.type === "OUTBOUND" ? "出库" : "入库"}草稿已创建`); }, onError: (error) => emitToast(errorText(error), "error") });
  const submit = () => { const message = input.trim(); if (!message || send.isPending) return; setMessages((current) => [...current, { role: "user", text: message }]); setInput(""); send.mutate(message); };
  const validRows = detail.data?.rows?.filter((row) => row.validationErrors.length === 0) ?? [];
  useEffect(() => {
    if (detail.data?.status === "REVIEW" && selectedJob && autoSelectedJob !== selectedJob) {
      setAccepted(validRows.map((row) => row.id));
      setAutoSelectedJob(selectedJob);
    }
  }, [detail.data?.status, selectedJob, autoSelectedJob, validRows]);
  return <><PageHeader eyebrow="权限感知助手" title="AI 仓库助手" description="文字、截图和业务文件都可以直接发给 AI；识别与生成只产生待确认草稿，不会直接落账。" /><section className="ai-chat-layout"><div className="ai-chat-permissions"><ShieldCheck size={18} /><span><strong>{user.role.name}</strong><small>{can(user, "inventory.view") ? "可查询库存" : "不可查询库存"} · {can(user, "documents.manage") ? "可创建入库草稿" : "不可创建入库草稿"} · {can(user, "imports.manage") ? "可上传识别文件" : "不可上传识别文件"}</small></span></div><div className="ai-chat-messages">{messages.map((message, index) => <div key={index} className={`ai-chat-message ${message.role}`}><span>{message.text}</span>{message.action?.type === "create_inbound_draft" && <div className="ai-chat-action"><strong>待预览入库草稿</strong><small>{message.action.lines.map((line) => `${line.styleNo} ${line.color}/${line.size} +${line.quantity}`).join("；")}</small><button className="button primary small" disabled={previewAction.isPending} onClick={() => previewAction.mutate(message.action as AiChatMovementDraftAction)}>{previewAction.isPending ? "正在预览" : "先预览并排序"}</button></div>}{message.action?.type === "create_outbound_draft" && <div className="ai-chat-action"><strong>待预览出库草稿</strong><small>{message.action.lines.map((line) => `${line.styleNo} ${line.color}/${line.size} -${line.quantity}`).join("；")}</small><button className="button primary small" disabled={previewAction.isPending} onClick={() => previewAction.mutate(message.action as AiChatMovementDraftAction)}>{previewAction.isPending ? "正在预览" : "先预览并校验库存"}</button></div>}{message.action?.type === "reanalyze_import" && <div className="ai-chat-action"><strong>建议结合原图重新识别</strong><small>{message.action.instruction ? `原因：${message.action.instruction}` : "AI 认为当前识别结果可能不准确，建议重新看一遍原图"}</small><button className="button primary small" disabled={reanalyzeImport.isPending} onClick={() => reanalyzeImport.mutate(message.action as AiChatReanalyzeAction)}>{reanalyzeImport.isPending ? "正在重新识别" : "结合原图重新识别"}</button></div>}{message.action?.type === "fix_import_rows" && <div className="ai-chat-action"><strong>识别结果修正方案</strong><small>{message.action.fixes.map((fix) => `行 ${fix.rowId}：${Object.entries(fix.patch).map(([field, value]) => `${field}=${value}`).join("，")}`).join("；")}</small><button className="button primary small" disabled={applyFix.isPending} onClick={() => applyFix.mutate(message.action as AiChatFixRowsAction)}>{applyFix.isPending ? "正在修正" : "应用修正"}</button></div>}{message.action?.type === "map_rows_to_style" && <div className="ai-chat-action"><strong>关联到已有商品</strong><small>款号 {message.action.styleNo}{message.action.name ? ` · ${message.action.name}` : ""} · 共 {message.action.rows.length} 行{message.action.rows.slice(0, 8).map((r) => `#${r.row}${r.color ? ` 颜色=${r.color}` : ""}${r.size ? ` 尺码=${r.size}` : ""}`).join("，")}{message.action.rows.length > 8 ? ` 等 ${message.action.rows.length} 行` : ""}</small><button className="button primary small" disabled={mapRowsAction.isPending} onClick={() => mapRowsAction.mutate(message.action as AiChatMapRowsAction)}>{mapRowsAction.isPending ? "正在关联" : "确认关联"}</button></div>}{message.action?.type === "create_style" && <div className="ai-chat-action"><strong>对话式新建商品</strong><small>款号 {message.action.styleNo} · {message.action.name} · 规格 {message.action.variants.map((variant) => `${variant.skuCode}(${variant.color}/${variant.size})`).join("、")}</small><button className="button primary small" disabled={createStyleAction.isPending} onClick={() => createStyleAction.mutate(message.action as AiChatCreateStyleAction)}>{createStyleAction.isPending ? "正在新建" : "确认新建商品"}</button></div>}{message.preview && <div className="ai-chat-action"><strong>{message.preview.action?.type === "create_outbound_draft" ? "出库" : "入库"}预览已完成 · 共 {message.preview.totals.quantity} 件</strong><small>{message.preview.rows.map((row) => `${row.styleNo} ${row.color}/${row.size} ${message.preview?.action?.type === "create_outbound_draft" ? "-" : "+"}${row.quantity}，预览后 ${row.projectedOnHand}`).join("；")}</small>{message.preview.rows.some((row) => row.warnings.length > 0) && <small>提示：{message.preview.rows.flatMap((row) => row.warnings).join("；")}</small>}<button className="button primary small" disabled={!message.preview.valid || confirm.isPending} onClick={() => confirm.mutate(message.preview!)}>{confirm.isPending ? "正在创建" : `确认无误后创建${message.preview?.action?.type === "create_outbound_draft" ? "出库" : "入库"}草稿`}</button></div>}</div>)}{send.isPending && <div className="ai-chat-message assistant"><span>正在读取授权范围内的库存并分析…</span></div>}{selectedJob && <div className="ai-chat-import-result">{detail.isLoading || ["QUEUED", "PROCESSING"].includes(detail.data?.status ?? "") ? <><RefreshCw className="spin" size={16} /><span>{statusLabels[detail.data?.status ?? "QUEUED"] ?? "正在解析"} · {detail.data?.progress ?? 0}%</span></> : detail.data?.status !== "REVIEW" ? <><strong>{statusLabels[detail.data?.status ?? ""] ?? "解析失败"}</strong><span>{detail.data?.error ?? "没有可确认的识别结果"}</span></> : <><div className="ai-chat-import-head"><strong>识别结果 · {detail.data.fileName}</strong><span>{accepted.length} / {validRows.length} 行已选择</span></div><label className="ai-chat-select-all"><input type="checkbox" checked={validRows.length > 0 && accepted.length === validRows.length} onChange={(event) => setAcceptedRows(event.target.checked ? validRows.map((row) => row.id) : [])} />选择全部有效行</label><div className="ai-chat-import-table"><table><thead><tr><th>选</th><th>SKU</th><th>款号 / 颜色 / 尺码</th><th>数量</th><th>校验</th></tr></thead><tbody>{detail.data.rows?.map((row) => <tr key={row.id}><td><input type="checkbox" disabled={row.validationErrors.length > 0} checked={accepted.includes(row.id)} onChange={(event) => setAcceptedRows((event.target.checked ? [...accepted, row.id] : accepted.filter((id) => id !== row.id)))} /></td><td className="mono">{String(row.normalized.skuCode ?? "-")}</td><td>{[row.normalized.styleNo, row.normalized.color, row.normalized.size].filter(Boolean).map(String).join(" / ") || "-"}</td><td>{String(row.normalized.quantity ?? row.normalized.countedPieces ?? "-")}</td><td>{row.validationErrors.length ? <span className="alert-label"><AlertTriangle size={13} />需修正</span> : <span className="ok-label"><Check size={13} />通过</span>}</td></tr>)}</tbody></table></div><div className="ai-chat-fix-hint"><Sparkles size={14} /><span>识别有误？直接在下方对话框指出（例如"第 3 行颜色是蓝色，数量是 100"），AI 会重新修正并校验；若提示 SKU 不存在，还可以让 AI 对话式新建商品。</span></div><button className="button primary small" disabled={!accepted.length || previewImport.isPending} onClick={() => previewImport.mutate()}><ClipboardCheck size={14} />{previewImport.isPending ? "正在预览" : "调用工具预览"}</button>{importPreview && <div className="ai-chat-system-preview"><div className={`goods-order-preview-issues ${importPreview.valid ? "valid" : "invalid"}`}><div><strong>{importPreview.valid ? "系统校验通过" : "系统校验未通过"}</strong><small>{importPreview.rows.length} 行 · {importPreview.totals.quantity} 件 · 预览令牌有效至 {formatDate(importPreview.expiresAt)}</small></div></div><div className="ai-chat-import-table"><table><thead><tr><th>SKU</th><th>款号 / 颜色 / 尺码</th><th>当前库存</th><th>本次变化</th><th>预览后库存</th><th>提示</th></tr></thead><tbody>{importPreview.rows.map((row: any) => <tr key={row.skuId}><td className="mono">{row.skuCode}</td><td>{row.styleNo} / {row.color} / {row.size}</td><td>{row.currentOnHand}</td><td className={row.delta >= 0 ? "positive" : "negative"}>{signed(row.delta)}</td><td>{row.projectedOnHand}</td><td>{row.errors.length ? <span className="alert-label">{row.errors.join("；")}</span> : row.warnings.length ? <span className="alert-label">{row.warnings.join("；")}</span> : <span className="ok-label"><Check size={13} />正常</span>}</td></tr>)}</tbody></table></div><button className="button primary small" disabled={!importPreview.valid || confirmImport.isPending} onClick={() => window.confirm(`已确认预览无误，确定${importPreview.type === "INBOUND" ? "入库并更新库存" : "提交并更新库存"}吗？`) && confirmImport.mutate()}><PackageCheck size={14} />{confirmImport.isPending ? "正在入库" : "确认无误，执行入库"}</button></div>}</>}</div>}</div><form className="ai-chat-input" onSubmit={(event) => { event.preventDefault(); submit(); }}><div className="ai-chat-compose"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入问题，或先上传附件再补充说明" rows={3} /><div className="ai-chat-attachment"><label className={`ai-chat-file ${file ? "has-file" : ""}`} title="上传截图、图片、PDF 或表格"><Upload size={16} /><span>{file ? file.name : "添加附件"}</span><input type="file" accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label><select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="附件识别类型"><option value="INBOUND">入库识别</option><option value="OUTBOUND">出库识别</option></select>{file && <button type="button" className="icon-button danger" title="移除附件" onClick={() => setFile(null)}><X size={15} /></button>}</div></div><button className="button primary" type={file && can(user, "imports.manage") ? "button" : "submit"} disabled={(file ? upload.isPending || !can(user, "imports.manage") : !input.trim() || send.isPending)} onClick={() => file && can(user, "imports.manage") && upload.mutate()}><Sparkles size={16} />{file ? (upload.isPending ? "正在上传" : "发送附件") : "发送"}</button></form></section></>;
}

function ImportsPage() {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("CATALOG");
  const [sourceName, setSourceName] = useState("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const setAcceptedRows = (next: string[]) => setAccepted(next);
  const jobs = useQuery({ queryKey: ["imports"], queryFn: () => api<ImportJob[]>("/imports"), refetchInterval: (query) => query.state.data?.some((job) => ["QUEUED", "PROCESSING"].includes(job.status)) ? 2000 : false });
  const detail = useQuery({ queryKey: ["import", selectedJob], queryFn: () => api<ImportJob>(`/imports/${selectedJob}`), enabled: Boolean(selectedJob), refetchInterval: (query) => ["QUEUED", "PROCESSING"].includes(query.state.data?.status ?? "") ? 2000 : false });
  const upload = useMutation({
    mutationFn: () => { const body = new FormData(); body.set("file", file!); body.set("kind", kind); if (sourceName) body.set("sourceName", sourceName); return api<{ job_id: string }>("/imports", { method: "POST", body }); },
    onSuccess: (result) => { setSelectedJob(result.job_id); setFile(null); queryClient.invalidateQueries({ queryKey: ["imports"] }); emitToast("文件已进入安全解析队列"); },
  });
  const confirm = useMutation({ mutationFn: () => api(`/imports/${selectedJob}/confirm`, { method: "POST", body: jsonBody({ acceptedRowIds: accepted }) }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["imports"] }); queryClient.invalidateQueries({ queryKey: ["styles"] }); queryClient.invalidateQueries({ queryKey: ["documents"] }); emitToast("已生成系统草稿，库存尚未改变"); setSelectedJob(null); }, onError: (error) => emitToast(errorText(error), "error") });
  const remove = useMutation({ mutationFn: (job: ImportJob) => api(`/imports/${job.id}`, { method: "DELETE" }), onSuccess: (_, job) => { if (selectedJob === job.id) setSelectedJob(null); queryClient.invalidateQueries({ queryKey: ["imports"] }); emitToast("错误导入已删除"); }, onError: (error) => emitToast(errorText(error), "error") });
  const validRows = detail.data?.rows?.filter((row) => row.validationErrors.length === 0) ?? [];
  return (
    <>
      <PageHeader eyebrow="可信 AI 流程" title="AI 导入" description="上传图片、PDF 或表格，AI 按当前新建表单的颜色尺码格式识别，人工确认后生成草稿。" />
      <section className="import-layout">
        <form className="upload-panel" onSubmit={(event) => { event.preventDefault(); if (file) upload.mutate(); }}>
          <div className="upload-icon"><Upload size={24} /></div><div><h2>上传业务文件</h2><p>Excel / CSV 最多 50,000 行；PDF 最多 25 页；单文件不超过 50MB。</p></div>
          <div className="upload-fields"><label>导入内容<select value={kind === "CATALOG" || kind === "STOCKTAKE" ? "INBOUND" : kind} onChange={(event) => setKind(event.target.value)}><option value="INBOUND">入库表单</option><option value="OUTBOUND">出库表单</option></select></label><label>供应商 / 来源<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="例如：某供应商月表" /></label></div>
          <label className={`file-drop ${file ? "has-file" : ""}`}><input type="file" accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><FileSpreadsheet size={20} /><span>{file ? file.name : "选择文件或拖放到这里"}</span><small>{file ? formatBytes(file.size) : "外部内容将被作为不可信数据隔离处理"}</small></label>
          {upload.error && <ErrorBanner>{errorText(upload.error)}</ErrorBanner>}
          <button className="button primary" disabled={!file || upload.isPending}><Sparkles size={17} />{upload.isPending ? "正在上传" : "开始 AI 解析"}</button>
        </form>
        <div className="import-history"><SectionHeading title="导入任务" meta={`${jobs.data?.length ?? 0} 条`} />{!jobs.data?.length ? <EmptyState icon={<FileClock />} title="暂无导入任务" description="上传文件后，解析进度会显示在这里。" /> : jobs.data.map((job) => <div key={job.id} className={`job-row ${selectedJob === job.id ? "active" : ""}`}><button className="job-main" onClick={() => { setSelectedJob(job.id); setAccepted([]); }}><span className="job-file"><FileSpreadsheet size={17} /></span><span><strong>{job.fileName}</strong><small>{typeLabels[job.kind] ?? "商品资料"} · {formatDate(job.createdAt)}</small></span><StatusBadge status={job.status} /></button>{!job.appliedDocumentId && job.status !== "COMPLETED" && <button className="icon-button danger" title="删除错误导入" disabled={remove.isPending} onClick={() => window.confirm(`确定删除导入任务 ${job.fileName} 吗？`) && remove.mutate(job)}><Trash2 size={15} /></button>}</div>)}</div>
      </section>
      {selectedJob && <Modal title="导入结果确认" subtitle={detail.data?.fileName ?? "正在读取任务"} onClose={() => setSelectedJob(null)} wide>
        {detail.isLoading ? <PageLoading /> : detail.data?.status !== "REVIEW" ? <div className="job-progress"><RefreshCw className={detail.data?.status === "PROCESSING" ? "spin" : ""} /><strong>{statusLabels[detail.data?.status ?? ""] ?? detail.data?.status}</strong><progress value={detail.data?.progress ?? 0} max="100" /><p>{detail.data?.error}</p></div> : <><div className="review-toolbar"><label><input type="checkbox" checked={validRows.length > 0 && accepted.length === validRows.length} onChange={(event) => setAcceptedRows(event.target.checked ? validRows.map((row) => row.id) : [])} />选择全部有效行</label><span>{accepted.length} / {validRows.length} 行待确认</span></div><div className="review-table"><table><thead><tr><th>选择</th><th>行</th><th>SKU</th><th>款号 / 颜色 / 尺码</th><th>数量</th><th>置信度</th><th>校验</th></tr></thead><tbody>{detail.data.rows?.map((row) => <tr key={row.id} className={row.validationErrors.length ? "invalid" : ""}><td><input type="checkbox" disabled={row.validationErrors.length > 0} checked={accepted.includes(row.id)} onChange={(event) => setAcceptedRows((event.target.checked ? [...accepted, row.id] : accepted.filter((id) => id !== row.id)))} /></td><td>{row.rowNumber}</td><td className="mono">{String(row.normalized.skuCode ?? "-")}</td><td>{[row.normalized.styleNo, row.normalized.color, row.normalized.size].filter(Boolean).map(String).join(" / ") || "-"}</td><td>{String(row.normalized.quantity ?? row.normalized.countedPieces ?? "-")}</td><td><Confidence value={row.confidence} /></td><td>{row.validationErrors.length ? <span className="alert-label"><AlertTriangle size={13} />{row.validationErrors.join("；")}</span> : <span className="ok-label"><Check size={13} />通过</span>}</td></tr>)}</tbody></table></div><div className="modal-actions"><button className="button" onClick={() => setSelectedJob(null)}>稍后处理</button><button className="button primary" disabled={!accepted.length || confirm.isPending} onClick={() => confirm.mutate()}><Check size={16} />确认并生成草稿</button></div></>}
      </Modal>}
    </>
  );
}

function ReportsPage() {
  const queryClient = useQueryClient();
  const reportTemplates = [
    { label: "库存余额表", dataset: "inventory", prompt: "导出库存余额表，包含款号、品名、SKU、颜色、尺码、在库、预留、可用和预警值" },
    { label: "低库存预警表", dataset: "alerts", prompt: "导出低库存预警表，按可用库存从低到高排序" },
    { label: "商品 SKU 明细", dataset: "inventory", prompt: "导出商品 SKU 明细表，按款号、颜色和尺码分组" },
    { label: "日出库汇总", dataset: "documents", prompt: "导出今天的出库单据汇总，包含单号、客户、行数和时间" },
    { label: "审计日志", dataset: "audit", prompt: "导出关键操作审计日志，按时间倒序排列" },
  ];
  const [prompt, setPrompt] = useState("导出当前全部可用库存，按款号和颜色查看");
  const [dataset, setDataset] = useState("inventory");
  const [format, setFormat] = useState("xlsx");
  const jobs = useQuery({ queryKey: ["exports"], queryFn: () => api<ExportJob[]>("/exports"), refetchInterval: (query) => query.state.data?.some((job) => ["QUEUED", "PROCESSING"].includes(job.status)) ? 2000 : false });
  const create = useMutation({ mutationFn: () => api<{ job_id: string }>("/exports", { method: "POST", body: jsonBody({ prompt, dataset, format }) }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["exports"] }); emitToast("报表已进入生成队列"); } });
  return (
    <>
      <PageHeader eyebrow="受限报表引擎" title="AI 导出" description="用自然语言描述口径，系统只会查询允许的数据集与字段。" />
      <div className="report-template-strip">{reportTemplates.map((template) => <button className="button small" key={template.label} onClick={() => { setPrompt(template.prompt); setDataset(template.dataset); }}>{template.label}</button>)}</div>
      <section className="report-composer"><div className="report-prompt"><Sparkles size={20} /><textarea aria-label="报表需求" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} /><div className="prompt-actions"><label className="report-select">导出内容<select value={dataset} onChange={(event) => setDataset(event.target.value)}><option value="inventory">库存</option><option value="ledger">库存流水</option><option value="documents">单据</option><option value="alerts">库存预警</option><option value="audit">审计记录</option></select></label><Segmented value={format} options={[{ value: "xlsx", label: "Excel" }, { value: "csv", label: "CSV" }, { value: "pdf", label: "PDF" }]} onChange={setFormat} /><button className="button primary" onClick={() => create.mutate()} disabled={create.isPending || prompt.length < 2}><Download size={16} />生成报表</button></div></div><div className="report-guard"><ShieldCheck size={23} /><div><strong>查询边界已锁定</strong><p>AI 不能执行 SQL，也不能访问库存、流水、单据、预警和审计以外的数据。</p></div></div></section>
      {create.error && <ErrorBanner>{errorText(create.error)}</ErrorBanner>}
      <div className="section-block"><SectionHeading title="导出记录" meta="文件保留 7 天" /><DataTable loading={jobs.isLoading} empty={!(jobs.data?.length)} headers={["需求", "格式", "状态", "进度", "生成时间", "操作"]}>{jobs.data?.map((job) => <tr key={job.id}><td><strong>{job.prompt}</strong><small>{job.error}</small></td><td className="mono">{job.format.toUpperCase()}</td><td><StatusBadge status={job.status} /></td><td><progress value={job.progress} max="100" /></td><td>{formatDate(job.createdAt)}</td><td>{job.status === "COMPLETED" && <button className="button small" onClick={() => downloadExport(job.id)}><Download size={14} />下载</button>}</td></tr>)}</DataTable></div>
    </>
  );
}

function ApprovalsPage() {
  const queryClient = useQueryClient();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: () => api<Approval[]>("/approvals") });
  const decide = useMutation({ mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api(`/approvals/${id}/${approved ? "approve" : "reject"}`, { method: "POST", body: jsonBody({}) }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["approvals"] }); queryClient.invalidateQueries({ queryKey: ["documents"] }); queryClient.invalidateQueries({ queryKey: ["dashboard"] }); emitToast("审批决定已记录"); }, onError: (error) => emitToast(errorText(error), "error") });
  return (
    <><PageHeader eyebrow="双人复核" title="审批中心" description="盘点差异和库存调整必须由制单人之外的主管确认。" /><div className="approval-list">{approvals.isLoading ? <PageLoading /> : !approvals.data?.length ? <EmptyState icon={<ShieldCheck />} title="暂无审批记录" description="高风险单据提交后会出现在这里。" /> : approvals.data.map((approval) => <article className="approval-row" key={approval.id}><span className={`approval-symbol ${approval.status.toLowerCase()}`}><ShieldCheck size={20} /></span><div><span className="eyebrow">{typeLabels[approval.document.type]} · {approval.document.documentNo}</span><h3>{approval.document.reason || "库存差异复核"}</h3><p>{approval.document.lines.length} 行明细 · 制单人 {approval.document.createdBy.name} · {formatDate(approval.createdAt)}</p></div><StatusBadge status={approval.status} />{approval.status === "PENDING" && <div className="approval-actions"><button className="button small danger-text" onClick={() => decide.mutate({ id: approval.id, approved: false })}><X size={14} />驳回</button><button className="button small primary" onClick={() => decide.mutate({ id: approval.id, approved: true })}><Check size={14} />通过</button></div>}</article>)}</div></>
  );
}

function AuditPage() {
  const [keyword, setKeyword] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const events = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditEvent[]>("/audit") });
  const actions = [...new Set((events.data ?? []).map((event) => event.action))];
  const filtered = (events.data ?? []).filter((event) => (actionFilter === "all" || event.action === actionFilter) && `${auditLabel(event.action)} ${event.entityType} ${event.entityId} ${event.actor.name} ${event.actor.email}`.toLowerCase().includes(keyword.trim().toLowerCase()));
  return <><PageHeader eyebrow="不可变记录" title="审计日志" description="关键业务操作的人员、对象、时间与来源地址。" /><Toolbar><form className="search-box" onSubmit={(event) => event.preventDefault()}><Search size={17} /><input aria-label="搜索审计日志" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索操作、对象或成员" /></form><label className="report-select">操作类型<select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}><option value="all">全部操作</option>{actions.map((action) => <option key={action} value={action}>{auditLabel(action)}</option>)}</select></label></Toolbar><DataTable loading={events.isLoading} empty={!filtered.length} headers={["时间", "操作", "对象", "对象 ID", "操作人", "来源 IP"]}>{filtered.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td><span className="audit-action">{auditLabel(event.action)}</span></td><td>{event.entityType}</td><td className="mono truncate">{event.entityId}</td><td><strong>{event.actor.name}</strong><small>{event.actor.email}</small></td><td className="mono">{event.ip || "-"}</td></tr>)}</DataTable></>;
}

type MemberRow = User & { status: "ACTIVE" | "DISABLED"; createdAt: string };

function MembersPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selfOpen, setSelfOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const members = useQuery({ queryKey: ["members"], queryFn: () => api<MemberRow[]>("/members") });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/roles") });
  const isOwner = user.role.code === "OWNER";
  const refreshMembers = () => queryClient.invalidateQueries({ queryKey: ["members"] });
  const disable = useMutation({ mutationFn: (member: MemberRow) => api(`/members/${member.id}`, { method: "DELETE" }), onSuccess: () => { refreshMembers(); emitToast("成员账号已停用"); }, onError: (error) => emitToast(errorText(error), "error") });
  const restore = useMutation({ mutationFn: (member: MemberRow) => api(`/members/${member.id}/restore`, { method: "POST", body: jsonBody({}) }), onSuccess: () => { refreshMembers(); emitToast("成员账号已恢复"); }, onError: (error) => emitToast(errorText(error), "error") });
  return <><PageHeader eyebrow="最小权限" title="成员与角色" description="仓库所有者可维护成员账号和角色权限；每位成员也可修改自己的账号密码。" action={<div className="page-actions"><button className="button" onClick={() => setSelfOpen(true)}><Pencil size={17} />修改我的账号</button>{isOwner && <button className="button" onClick={() => setRolesOpen(true)}><ShieldCheck size={17} />编辑角色权限</button>}{isOwner && <button className="button primary" onClick={() => setOpen(true)}><UserPlus size={17} />添加成员</button>}</div>} /><DataTable loading={members.isLoading} empty={!(members.data?.length)} headers={["成员", "邮箱", "角色", "权限数", "状态", "加入时间", "操作"]}>{members.data?.map((member) => <tr key={member.id}><td><span className="member-cell"><span className="avatar">{member.name.slice(0, 1)}</span><strong>{member.name}</strong></span></td><td>{member.email}</td><td><StatusBadge status={member.role.code} label={member.role.name} /></td><td>{member.role.permissions.includes("*") ? "全部" : member.role.permissions.length}</td><td>{member.status === "ACTIVE" ? <span className="ok-label"><Check size={13} />启用</span> : <span className="muted">已停用</span>}</td><td>{formatDate(member.createdAt)}</td><td><div className="row-actions">{isOwner && <button className="icon-button" title="修改成员账号" onClick={() => setEditing(member)}><Pencil size={15} /></button>}{isOwner && member.id !== user.id && member.status === "ACTIVE" && <button className="icon-button danger" title="删除成员账号" disabled={disable.isPending} onClick={() => window.confirm(`确定停用成员 ${member.name} 的账号吗？`) && disable.mutate(member)}><Trash2 size={15} /></button>}{isOwner && member.status === "DISABLED" && <button className="button small" disabled={restore.isPending} onClick={() => restore.mutate(member)}><RotateCcw size={14} />恢复</button>}</div></td></tr>)}</DataTable>{open && <CreateMemberModal roles={roles.data ?? []} onClose={() => setOpen(false)} onCreated={refreshMembers} />}{editing && <EditMemberModal member={editing} roles={roles.data ?? []} onClose={() => setEditing(null)} onSaved={refreshMembers} />}{selfOpen && <SelfAccountModal user={user} onClose={() => setSelfOpen(false)} />}{rolesOpen && <RolePermissionsModal roles={roles.data ?? []} onClose={() => setRolesOpen(false)} onSaved={() => queryClient.invalidateQueries({ queryKey: ["roles"] })} />}</>;
}

function CreateMemberModal({ roles, onClose, onCreated }: { roles: Role[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [roleId, setRoleId] = useState(roles.find((role) => role.code === "OPERATOR")?.id ?? roles[0]?.id ?? "");
  const create = useMutation({ mutationFn: () => api("/members", { method: "POST", body: jsonBody({ name, email, password, roleId }) }), onSuccess: () => { onCreated(); emitToast("成员账号已创建"); onClose(); } });
  return <Modal title="添加仓库成员" subtitle="初始密码仅在当前表单中输入，不会被系统明文保存" onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}><label>姓名<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>邮箱<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>初始密码<input required minLength={10} type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><label>角色<select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>{create.error && <ErrorBanner>{errorText(create.error)}</ErrorBanner>}<ModalActions onClose={onClose} pending={create.isPending} submitLabel="创建账号" /></form></Modal>;
}

function EditMemberModal({ member, roles, onClose, onSaved }: { member: MemberRow; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(member.name); const [email, setEmail] = useState(member.email); const [password, setPassword] = useState(""); const [roleId, setRoleId] = useState(member.role.id);
  const update = useMutation({ mutationFn: () => api(`/members/${member.id}`, { method: "PUT", body: jsonBody({ name, email, password, roleId }) }), onSuccess: () => { onSaved(); emitToast("成员账号已更新"); onClose(); } });
  return <Modal title={`修改成员 · ${member.name}`} subtitle="密码留空则不变；修改密码后该成员需要重新登录" onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}><label>姓名<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>邮箱<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>新密码<input minLength={10} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空不修改" /></label><label>角色<select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>{update.error && <ErrorBanner>{errorText(update.error)}</ErrorBanner>}<ModalActions onClose={onClose} pending={update.isPending} submitLabel="保存成员" /></form></Modal>;
}

function SelfAccountModal({ user, onClose }: { user: User; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(user.name); const [email, setEmail] = useState(user.email); const [password, setPassword] = useState("");
  const update = useMutation({ mutationFn: () => api("/auth/me", { method: "PUT", body: jsonBody({ name, email, password }) }), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["me"] }); queryClient.invalidateQueries({ queryKey: ["members"] }); emitToast("我的账号已更新"); onClose(); } });
  return <Modal title="修改我的账号" subtitle="密码留空则不变；新密码至少 10 位" onClose={onClose}><form className="form-grid" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}><label>姓名<input required value={name} onChange={(event) => setName(event.target.value)} /></label><label>邮箱<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>新密码<input minLength={10} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空不修改" /></label>{update.error && <ErrorBanner>{errorText(update.error)}</ErrorBanner>}<ModalActions onClose={onClose} pending={update.isPending} submitLabel="保存我的账号" /></form></Modal>;
}

function RolePermissionsModal({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const editableRoles = roles.filter((role) => role.code !== "OWNER");
  const [roleId, setRoleId] = useState(editableRoles[0]?.id ?? "");
  const role = editableRoles.find((item) => item.id === roleId);
  const [name, setName] = useState(role?.name ?? "");
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  useEffect(() => { setName(role?.name ?? ""); setPermissions(role?.permissions ?? []); }, [role?.id]);
  const update = useMutation({ mutationFn: () => api(`/roles/${roleId}`, { method: "PUT", body: jsonBody({ name, permissions }) }), onSuccess: () => { onSaved(); emitToast("角色权限已更新"); onClose(); } });
  const toggle = (permission: string) => setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]);
  return <Modal title="编辑角色权限" subtitle="所有者角色不可修改；危险权限请谨慎勾选" onClose={onClose} wide>{!editableRoles.length ? <EmptyState icon={<ShieldCheck />} title="没有可编辑角色" description="所有者角色受系统保护。" /> : <form className="role-permission-form" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}><label>选择角色<select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{editableRoles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>角色名称<input required value={name} onChange={(event) => setName(event.target.value)} /></label><div className="permission-grid">{permissionOptions.map(([permission, label]) => <label key={permission} className="permission-card"><input type="checkbox" checked={permissions.includes(permission)} onChange={() => toggle(permission)} /><span>{label}</span><small>{permission}</small></label>)}</div>{update.error && <ErrorBanner>{errorText(update.error)}</ErrorBanner>}<ModalActions onClose={onClose} pending={update.isPending} submitLabel="保存角色" /></form>}</Modal>;
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["warehouse-automation"], queryFn: () => api<AutomationSettings>("/settings/warehouse-automation") });
  const aiSettings = useQuery({ queryKey: ["ai-model-settings"], queryFn: () => api<AiModelSettings>("/settings/ai-model") });
  const [time, setTime] = useState("20:00");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiEnabled, setAiEnabled] = useState(true);
  const [suppliers, setSuppliers] = useState(() => window.localStorage.getItem("cangku:suppliers") ?? "");
  useEffect(() => setTime(settings.data?.pendingTime ?? settings.data?.currentTime ?? "20:00"), [settings.data?.currentTime, settings.data?.pendingTime]);
  useEffect(() => { if (!aiSettings.data) return; setAiBaseUrl(aiSettings.data.baseUrl); setAiModel(aiSettings.data.model); setAiEnabled(aiSettings.data.enabled); }, [aiSettings.data]);
  const save = useMutation({
    mutationFn: () => api<AutomationSettings>("/settings/warehouse-automation", { method: "PUT", body: jsonBody({ autoOutboundTime: time }) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["warehouse-automation"] }); emitToast("自动出库时间已保存，将从次日生效"); },
  });
  const saveAi = useMutation({
    mutationFn: () => api<AiModelSettings>("/settings/ai-model", { method: "PUT", body: jsonBody({ baseUrl: aiBaseUrl, model: aiModel, apiKey: aiApiKey, enabled: aiEnabled }) }),
    onSuccess: () => { setAiApiKey(""); queryClient.invalidateQueries({ queryKey: ["ai-model-settings"] }); emitToast("AI 模型配置已安全保存"); },
  });
  const testAi = useMutation({
    mutationFn: () => api<{ ok: boolean; latencyMs: number; model: string }>("/settings/ai-model/test", { method: "POST", body: jsonBody({}) }),
    onSuccess: (result) => emitToast(`模型连接成功 · ${result.model} · ${result.latencyMs}ms`),
  });
  const saveSuppliers = () => { window.localStorage.setItem("cangku:suppliers", suppliers); emitToast("供应商配置已保存"); };
  return <>
    <PageHeader eyebrow="仓库自动化" title="系统设置" description="自动出库时间由管理员维护，修改从次日开始生效。" />
    <section className="automation-setting-band">
      <div className="automation-time-display"><Clock3 size={24} /><span>当前每日结算</span><strong>{settings.data?.currentTime ?? "--:--"}</strong><small>{settings.data?.timezone ?? "Asia/Shanghai"}</small></div>
      <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <label>新的自动出库时间<input aria-label="新的自动出库时间" type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <button className="button primary" disabled={settings.isLoading || save.isPending}>保存时间</button>
      </form>
      <div className="automation-effective"><span>生效规则</span><strong>{settings.data?.pendingTime ? `${settings.data.effectiveFrom} 起改为 ${settings.data.pendingTime}` : "修改后次日生效"}</strong><small>今天已经建立的登记批次不会临时改变时间。</small></div>
    </section>
    {(settings.error || save.error) && <ErrorBanner>{errorText(settings.error ?? save.error)}</ErrorBanner>}
    <section className="ai-model-settings">
      <div className="ai-model-settings-head"><div><Sparkles size={22} /><span><h2>AI 模型配置</h2><p>用于表格字段映射、图片和 PDF 货单识别。密钥由后端加密保存，前端不会读取明文。</p></span></div><StatusBadge status={aiSettings.data?.enabled && aiSettings.data?.hasApiKey ? "ACTIVE" : "DISABLED"} label={aiSettings.data?.enabled && aiSettings.data?.hasApiKey ? "已配置" : "未配置"} /></div>
      <form className="ai-model-form" onSubmit={(event) => { event.preventDefault(); saveAi.mutate(); }}>
        <label>API 地址<input type="url" required value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" /></label>
        <label>模型名称<input required value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="gpt-4o-mini" /></label>
        <label>API 密钥<input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder={aiSettings.data?.hasApiKey ? `${aiSettings.data.apiKeyMasked}（留空保持不变）` : "首次配置必须填写"} autoComplete="new-password" /></label>
        <label className="check-toggle"><input type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} />启用 AI 模型</label>
        <div className="ai-model-actions"><button className="button" type="button" disabled={!aiSettings.data?.hasApiKey || testAi.isPending} onClick={() => testAi.mutate()}>{testAi.isPending ? "正在测试" : "测试连接"}</button><button className="button primary" disabled={saveAi.isPending}>{saveAi.isPending ? "正在保存" : "保存模型配置"}</button></div>
      </form>
      {(aiSettings.error || saveAi.error || testAi.error) && <ErrorBanner>{errorText(aiSettings.error ?? saveAi.error ?? testAi.error)}</ErrorBanner>}
    </section>
    <div className="settings-bands"><section><div><h2>仓库范围</h2><p>当前启用一个主仓，库存记录已保留仓库标识，未开放跨仓调拨。</p></div><StatusBadge status="ACTIVE" label="主仓启用" /></section><section className="supplier-config"><div><h2>供应商配置</h2><p>每行一个供应商名称，新建表单和导入备注可按这里统一填写。</p></div><textarea aria-label="供应商列表" value={suppliers} onChange={(event) => setSuppliers(event.target.value)} placeholder="例如：\n广州一号供应商\n杭州针织厂" rows={4} /><button className="button" onClick={saveSuppliers}>保存供应商</button></section><section><div><h2>移动端能力</h2><p>支持响应式操作与 OCR 拍照上传；首版不提供条码、标签打印和离线写入。</p></div><span className="config-chip">PWA 已启用</span></section><section><div><h2>文件保留</h2><p>导入源文件默认保留 30 天，导出文件默认保留 7 天。</p></div><span className="config-chip">自动清理策略</span></section></div>
  </>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-actions">{action}</div>}</header>;
}

function SectionHeading({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</div>;
}

function Metric({ label, value, unit, tone = "neutral", onClick }: { label: string; value: string; unit: string; tone?: string; onClick?: () => void }) {
  const content = <><span>{label}</span><div><strong>{value}</strong><small>{unit}</small></div></>;
  return onClick ? <button type="button" className={`metric metric-button ${tone}`} onClick={onClick}>{content}</button> : <article className={`metric ${tone}`}>{content}</article>;
}

function Toolbar({ children }: { children: ReactNode }) { return <div className="toolbar">{children}</div>; }

function Segmented({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <div className="segmented">{options.map((option) => <button type="button" className={value === option.value ? "active" : ""} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function DataTable({ headers, children, loading, empty, emptyState }: { headers: string[]; children?: ReactNode; loading?: boolean; empty?: boolean; emptyState?: ReactNode }) {
  if (loading) return <PageLoading />;
  if (empty) return emptyState ?? <EmptyState icon={<ClipboardList />} title="暂无数据" description="完成第一笔业务后，记录会显示在这里。" />;
  return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`status-badge ${status.toLowerCase()}`}>{label ?? statusLabels[status] ?? status}</span>;
}

function Confidence({ value }: { value: number }) {
  const tone = value >= 0.9 ? "high" : value >= 0.7 ? "medium" : "low";
  return <span className={`confidence ${tone}`}><i style={{ width: `${Math.round(value * 100)}%` }} />{Math.round(value * 100)}%</span>;
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span>{icon}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

function ErrorBanner({ children }: { children: ReactNode }) { return <div className="error-banner"><AlertTriangle size={16} />{children}</div>; }

function PageLoading() { return <div className="page-loading"><span /><span /><span /></div>; }

function FatalState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="fatal-state"><AlertTriangle size={28} /><h2>无法读取数据</h2><p>{message}</p><button className="button" onClick={onRetry}><RefreshCw size={16} />重试</button></div>; }

function Modal({ title, subtitle, onClose, wide, children }: { title: string; subtitle?: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><p className="eyebrow">仓库操作</p><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={19} /></button></header><div className="modal-body">{children}</div></section></div>;
}

function ModalActions({ onClose, pending, submitLabel }: { onClose: () => void; pending: boolean; submitLabel: string }) { return <div className="modal-actions span-2"><button type="button" className="button" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={pending}>{pending ? "正在保存" : submitLabel}</button></div>; }

function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: string } | null>(null);
  useEffect(() => {
    const handler = (event: Event) => { const detail = (event as CustomEvent).detail; setToast(detail); window.setTimeout(() => setToast(null), 3200); };
    window.addEventListener("cangku:toast", handler);
    return () => window.removeEventListener("cangku:toast", handler);
  }, []);
  return <>{children}{toast && <div className={`toast ${toast.tone}`}><span>{toast.tone === "success" ? <Check size={16} /> : <AlertTriangle size={16} />}</span>{toast.message}</div>}</>;
}

function documentDescription(type: string) {
  return { INBOUND: "供应商来货确认后增加库存。", OUTBOUND: "订单先预留可用库存，发货过账后正式扣减。", RETURN: "退回商品经质检后进入指定库存状态。", STOCKTAKE: "按库存快照记录实盘数，差异需另一名主管审批。", ADJUSTMENT: "报损、报溢和纠错必须填写原因并经过审批。" }[type] ?? "库存业务单据";
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function auditLabel(action: string) { return ({ "style.created": "创建款式", "style.updated": "更新商品", "document.created": "创建单据", "document.confirmed": "确认单据", "document.reserved": "预留库存", "document.posted": "单据过账", "document.reversed": "冲销单据", "daily_outbound.auto_posted": "每日自动出库", "daily_outbound.supplement_posted": "补充出库", "simple_import.inbound_posted": "模板入库", "simple_import.outbound_confirmed": "导入出库登记", "automation.outbound_time.updated": "修改自动出库时间", "approval.approved": "审批通过", "approval.rejected": "审批驳回", "member.created": "创建成员", "member.updated": "修改成员", "member.disabled": "停用成员", "member.restored": "恢复成员", "member.self_updated": "修改自己的账号", "role.updated": "修改角色", "style.deleted": "删除商品", "style.archived": "停用商品" } as Record<string, string>)[action] ?? action; }
function ledgerSource(document: { documentNo: string; type: string; reason?: string | null; sourceRef?: string | null }) {
  if (document.documentNo.startsWith("CX-")) return "批次回退";
  if (document.reason === "每日登记自动结算") return "每日自动出库";
  if (document.reason === "结算时间后补充出库") return "补充出库";
  if (document.reason === "固定模板确认入库") return "模板入库";
  return document.sourceRef || typeLabels[document.type] || document.type;
}
