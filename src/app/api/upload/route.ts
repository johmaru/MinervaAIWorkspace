import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments, threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { extractFileText } from "@/lib/fileExtract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * POST /api/upload — File upload (multipart/form-data).
 *
 * formData:
 * - threadId: string
 * - file: File (image/PDF/text)
 *
 * Processing:
 * - Image (image/*): saved as base64 dataURL. Can be passed inline to vision models.
 * - PDF (application/pdf): text extracted via pdf-parse.
 * - Text (text/*): read as UTF-8.
 *
 * Response: { id, filename, mimeType, dataUrl?, extractedText? }
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response("Invalid form data", { status: 400 });
  }

  const threadId = formData.get("threadId") as string | null;
  const file = formData.get("file") as File | null;

  if (!threadId) return new Response("threadId is required", { status: 400 });
  const [thread] = await db.select({ id: threads.id, userId: threads.userId }).from(threads).where(eq(threads.id, threadId));
  if (!thread || thread.userId !== user.id) return new Response("Not found", { status: 404 });
  if (!file) return new Response("file is required", { status: 400 });
  if (file.size > MAX_FILE_SIZE) return new Response("File too large (max 10MB)", { status: 413 });

  const mimeType = file.type || "application/octet-stream";
  // Sanitize filename: strip path components, remove control chars
  const filename = file.name.replace(/[^a-zA-Z0-9._\-\s\u3040-\u9fff\uff00-\uffef]/g, "").slice(0, 255) || "unnamed";

  let dataUrl: string | null = null;
  let extractedText: string | null = null;

  if (mimeType.startsWith("image/")) {
    // Image: convert to base64 dataURL
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64 = buffer.toString("base64");
    dataUrl = `data:${mimeType};base64,${base64}`;
  } else {
    // PDF or text-based file: extract via shared utility
    try {
      const extracted = await extractFileText(file);
      extractedText = extracted.text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "File text extraction failed";
      const status = msg.startsWith("Unsupported file type") ? 415 : 422;
      return new Response(msg, { status });
    }
  }

  // Save to DB (messageId is linked at send time)
  const [attachment] = await db
    .insert(attachments)
    .values({
      threadId,
      filename,
      mimeType,
      dataUrl,
      extractedText,
    })
    .returning();

  return Response.json({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    hasImage: !!dataUrl,
    hasText: !!extractedText,
    extractedTextPreview: extractedText?.slice(0, 200) ?? null,
  });
}
