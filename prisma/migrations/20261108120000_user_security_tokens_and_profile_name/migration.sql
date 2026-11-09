-- CreateEnum
CREATE TYPE "UserSecurityTokenType" AS ENUM ('ACTIVATION', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "name" TEXT;

-- CreateTable
CREATE TABLE "user_security_tokens" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "type" "UserSecurityTokenType" NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_security_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_security_tokens_token_hash_key" ON "user_security_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "user_security_tokens_user_id_type_expires_at_idx" ON "user_security_tokens"("user_id", "type", "expires_at");

-- CreateIndex
CREATE INDEX "user_security_tokens_token_hash_idx" ON "user_security_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "user_security_tokens" ADD CONSTRAINT "user_security_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_security_tokens" ADD CONSTRAINT "user_security_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

