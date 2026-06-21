-- デフォルトモデルを umans-glm-5.2 に変更。
-- schema.ts / 0004_snapshot.json / 0005_snapshot.json は既に umans-glm-5.2 を
-- 記録しているが、対応する ALTER を欠いていたため DB は gpt-4o-mini のままだった。
-- 本マイグレーションで DB を snapshot に揃える。
ALTER TABLE "threads" ALTER COLUMN "model" SET DEFAULT 'umans-glm-5.2';
