import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface CataloguePermissionView {
  key: string;
  label: string;
  introducedVersion: number;
}
export interface CatalogueCategoryView {
  category: string;
  permissions: CataloguePermissionView[];
}

/**
 * PermissionRegistryService (feature 011, T023 / US2). Reads the versioned permission catalogue
 * and groups it by category for the Access-Management UI (0034). Account-scoped (Principle I).
 * A newly added permission simply appears here; it is OFF for every role until granted (R-2).
 */
@Injectable()
export class PermissionRegistryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listCatalogue(accountId: string): Promise<CatalogueCategoryView[]> {
    const perms = await this.prisma.forAccount(accountId).permission.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    const byCategory = new Map<string, CataloguePermissionView[]>();
    for (const p of perms) {
      const list = byCategory.get(p.category) ?? [];
      list.push({ key: p.key, label: p.label ?? '', introducedVersion: p.introduced_version });
      byCategory.set(p.category, list);
    }
    return [...byCategory.entries()].map(([category, permissions]) => ({ category, permissions }));
  }
}
