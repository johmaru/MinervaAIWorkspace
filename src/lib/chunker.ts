/**
 * Text chunker for knowledge base documents.
 *
 * Splits text into ~512-char chunks with ~64-char overlap.
 * Character-based (no tokenizer dependency) — sufficient for Japanese where
 * char count ≈ token count in practice.
 *
 * Split priority: paragraph boundaries > sentence boundaries > hard char cut.
 * This preserves semantic structure better than naive fixed-width slicing.
 */

const CHUNK_SIZE = 512;
const OVERLAP = 64;
const MIN_CHUNK_SIZE = 50; // Don't create tiny trailing chunks — merge into previous

/**
 * Splits text into overlapping chunks.
 *
 * Strategy:
 * 1. Split by double-newline (paragraph boundaries) first.
 * 2. Accumulate paragraphs into chunks up to CHUNK_SIZE.
 * 3. If a single paragraph exceeds CHUNK_SIZE, hard-split it at sentence/char level.
 * 4. Add OVERLAP from the end of the previous chunk.
 *
 * @returns array of { text, ordinal } objects, ordinal 0-based.
 */
export function chunkText(
  text: string,
  options?: { chunkSize?: number; overlap?: number },
): { text: string; ordinal: number }[] {
  const chunkSize = options?.chunkSize ?? CHUNK_SIZE;
  const overlap = options?.overlap ?? OVERLAP;

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  // If the whole text fits in one chunk, return it as-is.
  if (normalized.length <= chunkSize) {
    return [{ text: normalized, ordinal: 0 }];
  }

  // Split into paragraphs (double-newline boundaries).
  const paragraphs = normalized.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    // If paragraph itself exceeds chunkSize, hard-split it.
    if (para.length > chunkSize) {
      // Flush current buffer first
      if (current.trim().length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      // Split long paragraph by sentences, then by char
      const sentences = splitSentences(para);
      let sentBuf = "";
      for (const sent of sentences) {
        if (sent.length > chunkSize) {
          // Sentence too long — hard split by char
          if (sentBuf.trim().length > 0) {
            chunks.push(sentBuf.trim());
            sentBuf = "";
          }
          for (let i = 0; i < sent.length; i += chunkSize - overlap) {
            const piece = sent.slice(i, i + chunkSize);
            chunks.push(piece.trim());
          }
        } else if (sentBuf.length + sent.length + 1 > chunkSize) {
          // Buffer full — flush
          chunks.push(sentBuf.trim());
          sentBuf = sent;
        } else {
          sentBuf = sentBuf.length === 0 ? sent : sentBuf + "\n" + sent;
        }
      }
      if (sentBuf.trim().length > 0) {
        current = sentBuf;
      }
      continue;
    }

    // Normal paragraph: try to fit in current chunk
    const candidate = current.length === 0 ? para : current + "\n\n" + para;
    if (candidate.length > chunkSize) {
      // Flush current, start new chunk with overlap from end of current
      chunks.push(current.trim());
      const overlapText = current.slice(-overlap);
      current = overlapText + "\n\n" + para;
    } else {
      current = candidate;
    }
  }

  // Flush remaining
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  // Merge tiny trailing chunk into previous
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < MIN_CHUNK_SIZE) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] += "\n\n" + last;
  }

  return chunks.map((text, ordinal) => ({ text, ordinal }));
}

/**
 * Splits text into sentences. Handles Japanese (。！？) and English (.!?) terminators.
 */
function splitSentences(text: string): string[] {
  // Match sentence-ending punctuation followed by whitespace or end of string.
  // Japanese: 。！？ (optionally followed by 」for dialogue)
  // English: . ! ? followed by space/newline
  const sentences = text.match(
    /[^。！？.!?]*[。！？.!?]+[\s」』）)]*|[^。！？.!?]+$/g,
  );
  if (!sentences) return [text];
  return sentences.map((s) => s.trim()).filter((s) => s.length > 0);
}
