-- Feature 020 (roadmap 5.2 / ADR 0038 §4) — a brand's visual identity.
--
-- A brand is IDENTIFICATION, not a permission: one support department watches every brand in one
-- queue, so what a brand needs is a badge an agent recognises, not an access rule.
--
-- Values are DATA and never hardcoded (Principle VI). This is also not the install's own theming —
-- that is the token layer (ADR 0028). ADR 0038 §4 separates the two things both once called "brand".
ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "icon" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "accent" TEXT NOT NULL DEFAULT '';
