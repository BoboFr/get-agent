import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ContentPart, ImagePart, FilePart, TextPart, Message } from "./types.js";

/** Maps common file extensions to MIME types for data-URL construction. */
const MIME_TYPES: Record<string, string> = {
  // images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  // documents
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function toBase64(data: Buffer | Uint8Array | ArrayBuffer): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return Buffer.from(data).toString("base64");
}

/** Converts a local file to a base64 encoded string. */
export async function fileToBase64(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return toBase64(data);
}


/** Builds a `data:<mime>;base64,<...>` URL from a MIME type and base64 payload. */
export function toDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** Wraps a string into a text content part. */
export function text(value: string): TextPart {
  return { type: "text", text: value };
}

/** Image part from a remote (or already data-encoded) URL. */
export function imageFromUrl(
  url: string,
  detail: "auto" | "low" | "high" = "auto"
): ImagePart {
  return { type: "image_url", image_url: { url, detail } };
}

/** Image part from a raw base64 string. */
export function imageFromBase64(
  base64: string,
  mimeType = "image/png",
  detail: "auto" | "low" | "high" = "auto"
): ImagePart {
  return imageFromUrl(toDataUrl(mimeType, base64), detail);
}

/** Image part from an in-memory buffer. */
export function imageFromBuffer(
  data: Buffer | Uint8Array | ArrayBuffer,
  mimeType = "image/png",
  detail: "auto" | "low" | "high" = "auto"
): ImagePart {
  return imageFromBase64(toBase64(data), mimeType, detail);
}

/** Image part read from a local file. MIME type is inferred from the extension. */
export async function imageFromFile(
  filePath: string,
  detail: "auto" | "low" | "high" = "auto"
): Promise<ImagePart> {
  const data = await readFile(filePath);
  return imageFromBase64(data.toString("base64"), mimeFromExtension(filePath), detail);
}

/** Document/file part from a raw base64 string. */
export function fileFromBase64(
  base64: string,
  filename: string,
  mimeType = "application/octet-stream"
): FilePart {
  return { type: "file", file: { filename, file_data: toDataUrl(mimeType, base64) } };
}

/** Document/file part from an in-memory buffer. */
export function fileFromBuffer(
  data: Buffer | Uint8Array | ArrayBuffer,
  filename: string,
  mimeType = "application/octet-stream"
): FilePart {
  return fileFromBase64(toBase64(data), filename, mimeType);
}

/** Document/file part read from a local file. MIME type is inferred from the extension. */
export async function fileFromPath(filePath: string, filename?: string): Promise<FilePart> {
  const data = await readFile(filePath);
  return fileFromBase64(data.toString("base64"), filename ?? basename(filePath), mimeFromExtension(filePath));
}

/** Document/file part referencing a previously uploaded file by id. */
export function fileFromId(fileId: string): FilePart {
  return { type: "file", file: { file_id: fileId } };
}

/**
 * Builds a multimodal user message from text and/or content parts.
 * Plain strings are converted to text parts.
 *
 * @example
 * userMessage("Describe this image:", await imageFromFile("./photo.png"))
 */
export function userMessage(...parts: Array<string | ContentPart>): Message {
  return {
    role: "user",
    content: parts.map((p) => (typeof p === "string" ? text(p) : p)),
  };
}
