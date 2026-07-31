import { hash } from "argon2";
import { PrismaClient, StockStatus } from "@prisma/client";

const prisma = new PrismaClient();

const roleDefinitions = [
  { code: "OWNER", name: "所有者", permissions: ["*"] },
  {
    code: "ADMIN",
    name: "管理员",
    permissions: ["dashboard.view", "catalog.manage", "inventory.view", "documents.manage", "imports.manage", "reports.export", "approvals.manage", "audit.view", "members.manage", "settings.manage", "warehouses.manage", "inventory.restore"],
  },
  {
    code: "MANAGER",
    name: "仓库主管",
    permissions: ["dashboard.view", "catalog.manage", "inventory.view", "documents.manage", "inventory.adjust", "inventory.restore", "imports.manage", "reports.export", "approvals.manage", "audit.view"],
  },
  {
    code: "OPERATOR",
    name: "操作员",
    permissions: ["dashboard.view", "catalog.view", "inventory.view", "documents.manage", "imports.manage"],
  },
  {
    code: "AUDITOR",
    name: "审计员",
    permissions: ["dashboard.view", "catalog.view", "inventory.view", "reports.export", "approvals.view", "audit.view"],
  },
] as const;

async function main() {
  const organization =
    (await prisma.organization.findFirst({ where: { name: "云裳服装仓" } })) ??
    (await prisma.organization.create({ data: { name: "云裳服装仓" } }));

  const warehouse = await prisma.warehouse.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: "MAIN" } },
    update: {},
    create: { organizationId: organization.id, code: "MAIN", name: "主仓" },
  });

  const roles = new Map<string, string>();
  for (const role of roleDefinitions) {
    const saved = await prisma.role.upsert({
      where: { organizationId_code: { organizationId: organization.id, code: role.code } },
      update: { name: role.name, permissions: [...role.permissions], system: true },
      create: { organizationId: organization.id, code: role.code, name: role.name, permissions: [...role.permissions], system: true },
    });
    roles.set(role.code, saved.id);
  }

  const email = process.env.BOOTSTRAP_OWNER_EMAIL;
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) throw new Error("BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD are required");
  if (password.length < 12) throw new Error("BOOTSTRAP_OWNER_PASSWORD must contain at least 12 characters");
  const owner = await prisma.user.upsert({
    where: { email },
    update: { roleId: roles.get("OWNER")!, status: "ACTIVE" },
    create: {
      organizationId: organization.id,
      roleId: roles.get("OWNER")!,
      email,
      name: "仓库所有者",
      passwordHash: await hash(password, { type: 2 }),
    },
  });

  if (process.env.SEED_DEMO_DATA !== "false") {
    const style = await prisma.productStyle.upsert({
      where: { organizationId_styleNo: { organizationId: organization.id, styleNo: "CY-2407" } },
      update: {},
      create: {
        organizationId: organization.id,
        styleNo: "CY-2407",
        name: "轻量通勤衬衫",
        brand: "云裳",
        category: "衬衫",
        season: "秋季",
        year: 2026,
        imageUrls: [],
      },
    });

    const skuRows = [];
    for (const color of ["曜石黑", "雾霾蓝"]) {
      for (const size of ["S", "M", "L", "XL"]) {
        const skuCode = `CY2407-${color === "曜石黑" ? "BK" : "BL"}-${size}`;
        skuRows.push(
          await prisma.sku.upsert({
            where: { skuCode },
            update: {},
            create: { styleId: style.id, skuCode, color, size, minStock: 20 },
          }),
        );
      }
    }

    const existing = await prisma.stockDocument.findUnique({ where: { documentNo: "SEED-IN-0001" } });
    if (!existing) {
      await prisma.$transaction(async (tx) => {
        const document = await tx.stockDocument.create({
          data: {
            organizationId: organization.id,
            warehouseId: warehouse.id,
            documentNo: "SEED-IN-0001",
            type: "INBOUND",
            status: "POSTED",
            sourceRef: "演示期初库存",
            createdById: owner.id,
            postedById: owner.id,
            postedAt: new Date(),
          },
        });
        for (const [index, sku] of skuRows.entries()) {
          const quantity = 48 + index * 7;
          const line = await tx.stockDocumentLine.create({
            data: { documentId: document.id, skuId: sku.id, stockStatus: StockStatus.SELLABLE, quantityPieces: quantity, loosePieces: quantity },
          });
          const balance = await tx.stockBalance.upsert({
            where: { warehouseId_skuId_status: { warehouseId: warehouse.id, skuId: sku.id, status: StockStatus.SELLABLE } },
            update: { onHand: quantity },
            create: { warehouseId: warehouse.id, skuId: sku.id, status: StockStatus.SELLABLE, onHand: quantity },
          });
          await tx.inventoryLedgerEntry.create({
            data: {
              organizationId: organization.id,
              warehouseId: warehouse.id,
              skuId: sku.id,
              documentId: document.id,
              documentLineId: line.id,
              stockStatus: StockStatus.SELLABLE,
              quantityDelta: quantity,
              balanceAfter: balance.onHand,
              reservedAfter: balance.reserved,
              actorId: owner.id,
            },
          });
        }
      });
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
