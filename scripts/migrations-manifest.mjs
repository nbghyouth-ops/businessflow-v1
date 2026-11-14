export const CANONICAL_MIGRATIONS = [
  {
    id: "0000_baseline",
    legacyId: "drizzle/migrations/0000_baseline.sql",
    path: "drizzle/migrations/0000_baseline.sql",
  },
  {
    id: "001_integrity",
    legacyId: "scripts/sql/001_integrity.sql",
    path: "scripts/sql/001_integrity.sql",
  },
  {
    id: "002_rls_and_tenant_fk",
    legacyId: "scripts/sql/002_rls_and_tenant_fk.sql",
    path: "scripts/sql/002_rls_and_tenant_fk.sql",
  },
  {
    id: "003_features_and_exports",
    legacyId: "scripts/sql/003_features_and_exports.sql",
    path: "scripts/sql/003_features_and_exports.sql",
  },
  {
    id: "004_prd_157_modules",
    legacyId: "scripts/sql/004_prd_157_modules.sql",
    path: "scripts/sql/004_prd_157_modules.sql",
  },
  {
    id: "005_remediation_hardening",
    legacyId: "scripts/sql/005_remediation_hardening.sql",
    path: "scripts/sql/005_remediation_hardening.sql",
  },
];
